// TRIPWIRE on a local Ethereum mainnet fork, against the REAL BunkerVault and real USDC / USDT / WETH / BUNKER.
//   node launch/test/tripwire-e2e.mjs          (needs: forge build done, network for the fork)
// Checks the canary key independently (noble secp256k1), shows why claim() hashes its own message (a chosen-hash
// "signature" for the canary DOES pass ecrecover), trips a held-key twin with a real EIP-7702 authorization, then
// runs the keeper script for real: armed = nothing moves; canary code = trip + every approved balance escapes into
// the bunker; the bunker phrase (WOTS) then gets all four tokens out to a fresh address. Stops only its own anvil.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  createPublicClient, createWalletClient, http, parseEther, getAddress, keccak256, encodeAbiParameters, encodePacked, toHex,
  toBytes, concat, parseAbi, formatUnits, zeroAddress, numberToHex, hexToBigInt, parseSignature,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey, publicKeyToAddress } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import * as wots from '../../site/src/lib/wots.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const artAt = (file, n) => JSON.parse(readFileSync(join(ROOT, 'contracts', 'out', file, `${n}.json`), 'utf8'));
const TWA = artAt('BunkerTripwire.sol', 'BunkerTripwire'), HELD = artAt('BunkerTripwire.t.sol', 'HeldCanaryTripwire');
const TW = TWA.abi, V = artAt('BunkerVault.sol', 'BunkerVault').abi;
const PORT = 8647, FORK = `http://127.0.0.1:${PORT}`;
const UPSTREAM = process.env.FORK_UPSTREAM ?? 'https://ethereum-rpc.publicnode.com';
const VAULT = '0x39C71b635409b1f98dc632e08d3B29515ddb2727';
const BUNKER = '0xBDC4cE7c4718d20498e7D549751FF336690eb6D7';
const HOLDER = '0x000000000004444c5dc75cB358380D2e3dE08A90'; // Uniswap v4 PoolManager holds the pool's BUNKER (impersonated on the fork only)
const TOKENS = {
  USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', slot: 9n, amount: 2_500_000_000n, dec: 6 },
  USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', slot: 2n, amount: 1_750_000_000n, dec: 6 },
  WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', slot: 3n, amount: parseEther('3.5'), dec: 18 },
  BUNKER: { address: BUNKER, amount: parseEther('250000'), dec: 18 },
};
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256)', 'function transfer(address,uint256) returns (bool)',
]);
const N = secp256k1.CURVE.n, Pp = secp256k1.CURVE.Fp.ORDER;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (ok, what, detail = '') => {
  results.push(ok);
  console.log(`[${ok ? ' OK ' : 'FAIL'}] ${what}${detail ? '  ' + detail : ''}`);
  if (!ok) throw new Error(`${what} ${detail}`);
};
const reverts = async fn => { try { await fn(); return false; } catch { return true; } };
const mod = (a, m) => ((a % m) + m) % m;
const inv = (a, m) => { // extended Euclid
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod(s0, m);
};
const rand = () => mod(hexToBigInt(generatePrivateKey()), N - 1n) + 1n;

const anvil = spawn('anvil', ['--fork-url', UPSTREAM, '--port', String(PORT), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
const keeperKeyFile = join(tmpdir(), `tw-keeper-${Date.now()}.txt`);
const stop = () => { try { anvil.kill(); } catch { /* gone */ } try { rmSync(keeperKeyFile); } catch { /* none */ } };

try {
  const pub = createPublicClient({ chain: mainnet, transport: http(FORK), pollingInterval: 100 });
  for (let i = 0; i < 120; i++) { try { await pub.getChainId(); break; } catch { await sleep(500); } }
  const rpc = (method, params) => pub.request({ method, params });
  const walletOf = acct => createWalletClient({ account: acct, chain: mainnet, transport: http(FORK) });
  const fundEth = (a, eth) => rpc('anvil_setBalance', [a, toHex(parseEther(eth))]);
  const write = async (wal, address, abi, functionName, args = [], value) => {
    const hash = await wal.writeContract({ address, abi, functionName, args, value });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`${functionName} reverted`);
    return r;
  };
  const bal = (t, a) => pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [a] });

  check((await pub.getCode({ address: VAULT }))?.length > 2, 'real BunkerVault present on the fork', VAULT);
  const deployer = privateKeyToAccount(generatePrivateKey());
  await fundEth(deployer.address, '10');
  const dwal = walletOf(deployer);
  const deploy = async (a, value = 0n) => {
    const hash = await dwal.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: [VAULT], value });
    const r = await pub.waitForTransactionReceipt({ hash });
    return { address: getAddress(r.contractAddress), gas: r.gasUsed };
  };
  const { address: tw, gas: deployGas } = await deploy(TWA, parseEther('0.5'));
  check(true, 'BunkerTripwire deployed with a 0.5 ETH bounty', `${tw} · gas ${deployGas}`);
  const read = (functionName, args = [], address = tw, abi = TW) => pub.readContract({ address, abi, functionName, args });

  // ---------------------------------------------------------------- 1. canary: nothing up the sleeve, checked off-chain
  const seed = toBytes(await read('CANARY_SEED'));
  let counter = 0n, point;
  for (;; counter++) {
    const x = hexToBigInt(keccak256(concat([seed, toBytes(counter, { size: 32 })])));
    if (x >= Pp) continue;
    try { point = secp256k1.ProjectivePoint.fromHex('02' + x.toString(16).padStart(64, '0')); break; } catch { /* not on curve */ }
  }
  const pubKey = toHex(point.toRawBytes(false));
  check(await read('canaryCounter') === counter && await read('canaryX') === point.x && await read('canaryY') === point.y,
    'canary key = first on-curve keccak(seed ‖ counter), even y (independent noble check)', `counter ${counter}`);
  const canary = await read('canary');
  check(canary === publicKeyToAddress(pubKey) && await read('canaryPublicKey') === pubKey, 'canary address = keccak(pubkey)', canary);
  check((await pub.getCode({ address: canary }) ?? '0x') === '0x' && await pub.getTransactionCount({ address: canary }) === 0, 'canary never signed, no code');

  // ---------------------------------------------------------------- 2. why the claim message is hashed on-chain
  // With a FREE choice of hash e, anyone can make (e, v, r, s) that ecrecovers to ANY public key: R = aG + bQ,
  // r = R.x, s = r/b, e = r·a/b. claim() never accepts e, it computes keccak(tag, chain, contract, to) itself.
  let forged;
  for (;;) {
    const a = rand(), b = rand();
    const R = secp256k1.ProjectivePoint.BASE.multiply(a).add(point.multiply(b)).toAffine();
    const r = mod(R.x, N);
    if (r === 0n || R.x >= N) continue;
    const s = mod(r * inv(b, N), N), e = mod(r * a * inv(b, N), N);
    forged = { e, r, s, v: R.y & 1n ? 28 : 27 };
    break;
  }
  const word = x => numberToHex(x, { size: 32 });
  const rec = await rpc('eth_call', [{ to: '0x0000000000000000000000000000000000000001', data: concat([word(forged.e), word(BigInt(forged.v)), word(forged.r), word(forged.s)]) }, 'latest']);
  check(getAddress('0x' + rec.slice(26)) === canary, 'chosen-hash forgery DOES pass raw ecrecover for the canary (the trap)');
  const hunter = privateKeyToAccount(generatePrivateKey());
  await fundEth(hunter.address, '1');
  check(await reverts(() => pub.simulateContract({ address: tw, abi: TW, functionName: 'claim', account: hunter, args: [hunter.address, forged.v, word(forged.r), word(forged.s)] })),
    'the same forgery can NOT claim the bounty (claim hashes its own message)');

  // ---------------------------------------------------------------- 3. a wallet arms itself with real tokens
  const owner = privateKeyToAccount(generatePrivateKey());
  await fundEth(owner.address, '2');
  const owal = walletOf(owner);
  for (const [name, t] of Object.entries(TOKENS)) {
    if (t.slot !== undefined) {
      const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner.address, t.slot]));
      await rpc('anvil_setStorageAt', [t.address, slot, toHex(t.amount, { size: 32 })]);
    } else {
      await rpc('anvil_impersonateAccount', [HOLDER]);
      await fundEth(HOLDER, '1');
      await write(createWalletClient({ account: HOLDER, chain: mainnet, transport: http(FORK) }), t.address, ERC20, 'transfer', [owner.address, t.amount]);
      await rpc('anvil_stopImpersonatingAccount', [HOLDER]);
    }
    check(await bal(t.address, owner.address) === t.amount, `owner holds ${formatUnits(t.amount, t.dec)} ${name}`);
  }
  const phrase = wots.newPhrase();
  const master = wots.masterOf(phrase);
  const bunker = wots.accountId(master);
  check(await reverts(() => pub.simulateContract({ address: tw, abi: TW, functionName: 'register', account: owner, args: [bunker, [TOKENS.USDC.address]] })),
    'register refuses a bunker that is not open yet');
  await write(owal, VAULT, V, 'depositETH', [bunker], parseEther('0.001'));
  const tokenList = Object.values(TOKENS).map(t => t.address);
  for (const t of tokenList) await write(owal, t, ERC20, 'approve', [tw, 2n ** 256n - 1n]);
  const reg = await write(owal, tw, TW, 'register', [bunker, tokenList]);
  check(await read('bunkerOf', [owner.address]) === bunker && (await read('tokensOf', [owner.address])).length === 4, 'owner registered bunker + 4 tokens', `gas ${reg.gasUsed}`);

  // a second member, USDC only, partial allowance
  const owner2 = privateKeyToAccount(generatePrivateKey());
  await fundEth(owner2.address, '1');
  const o2 = walletOf(owner2);
  await rpc('anvil_setStorageAt', [TOKENS.USDC.address, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner2.address, 9n])), toHex(900_000_000n, { size: 32 })]);
  await write(o2, TOKENS.USDC.address, ERC20, 'approve', [tw, 600_000_000n]);
  await write(o2, tw, TW, 'register', [bunker, [TOKENS.USDC.address]]); // same bunker is fine: it is just an account id
  check(await read('memberCount') === 2n, 'two members listed');

  // ---------------------------------------------------------------- 4. armed: nothing moves, keeper does nothing
  check(await reverts(() => pub.simulateContract({ address: tw, abi: TW, functionName: 'escape', account: hunter, args: [owner.address] })), 'escape reverts while armed');
  // the keeper only needs a gas wallet: a fork-only throwaway key in a temp file (deleted at the end)
  const keeperPk = generatePrivateKey();
  const keeper = privateKeyToAccount(keeperPk);
  await fundEth(keeper.address, '5');
  writeFileSync(keeperKeyFile, `${keeperPk}\n`);
  const runKeeper = () => execFileSync('node', [join(ROOT, 'launch', 'tripwire.mjs'), 'keeper', '--rpc', FORK, '--key', keeperKeyFile, '--tripwire', tw, '--once'], { encoding: 'utf8' });
  let out = runKeeper();
  check(!/escap|trip/i.test(out.split('\n').slice(1).join('\n')) && await read('trippedAt') === 0n && await bal(TOKENS.USDC.address, owner.address) === TOKENS.USDC.amount,
    'keeper while armed: no trip, no escape');

  // ---------------------------------------------------------------- 5. a REAL EIP-7702 delegation trips a held-key twin
  const held = privateKeyToAccount(numberToHex(0xc0ffeen, { size: 32 }));
  await rpc('anvil_setCode', [held.address, '0x']); // 0xc0ffee is a weak key: clear anything bots left on mainnet
  const { address: twin } = await deploy(HELD, parseEther('0.2'));
  check(await read('canary', [], twin) === held.address, 'twin tripwire: canary is a key we hold', held.address);
  check(await read('isTripped', [], twin) === false, 'twin armed');
  const auth = await dwal.signAuthorization({ account: held, contractAddress: VAULT, chainId: 1, nonce: await pub.getTransactionCount({ address: held.address }) });
  const h7702 = await dwal.sendTransaction({ authorizationList: [auth], to: deployer.address, value: 0n });
  await pub.waitForTransactionReceipt({ hash: h7702 });
  const heldCode = await pub.getCode({ address: held.address });
  check(heldCode?.toLowerCase() === ('0xef0100' + VAULT.slice(2)).toLowerCase(), 'type-4 tx: canary now carries a delegation designator', heldCode);
  check(await read('isTripped', [], twin) === true, 'twin sees the code: isTripped() = true');
  await write(dwal, twin, TW, 'trip');
  check(await read('trippedAt', [], twin) > 0n, 'trip() recorded');
  const sig = await held.sign({ hash: await read('claimDigest', [hunter.address], twin) });
  const { r, s, yParity } = parseSignature(sig);
  const before = await pub.getBalance({ address: hunter.address });
  await write(dwal, twin, TW, 'claim', [hunter.address, 27 + yParity, r, s]);
  check(await pub.getBalance({ address: hunter.address }) - before === parseEther('0.2') && await read('claimedBy', [], twin) === hunter.address, 'canary signature claims the whole 0.2 ETH bounty');

  // ---------------------------------------------------------------- 6. the real wire: canary gets code, keeper evacuates
  await rpc('anvil_setCode', [canary, '0xef0100' + VAULT.slice(2).toLowerCase()]);
  check(await read('isTripped') === true, 'real canary has code (what a 7702 delegation by a cracked key leaves)');
  const t0 = performance.now();
  out = runKeeper();
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  process.stdout.write(out.split('\n').filter(Boolean).map(l => '        keeper: ' + l.slice(20)).join('\n') + '\n');
  check(await read('trippedAt') > 0n, 'keeper tripped the wire', `${secs}s for trip + sweep`);
  for (const [name, t] of Object.entries(TOKENS)) {
    const got = await pub.readContract({ address: VAULT, abi: V, functionName: 'balanceOf', args: [bunker, t.address] });
    const want = t.amount + (name === 'USDC' ? 600_000_000n : 0n);
    check(got === want && await bal(t.address, owner.address) === 0n, `${name}: all of it is now in the bunker`, `${formatUnits(got, t.dec)}`);
  }
  check(await bal(TOKENS.USDC.address, owner2.address) === 300_000_000n, 'member 2: only the approved 600 of 900 USDC moved');
  check(!/escaping/.test(runKeeper()), 'second keeper pass: nothing left to move');

  // ---------------------------------------------------------------- 7. only the bunker phrase gets it out
  const fresh = privateKeyToAccount(generatePrivateKey()).address;
  const transfers = Object.entries(TOKENS).map(([name, t]) => ({ token: t.address, to: fresh, amount: t.amount + (name === 'USDC' ? 600_000_000n : 0n) }));
  const [key, nonce] = await read('accounts', [bunker], VAULT, V);
  const nextKey = wots.keyHash(master, Number(nonce) + 1);
  const d = wots.digestOf({ chainId: 1, vault: VAULT, id: bunker, nonce: Number(nonce), transfers, relayer: zeroAddress, fee: 0n, nextKey });
  check(d === await read('digest', [bunker, transfers, zeroAddress, 0n, nextKey], VAULT, V) && key === wots.keyHash(master, Number(nonce)), 'WOTS digest + key match the real vault');
  const wsig = wots.sign(master, Number(nonce), d);
  const x = await write(walletOf(hunter), VAULT, V, 'execute', [bunker, transfers, zeroAddress, 0n, nextKey, wsig]);
  for (const t of transfers) check(await bal(t.token, fresh) === t.amount, `fresh address received ${Object.keys(TOKENS).find(k => TOKENS[k].address === t.token)}`);
  check(true, 'one WOTS signature, submitted by an unrelated wallet', `gas ${x.gasUsed}`);

  console.log(`\n${results.length}/${results.length} checks passed`);
} catch (e) {
  console.error('\nFAILED:', e.shortMessage || e.message);
  process.exitCode = 1;
} finally { stop(); }
