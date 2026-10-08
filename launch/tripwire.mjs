// BUNKER TRIPWIRE: deploy, fund, watch.
//
//   node launch/tripwire.mjs deploy  --rpc URL --keys DIR [--vault 0x..] [--seed 0] [--mainnet]   (--vault required off mainnet)
//   node launch/tripwire.mjs fund    --rpc URL --keys DIR --amount 0.5 [--tripwire 0x..] [--mainnet]
//   node launch/tripwire.mjs status  --rpc URL [--keys DIR | --tripwire 0x..]
//   node launch/tripwire.mjs keeper  --rpc URL[,URL2] --key FILE [--keys DIR | --tripwire 0x..] [--once] [--interval 6]
//                                    [--tip-gwei 3] [--batch-moves 24] [--mainnet]
//
// deploy: BunkerTripwire(vault) from DIR/owner.txt; --seed sends that much ETH into the bounty with the deploy
//   (one way: bounty ETH only ever leaves through a canary signature). Address saved to DIR/tripwire.json.
// keeper: watches the canary every --interval seconds. When code appears at the canary it calls trip(); once the
//   wire is tripped it reads every member's approved balances and sends escapeMany() in batches, then keeps
//   sweeping new arrivals. A canary nonce above 0 with no code and no claim is logged as an ALERT (the contract can
//   not see nonces). --key is a small hot wallet that only pays gas; it controls nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, fallback, getAddress, formatEther, parseEther, parseGwei, parseAbi, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const art = n => JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', `${n}.sol`, `${n}.json`), 'utf8'));
const TW = art('BunkerTripwire').abi;
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
const MAINNET_VAULT = '0x39C71b635409b1f98dc632e08d3B29515ddb2727';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
};
const flag = name => args.includes('--' + name);
const isLocal = url => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url);
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const say = (...a) => console.log(stamp(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadKey(file) {
  const key = fs.readFileSync(file, 'utf8').match(/0x[0-9a-fA-F]{64}/)?.[0];
  if (!key) throw new Error(`${file} holds no private key`);
  return key;
}
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

function setup() {
  const rpc = opt('rpc');
  if (!rpc) throw new Error('--rpc is required');
  const urls = rpc.split(',').map(u => u.trim()).filter(Boolean); // several = fallback in order
  const transport = urls.length > 1 ? fallback(urls.map(u => http(u))) : http(urls[0]);
  // local only if EVERY endpoint is local: a fallback list must never slip a real-chain RPC past the --mainnet check
  const localCount = urls.filter(isLocal).length;
  if (localCount && localCount !== urls.length) throw new Error('--rpc mixes local and remote endpoints; use one kind');
  const local = localCount === urls.length;
  if (!local && !flag('mainnet') && cmd !== 'status') throw new Error('This is real Ethereum mainnet. Add --mainnet to send real transactions.');
  const pub = createPublicClient({ chain: mainnet, transport, pollingInterval: local ? 100 : 2000 });
  const keys = opt('keys');
  const recFile = keys && path.join(keys, local ? 'tripwire-fork.json' : 'tripwire.json');
  const rec = recFile ? readJson(recFile, {}) : {};
  const tripwire = opt('tripwire') ?? rec.tripwire;
  const wallet = file => createWalletClient({ account: privateKeyToAccount(loadKey(file)), chain: mainnet, transport });
  return { rpc, local, pub, keys, recFile, tripwire: tripwire && getAddress(tripwire), wallet };
}

async function send(pub, wal, req) {
  const hash = await wal.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${req.functionName} reverted: ${hash}`);
  return r;
}

// ------------------------------------------------------------------ deploy / fund / status

async function deploy() {
  const { pub, keys, recFile, wallet } = setup();
  if (!keys) throw new Error('--keys DIR is required');
  const wal = wallet(path.join(keys, 'owner.txt'));
  const vaultOpt = opt('vault');
  if (!vaultOpt && !flag('mainnet')) throw new Error('--vault 0x.. is required (the mainnet vault is only the default with --mainnet)');
  const vault = getAddress(vaultOpt ?? MAINNET_VAULT);
  // it must really be a BunkerVault: same domain tag and chain count
  const vaultAbi = parseAbi(['function TAG() view returns (bytes32)', 'function CHAINS() view returns (uint256)']);
  const [tag, chains] = await Promise.all([
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'TAG' }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'CHAINS' }),
  ]).catch(() => [null, null]);
  if (tag !== keccak256(toBytes('BunkerVault.execute.v1')) || chains !== 67n) throw new Error(`${vault} is not a BunkerVault`);
  const seed = parseEther(opt('seed', '0'));
  const a = art('BunkerTripwire');
  say(`deploying BunkerTripwire(vault ${vault}) from ${wal.account.address}${seed ? `, bounty ${formatEther(seed)} ETH` : ''}`);
  const hash = await wal.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: [vault], value: seed });
  say(`  -> ${hash}`);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('deploy reverted');
  const tripwire = getAddress(r.contractAddress);
  fs.writeFileSync(recFile, JSON.stringify({ tripwire, vault, block: r.blockNumber.toString(), tx: hash }, null, 2), { mode: 0o600 });
  say(`  ok · ${tripwire} · block ${r.blockNumber} · gas ${r.gasUsed}`);
  await status(tripwire);
}

async function fund() {
  const { pub, keys, tripwire, wallet } = setup();
  if (!keys || !tripwire) throw new Error('--keys DIR and a tripwire (deployed or --tripwire) are required');
  const amount = parseEther(opt('amount', '0'));
  if (!amount) throw new Error('--amount ETH is required');
  const wal = wallet(path.join(keys, 'owner.txt'));
  say(`funding the bounty with ${formatEther(amount)} ETH (one way: only a canary signature can take it out)`);
  const r = await send(pub, wal, { address: tripwire, abi: TW, functionName: 'fund', value: amount });
  say(`  ok · ${r.transactionHash} · block ${r.blockNumber}`);
  await status(tripwire);
}

async function status(addr) {
  const { pub, tripwire = addr } = addr ? { pub: setup().pub } : setup();
  const t = addr ?? tripwire;
  if (!t) throw new Error('no tripwire: pass --tripwire or --keys');
  const read = functionName => pub.readContract({ address: t, abi: TW, functionName });
  const [canary, bounty, members, trippedAt, claimedBy, counter] = await Promise.all([
    read('canary'), pub.getBalance({ address: t }), read('memberCount'), read('trippedAt'), read('claimedBy'), read('canaryCounter'),
  ]);
  const [code, nonce] = await Promise.all([pub.getCode({ address: canary }), pub.getTransactionCount({ address: canary })]);
  say(`tripwire ${t}`);
  say(`  canary   ${canary} (seed counter ${counter}) code ${code && code !== '0x' ? code : 'none'} nonce ${nonce}`);
  say(`  bounty   ${formatEther(bounty)} ETH`);
  say(`  members  ${members}`);
  say(`  state    ${trippedAt ? `TRIPPED at ${new Date(Number(trippedAt) * 1000).toISOString()}${claimedBy !== '0x0000000000000000000000000000000000000000' ? ` (claimed by ${claimedBy})` : ''}` : 'ARMED'}`);
}

// ------------------------------------------------------------------ keeper

async function pendingMoves(pub, tripwire) {
  const n = Number(await pub.readContract({ address: tripwire, abi: TW, functionName: 'memberCount' }));
  const owners = [];
  for (let start = 0; start < n; start += 500) {
    owners.push(...await pub.readContract({ address: tripwire, abi: TW, functionName: 'members', args: [BigInt(start), 500n] }));
  }
  const info = await pub.multicall({
    contracts: owners.flatMap(o => [
      { address: tripwire, abi: TW, functionName: 'bunkerOf', args: [o] },
      { address: tripwire, abi: TW, functionName: 'tokensOf', args: [o] },
    ]),
    allowFailure: false,
  });
  const pairs = [];
  owners.forEach((o, i) => {
    const bunker = info[2 * i], tokens = info[2 * i + 1];
    if (BigInt(bunker) === 0n) return;
    for (const t of tokens) pairs.push([o, t]);
  });
  const reads = await pub.multicall({
    contracts: pairs.flatMap(([o, t]) => [
      { address: t, abi: ERC20, functionName: 'balanceOf', args: [o] },
      { address: t, abi: ERC20, functionName: 'allowance', args: [o, tripwire] },
    ]),
  });
  const moves = new Map();
  pairs.forEach(([o, t], i) => {
    const b = reads[2 * i], a = reads[2 * i + 1];
    if (b.status !== 'success' || a.status !== 'success') return;
    const amount = b.result < a.result ? b.result : a.result;
    if (amount === 0n) return;
    const m = moves.get(o) ?? { owner: o, count: 0, sig: '' };
    m.count += 1;
    m.sig += `${t}:${amount};`;
    moves.set(o, m);
  });
  return [...moves.values()];
}

async function keeper() {
  const { pub, tripwire } = setup();
  if (!tripwire) throw new Error('no tripwire: pass --tripwire or --keys');
  const keyFile = opt('key');
  if (!keyFile) throw new Error('--key FILE (gas-paying hot wallet) is required');
  const wal = setup().wallet(keyFile);
  const once = flag('once');
  const interval = Number(opt('interval', '6')) * 1000;
  const tip = parseGwei(opt('tip-gwei', '3'));
  const batchMoves = Number(opt('batch-moves', '24'));
  const canary = await pub.readContract({ address: tripwire, abi: TW, functionName: 'canary' });
  say(`keeper ${wal.account.address} watching ${tripwire} (canary ${canary})${once ? ' once' : ` every ${interval / 1000}s`}`);
  let alerted = false;
  const tried = new Map(); // owner -> balances last attempted; a token that refuses to move is not retried forever

  const fees = async () => {
    const block = await pub.getBlock();
    const base = block.baseFeePerGas ?? parseGwei('1');
    return { maxFeePerGas: base * 3n + tip, maxPriorityFeePerGas: tip };
  };

  for (;;) {
    try {
      let trippedAt = await pub.readContract({ address: tripwire, abi: TW, functionName: 'trippedAt' });
      if (!trippedAt) {
        const code = await pub.getCode({ address: canary });
        if (code && code !== '0x') {
          say(`CANARY HAS CODE (${code}): tripping`);
          const r = await send(pub, wal, { address: tripwire, abi: TW, functionName: 'trip', ...(await fees()) });
          say(`  tripped · ${r.transactionHash}`);
          trippedAt = 1n;
        } else if (!alerted && await pub.getTransactionCount({ address: canary }) > 0) {
          alerted = true;
          say('ALERT: the canary has sent a transaction (nonce > 0) but left no on-chain proof the contract can see.');
        }
      }
      if (trippedAt) {
        const todo = (await pendingMoves(pub, tripwire)).filter(t => tried.get(t.owner) !== t.sig);
        for (const t of todo) tried.set(t.owner, t.sig);
        if (todo.length) say(`escaping ${todo.reduce((s, x) => s + x.count, 0)} token balances across ${todo.length} wallets`);
        // pack wallets into batches of about --batch-moves token moves, send them back to back
        const batches = [];
        let cur = [], moves = 0;
        for (const t of todo) {
          if (cur.length && moves + t.count > batchMoves) { batches.push(cur); cur = []; moves = 0; }
          cur.push(t.owner); moves += t.count;
        }
        if (cur.length) batches.push(cur);
        let nonce = await pub.getTransactionCount({ address: wal.account.address, blockTag: 'pending' });
        const sent = [];
        for (const owners of batches) {
          try {
            const gas = await pub.estimateContractGas({ address: tripwire, abi: TW, functionName: 'escapeMany', args: [owners], account: wal.account });
            const hash = await wal.writeContract({ address: tripwire, abi: TW, functionName: 'escapeMany', args: [owners], gas: (gas * 13n) / 10n, nonce: nonce++, ...(await fees()) });
            sent.push([hash, owners.length]);
          } catch (e) {
            say(`  batch of ${owners.length} failed to send: ${e.shortMessage || e.message}`);
          }
        }
        for (const [hash, count] of sent) {
          const r = await pub.waitForTransactionReceipt({ hash });
          say(`  escapeMany(${count}) ${r.status} · ${hash} · gas ${r.gasUsed}`);
        }
      }
    } catch (e) {
      say(`keeper error: ${e.shortMessage || e.message}`);
      if (once) process.exitCode = 1;
    }
    if (once) return;
    await sleep(interval);
  }
}

const run = { deploy, fund, status: () => status(), keeper }[cmd];
if (!run) {
  console.log('usage: node launch/tripwire.mjs deploy|fund|status|keeper --rpc URL ... (see the top of this file)');
  process.exit(1);
}
run().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
