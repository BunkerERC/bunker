// BunkerSwap + the relayer on a mainnet fork, with the site's own signer and route builder (no browser).
//   node launch/test/swap-e2e.mjs
// Uses the LIVE BunkerVault, the real Universal Router and real pools ($BUNKER v4, USDC on v2/v3/v4). Deploys
// BunkerSwap with launch/swap.mjs, runs launch/swap.mjs relayer against the fork, then: swap paid by a wallet,
// gasless swap, gasless withdrawal, everything the relayer must refuse, and an order that expires.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, formatUnits, getAddress, zeroAddress, toHex, parseAbi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as wots from '../../site/src/lib/wots.js';
import * as bs from '../../site/src/lib/bunkerswap.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPSTREAM = process.env.FORK_UPSTREAM ?? 'https://ethereum-rpc.publicnode.com';
const PORT = 8651, RELAY_PORT = 8652, FORK = `http://127.0.0.1:${PORT}`, RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const VAULT = '0x39C71b635409b1f98dc632e08d3B29515ddb2727';
const BUNKER = '0xBDC4cE7c4718d20498e7D549751FF336690eb6D7';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const PEPE = '0x6982508145454Ce325dDbE47a25d4ec3d2311933'; // a real token the relayer does not list
const FEE_BPS = 50n;
const ETH = zeroAddress;

const V = parseAbi([
  'struct Transfer { address token; address to; uint256 amount; }',
  'function accounts(bytes32 id) view returns (bytes32 key, uint64 nonce)',
  'function balanceOf(bytes32 id, address token) view returns (uint256)',
  'function digest(bytes32 id, Transfer[] transfers, address relayer, uint256 fee, bytes32 nextKey) view returns (bytes32)',
  'function depositETH(bytes32 id) payable',
  'function execute(bytes32 id, Transfer[] transfers, address relayer, uint256 fee, bytes32 nextKey, bytes32[67] sig)',
]);
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

const results = [];
const check = (ok, what, detail = '') => { results.push(ok); console.log(`[${ok ? ' OK ' : 'FAIL'}] ${what}${detail ? '  ' + detail : ''}`); if (!ok) throw Error(what); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
const startProc = (cmd, args, opts) => { const p = spawn(cmd, args, { stdio: 'ignore', ...opts }); procs.push(p); return p; };
const stop = () => { for (const p of procs) { try { p.kill(); } catch {} } };
const keysDir = mkdtempSync(join(tmpdir(), 'bunker-swap-e2e-'));

try {
  startProc('anvil', ['--fork-url', UPSTREAM, '--port', String(PORT), '--chain-id', '1', '--silent']);
  const pub = createPublicClient({ chain: mainnet, transport: http(FORK), pollingInterval: 100 });
  for (let i = 0; i < 100; i++) { try { await pub.getChainId(); break; } catch { await sleep(200); } }
  const rpc = (method, params) => pub.request({ method, params });

  // throwaway keys made for this run; they only ever exist on the fork
  const user = privateKeyToAccount(generatePrivateKey());
  const relayKey = generatePrivateKey();
  const relayer = privateKeyToAccount(relayKey);
  const platform = privateKeyToAccount(generatePrivateKey()).address;
  const ownerKey = generatePrivateKey();
  const deployer = privateKeyToAccount(ownerKey);
  writeFileSync(join(keysDir, 'owner.txt'), ownerKey + '\n');
  writeFileSync(join(keysDir, 'relayer.key'), relayKey + '\n');
  for (const [a, v] of [[deployer.address, '1'], [user.address, '20'], [relayer.address, '0.01']]) await rpc('anvil_setBalance', [a, toHex(parseEther(v))]);
  const wal = createWalletClient({ account: user, chain: mainnet, transport: http(FORK) });
  const send = async req => {
    const hash = await wal.writeContract(req);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 30_000 }).catch(async e => {
      const tx = await pub.getTransaction({ hash }).catch(() => null);
      const blk = await pub.getBlock();
      console.log('DEBUG stuck tx', tx && { nonce: tx.nonce, gas: tx.gas, maxFee: tx.maxFeePerGas, prio: tx.maxPriorityFeePerGas, block: tx.blockNumber },
        { base: blk.baseFeePerGas, gasLimit: blk.gasLimit, number: blk.number },
        { latest: await pub.getTransactionCount({ address: user.address }), pending: await pub.getTransactionCount({ address: user.address, blockTag: 'pending' }) },
        await pub.request({ method: 'txpool_status', params: [] }).catch(() => '?'));
      throw e;
    });
    if (r.status !== 'success') throw Error(`${req.functionName} reverted`);
    return r;
  };

  // ---- deploy with the real script
  const node = (...a) => spawnSync(process.execPath, a, { cwd: ROOT, encoding: 'utf8' });
  const dep = node('launch/swap.mjs', 'deploy', '--rpc', FORK, '--keys', keysDir, '--vault', VAULT, '--platform', platform, '--fee-bps', String(FEE_BPS));
  const rec = JSON.parse(readFileSync(join(keysDir, 'swap-fork.json'), 'utf8'));
  const SWAP = getAddress(rec.swap);
  check(dep.status === 0 && !!SWAP, 'swap.mjs deploy: BunkerSwap on the fork', `${SWAP}  ${dep.stdout.match(/\d+ gas/)?.[0] ?? ''}`);
  const again = node('launch/swap.mjs', 'deploy', '--rpc', FORK, '--keys', keysDir, '--vault', VAULT);
  check(again.status !== 0 && /already deployed/.test(again.stderr), 'swap.mjs deploy: refuses to deploy twice by accident');
  const st = node('launch/swap.mjs', 'status', '--rpc', FORK, '--keys', keysDir);
  check(st.status === 0 && st.stdout.includes('fee 0.5%') && st.stdout.toLowerCase().includes(platform.toLowerCase()), 'swap.mjs status: fee 0.5% to the platform wallet');
  const BOX = await pub.readContract({ address: SWAP, abi: bs.swapAbi, functionName: 'BOX' });

  // ---- a bunker with 5 ETH
  const master = wots.masterOf(wots.newPhrase());
  const id = wots.accountId(master);
  await send({ address: VAULT, abi: V, functionName: 'depositETH', args: [id], value: parseEther('5') });
  const main = { master, id };
  const bal = token => pub.readContract({ address: VAULT, abi: V, functionName: 'balanceOf', args: [id, token] });
  const nonceOf = async () => Number((await pub.readContract({ address: VAULT, abi: V, functionName: 'accounts', args: [id] }))[1]);
  const now = async () => Number((await pub.getBlock()).timestamp);

  /** Builds and signs a swap order exactly the way the site does. */
  async function makeOrder({ tokenIn, tokenOut, amountIn, tip = 0n, slippageBps = 100, minOut, route, deadlineIn = 600, submitter = zeroAddress, acct }) {
    const { master, id } = acct ?? main;
    const nonce = Number((await pub.readContract({ address: VAULT, abi: V, functionName: 'accounts', args: [id] }))[1]);
    let quote = null;
    if (!route) {
      const quoteIn = tokenIn === ETH ? bs.buySplit(amountIn, tip, FEE_BPS).spend : amountIn;
      const quotes = await bs.quoteAll(pub, { tokenIn, tokenOut, amountIn: quoteIn });
      if (!quotes.length) throw Error('no pool');
      quote = quotes[0];
      route = bs.routeOf(quote);
      if (minOut === undefined)
        minOut = tokenIn === ETH ? bs.withSlippage(quote.amountOut, slippageBps) : bs.sellSplit(bs.withSlippage(quote.amountOut, slippageBps), tip, FEE_BPS).net;
    }
    const order = { id, nonce, tokenIn, tokenOut, amountIn, minOut, tip, submitter, deadline: (await now()) + deadlineIn, route: bs.routeHash(route) };
    const box = bs.boxOf(SWAP, BOX, order);
    const nextKey = wots.keyHash(master, nonce + 1);
    const transfers = [{ token: tokenIn, to: box, amount: amountIn }];
    const digest = wots.digestOf({ chainId: 1, vault: VAULT, id, nonce, transfers, relayer: SWAP, fee: 0n, nextKey });
    const sig = wots.sign(master, nonce, digest);
    return { order, route, box, nextKey, sig, digest, transfers, quote };
  }
  const runArgs = o => [bs.orderArgs(o.order), o.nextKey, o.sig, o.route.commands, o.route.inputs];
  const relayBody = o => ({ kind: 'swap', order: Object.fromEntries(Object.entries(o.order).map(([k, v]) => [k, typeof v === 'bigint' || typeof v === 'number' ? String(v) : v])),
    nextKey: o.nextKey, sig: o.sig, commands: o.route.commands, inputs: o.route.inputs });
  const post = async body => { const r = await fetch(`${RELAY}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const landed = async (n, ms = 15000) => { for (let t = 0; t < ms; t += 150) { if ((await nonceOf()) > n) return true; await sleep(150); } return false; };

  // ---- JS == contract
  const probe = await makeOrder({ tokenIn: ETH, tokenOut: BUNKER, amountIn: parseEther('1') });
  check((await pub.readContract({ address: SWAP, abi: bs.swapAbi, functionName: 'orderHash', args: [runArgs(probe)[0]] })) === bs.orderHash(probe.order), 'JS orderHash = contract orderHash');
  check((await pub.readContract({ address: SWAP, abi: bs.swapAbi, functionName: 'boxOf', args: [runArgs(probe)[0]] })) === probe.box, 'JS box address = contract boxOf', probe.box);
  check((await pub.readContract({ address: VAULT, abi: V, functionName: 'digest', args: [id, probe.transfers, SWAP, 0n, probe.nextKey] })) === probe.digest, 'JS digest = vault digest() for a swap order');
  check(probe.quote.kind === 'v4' && probe.quote.fee === 10000, 'quote: $BUNKER found on its Uniswap v4 1% pool', `${probe.quote.label}: 1 ETH -> ${Number(formatEther(probe.quote.amountOut)).toFixed(0)} BUNKER`);

  // ---- swap submitted by a normal wallet (it only pays gas)
  let r = await send({ address: SWAP, abi: bs.swapAbi, functionName: 'run', args: runArgs(probe) });
  const gotBunker = await bal(BUNKER);
  check(gotBunker >= probe.order.minOut && (await bal(ETH)) === parseEther('4'), 'wallet-submitted buy: 1 ETH left the bunker, BUNKER landed in it', `${Number(formatEther(gotBunker)).toFixed(0)} BUNKER, ${r.gasUsed} gas`);
  check((await pub.getBalance({ address: platform })) === parseEther('0.005'), 'fee: 0.5% of the ETH side paid straight to the platform wallet');
  check((await pub.readContract({ address: BUNKER, abi: erc20, functionName: 'balanceOf', args: [user.address] })) === 0n && (await nonceOf()) === 1, 'the submitting wallet received nothing; key rotated to #1');

  // ---- relayer
  startProc(process.execPath, ['launch/swap.mjs', 'relayer', '--rpc', FORK, '--key', join(keysDir, 'relayer.key'), '--swap', SWAP, '--vault', VAULT,
    '--token', BUNKER, '--port', String(RELAY_PORT), '--state', join(keysDir, 'relayer-state.json'), '--min-balance', '0.001', '--rate-ip', '40', '--rate-id', '40', '--free-cap', '0.002'], { cwd: ROOT });
  let info;
  for (let i = 0; i < 60; i++) { try { info = await (await fetch(`${RELAY}/info`)).json(); break; } catch { await sleep(200); } }
  check(info?.ok && getAddress(info.relayer) === relayer.address && getAddress(info.swap) === SWAP && info.paused === null, 'relayer /info: up, right contracts, not paused', `asks ${formatUnits(BigInt(info.gasPrice), 9)} gwei per gas + ${formatEther(BigInt(info.flat))} ETH`);
  const feeFor = gasUnits => BigInt(gasUnits) * BigInt(info.gasPrice) + BigInt(info.flat);

  // gasless sell: nobody but the relayer sends a transaction
  let relayBefore = await pub.getBalance({ address: relayer.address });
  const tipSell = feeFor(info.gas.sell);
  const sell = await makeOrder({ tokenIn: BUNKER, tokenOut: ETH, amountIn: gotBunker / 2n, tip: tipSell, submitter: relayer.address });
  const ethBefore = await bal(ETH);
  const sniped = await pub.simulateContract({ address: SWAP, abi: bs.swapAbi, functionName: 'run', args: runArgs(sell), account: user.address })
    .then(() => 'went through', e => e.walk?.(x => x.data?.errorName)?.data?.errorName ?? e.shortMessage);
  check(sniped === 'NotSubmitter', 'a bot that copies the relayer\'s transaction can not take the tip: the order names its submitter', sniped);
  let res = await post(relayBody(sell));
  check(res.status === 200 && /^0x[0-9a-f]{64}$/.test(res.hash), 'gasless sell: relayer accepted and broadcast it', res.hash ?? res.error);
  check(await landed(1), 'gasless sell: landed');
  const netEth = (await bal(ETH)) - ethBefore;
  check(netEth >= sell.order.minOut && (await bal(BUNKER)) === gotBunker - gotBunker / 2n, 'gasless sell: bunker credited at least the signed minimum', `+${formatEther(netEth)} ETH (min ${formatEther(sell.order.minOut)})`);
  let profit = (await pub.getBalance({ address: relayer.address })) - relayBefore;
  check(profit > 0n, 'gasless sell: the tip more than paid the relayer\'s gas', `relayer +${formatEther(profit)} ETH`);
  res = await post(relayBody(sell));
  check(res.status === 200 && res.done === true, 'relayer: the same message again is answered "already landed"');

  // gasless buy of USDC (best pool wins)
  const tipBuy = feeFor(info.gas.buy);
  const buyUsdc = await makeOrder({ tokenIn: ETH, tokenOut: USDC, amountIn: parseEther('1'), tip: tipBuy, submitter: relayer.address });
  res = await post(relayBody(buyUsdc));
  check(res.status === 200 && (await landed(2)), 'gasless buy: 1 ETH -> USDC', buyUsdc.quote.label);
  const usdc = await bal(USDC);
  check(usdc >= buyUsdc.order.minOut && usdc > 1000n * 10n ** 6n, 'gasless buy: USDC credited to the bunker', `${formatUnits(usdc, 6)} USDC`);

  // ---- gasless plain withdrawal (the vault's own fee slot)
  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  {
    const nonce = await nonceOf();
    const fee = feeFor(info.gas.withdraw + info.gas.perEth + info.gas.perToken);
    const transfers = [{ token: ETH, to: fresh, amount: parseEther('0.5') }, { token: USDC, to: fresh, amount: usdc }];
    const nextKey = wots.keyHash(master, nonce + 1);
    const digest = wots.digestOf({ chainId: 1, vault: VAULT, id, nonce, transfers, relayer: zeroAddress, fee, nextKey });
    const sig = wots.sign(master, nonce, digest);
    const body = { kind: 'withdraw', id, nonce: String(nonce), fee: String(fee), nextKey, sig, transfers: transfers.map(t => ({ ...t, amount: String(t.amount) })) };
    relayBefore = await pub.getBalance({ address: relayer.address });
    const before = await bal(ETH);

    const bad = await post({ ...body, sig: [...sig.slice(0, 66), sig[0]] });
    check(bad.status === 422 && bad.reason === 'BadSignature', 'relayer refuses a tampered signature', bad.error);
    const moved = await post({ ...body, transfers: [{ ...body.transfers[0], to: user.address }, body.transfers[1]] });
    check(moved.status === 422 && moved.reason === 'BadSignature', 'relayer can not redirect a withdrawal: changing the recipient breaks the signature');

    res = await post(body);
    check(res.status === 200 && (await landed(nonce)), 'gasless withdrawal: relayer sent it', res.error ?? res.hash);
    check((await pub.getBalance({ address: fresh })) === parseEther('0.5') && (await pub.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [fresh] })) === usdc,
      'gasless withdrawal: 0.5 ETH + all USDC arrived at a fresh address that never held gas');
    check(before - (await bal(ETH)) === parseEther('0.5') + fee, 'gasless withdrawal: the bunker paid exactly the signed fee', `${formatEther(fee)} ETH`);
    profit = (await pub.getBalance({ address: relayer.address })) - relayBefore;
    check(profit > 0n, 'gasless withdrawal: the fee more than paid the gas', `relayer +${formatEther(profit)} ETH`);
  }

  // ---- what the relayer must refuse
  {
    const cheap = await makeOrder({ tokenIn: ETH, tokenOut: BUNKER, amountIn: parseEther('0.2'), tip: 1n });
    res = await post(relayBody(cheap));
    check(res.status === 402 && BigInt(res.need) > 1n, 'relayer refuses a tip that does not cover the gas', res.error);
    // that key has now signed: the same order is still good when a wallet pays the gas instead
    await send({ address: SWAP, abi: bs.swapAbi, functionName: 'run', args: runArgs(cheap) });
    check(true, '...and the same signed order still works from a wallet (nobody depends on the relayer)');

    // a token the relayer does not list, from a second bunker (its signed order is never sent anywhere)
    const sideMaster = wots.masterOf(wots.newPhrase());
    const side = { master: sideMaster, id: wots.accountId(sideMaster) };
    await send({ address: VAULT, abi: V, functionName: 'depositETH', args: [side.id], value: parseEther('0.3') });
    const pepe = await makeOrder({ tokenIn: ETH, tokenOut: PEPE, amountIn: parseEther('0.2'), tip: tipBuy, minOut: 1n, acct: side,
      submitter: relayer.address, route: bs.routeOf({ kind: 'v2', tokenIn: ETH, tokenOut: PEPE }) });
    res = await post(relayBody(pepe));
    check(res.status === 403, 'relayer only swaps listed tokens (any other token goes through a wallet)', res.error);

    const far = await makeOrder({ tokenIn: ETH, tokenOut: BUNKER, amountIn: parseEther('0.2'), tip: tipBuy, acct: side, submitter: relayer.address, deadlineIn: 7200,
      route: bs.routeOf({ kind: 'v4', fee: 10000, tickSpacing: 200, tokenIn: ETH, tokenOut: BUNKER }), minOut: 1n });
    res = await post(relayBody(far));
    check(res.status === 400 && /deadline/.test(res.error), 'relayer refuses a deadline more than an hour away', res.error);

    const evil = await makeOrder({ tokenIn: ETH, tokenOut: BUNKER, amountIn: parseEther('0.2'), tip: tipBuy, submitter: relayer.address });
    const other = bs.routeOf({ kind: 'v3', fee: 500, tokenIn: ETH, tokenOut: USDC });
    res = await post({ ...relayBody(evil), commands: other.commands, inputs: other.inputs });
    check(res.status === 422 && res.reason === 'BadRoute', 'relayer can not swap along another route', res.error);
    res = await post({ ...relayBody(evil), order: { ...relayBody(evil).order, minOut: '1' } });
    check(res.status === 422 && res.reason === 'BadSignature', 'relayer can not lower the minimum: the box address changes and the signature fails');
    res = await post({ ...relayBody(evil), order: { ...relayBody(evil).order, nonce: String(evil.order.nonce + 5) } });
    check(res.status === 400, 'relayer refuses a message for a key that is not current');
    res = await post(relayBody(evil));
    check(res.status === 200 && (await landed(evil.order.nonce)), '...the untouched order goes through');
  }

  // ---- an order the market walks away from
  {
    const n = await nonceOf();
    const ethBeforeOrder = await bal(ETH);
    const o = await makeOrder({ tokenIn: ETH, tokenOut: BUNKER, amountIn: parseEther('0.5'), tip: tipBuy, submitter: relayer.address, minOut: 10n ** 30n, route: bs.routeOf({ kind: 'v4', fee: 10000, tickSpacing: 200, tokenIn: ETH, tokenOut: BUNKER }), deadlineIn: 120 });
    res = await post(relayBody(o));
    check(res.status === 422 && res.reason === 'TooLittle', 'price moved: relayer does not send, nothing is spent, the key is not burned', res.error);
    check((await nonceOf()) === n && (await bal(ETH)) === ethBeforeOrder, '...bunker untouched');
    await rpc('evm_increaseTime', [200]);
    await rpc('evm_mine', []);
    relayBefore = await pub.getBalance({ address: relayer.address });
    res = await post(relayBody(o));
    check(res.status === 200 && (await landed(n)), 'after the deadline the SAME signature hands the funds back and frees the key');
    check((await bal(ETH)) === ethBeforeOrder - tipBuy, '...all the ETH is back in the bunker, less only the tip', `${formatEther(ethBeforeOrder - tipBuy)} ETH`);
    check((await pub.getBalance({ address: relayer.address })) > relayBefore, '...and the relayer was paid for the trip');
    const next = await makeOrder({ tokenIn: ETH, tokenOut: BUNKER, amountIn: parseEther('0.1'), tip: tipBuy, submitter: relayer.address });
    res = await post(relayBody(next));
    check(res.status === 200 && (await landed(n + 1)), 'the bunker swaps again with its next key');
  }

  // ---- a token order that expires: the relayer hands it back for free (a tip can only come out of ETH)
  {
    const n = await nonceOf();
    const held = await bal(BUNKER);
    const o = await makeOrder({ tokenIn: BUNKER, tokenOut: ETH, amountIn: held, tip: tipSell, submitter: relayer.address, minOut: 10n ** 30n, route: bs.routeOf({ kind: 'v4', fee: 10000, tickSpacing: 200, tokenIn: BUNKER, tokenOut: ETH }), deadlineIn: 120 });
    await rpc('evm_increaseTime', [200]);
    await rpc('evm_mine', []);
    res = await post(relayBody(o));
    check(res.status === 200 && (await landed(n)) && (await bal(BUNKER)) === held, 'expired token order: relayer hands the tokens back at its own cost');
  }

  // ---- limits
  {
    let limited = false;
    for (let i = 0; i < 60 && !limited; i++) limited = (await post({ kind: 'nope' })).status === 429;
    check(limited, 'relayer rate-limits a noisy caller');
    const stFinal = node('launch/swap.mjs', 'status', '--rpc', FORK, '--keys', keysDir);
    check(/swaps \d+/.test(stFinal.stdout), 'swap.mjs status: counts swaps and fees', stFinal.stdout.split('\n').find(l => l.includes('swaps'))?.trim());
    const col = node('launch/swap.mjs', 'collect', '--rpc', FORK, '--keys', keysDir);
    check(col.status === 0 && /nothing to collect/.test(col.stdout), 'swap.mjs collect: nothing owed, fees were paid as they came');
  }

  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
} catch (e) {
  console.error('\nFAILED:', e.message);
  process.exitCode = 1;
} finally {
  stop();
  try { rmSync(keysDir, { recursive: true, force: true }); } catch {}
}
