// BunkerLaunchpad: deploy, status, fee collection.
//
//   node launchpad/scripts/launchpad.mjs deploy  --rpc URL --keys DIR [--platform 0x..] [--vault 0x..] [--fdv 2] [--dry] [--mainnet]
//   node launchpad/scripts/launchpad.mjs status  --rpc URL [--keys DIR | --launchpad 0x..]
//   node launchpad/scripts/launchpad.mjs collect --rpc URL --keys DIR [--min 0.001] [--launchpad 0x..] [--mainnet]
//
// deploy: BunkerLaunchpad through the canonical CREATE2 deployer with a mined salt, so its address carries exactly
//         the Uniswap v4 BEFORE_INITIALIZE hook flag (lowest 14 bits == 0x2000). Sent from DIR/owner.txt. The vault is
//         the live BunkerVault unless --vault; the platform half of every coin's fees goes to --platform (default: the
//         deployer, i.e. the BUNKER fee wallet). Writes DIR/launchpad.json (launchpad-fork.json on a local RPC).
// status: coins, uncollected fees per coin.
// collect: calls collect(token) for every coin whose uncollected ETH fees are >= --min (anyone may call it; the
//          creator half goes to the creator, the platform half to the platform).
// Remote RPCs need --mainnet for anything that sends a transaction.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  concat, createPublicClient, createWalletClient, encodeAbiParameters, fallback, formatEther, getAddress, http,
  keccak256, pad, parseEther, toBytes, toHex,
} from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { launchParams, TICK_LOWER } from './v4math.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'contracts', 'out');
export const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90';
export const STATE_VIEW = '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227';
export const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
export const BUNKER_VAULT = '0x39C71b635409b1f98dc632e08d3B29515ddb2727';

export const artifact = name => {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, `${name}.sol`, `${name}.json`), 'utf8'));
  return { abi: j.abi, bytecode: j.bytecode.object };
};

const args = process.argv.slice(2);
const cmd = args[0];
const has = name => args.includes('--' + name);
const opt = (name, fallbackValue) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return fallbackValue;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
};

const isLocal = u => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(u);
const loadKey = file => {
  const key = fs.readFileSync(file, 'utf8').match(/0x[0-9a-fA-F]{64}/)?.[0];
  if (!key) throw new Error(`no private key in ${file}`);
  return key;
};
const readJson = (file, fb) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; } };

function setup({ sends }) {
  const urls = opt('rpc', 'http://127.0.0.1:8545').split(',').map(s => s.trim()).filter(Boolean);
  const localCount = urls.filter(isLocal).length;
  if (localCount && localCount !== urls.length) throw new Error('--rpc mixes local and remote endpoints; use one kind');
  const local = localCount === urls.length;
  if (sends && !local && !has('mainnet')) throw new Error('remote RPC: pass --mainnet to send real transactions');
  const transport = urls.length > 1 ? fallback(urls.map(u => http(u))) : http(urls[0]);
  const chain = local ? { ...mainnet, rpcUrls: { default: { http: urls } } } : mainnet;
  const pub = createPublicClient({ chain, transport });
  const keys = opt('keys');
  const recFile = keys && path.join(keys, local ? 'launchpad-fork.json' : 'launchpad.json');
  const rec = recFile ? readJson(recFile, null) : null;
  const lpArg = opt('launchpad');
  const launchpad = lpArg ? getAddress(lpArg) : rec?.launchpad ? getAddress(rec.launchpad) : null;
  const wallet = file => createWalletClient({ account: privateKeyToAccount(loadKey(file)), chain, transport });
  return { pub, local, keys, recFile, launchpad, wallet };
}

export function mineSalt(initCode, start = 0n) {
  const codeHash = keccak256(initCode);
  for (let i = start; ; i++) {
    const salt = pad(toHex(i), { size: 32 });
    const addr = '0x' + keccak256(concat(['0xff', CREATE2_DEPLOYER, salt, codeHash])).slice(26);
    if ((BigInt(addr) & 0x3fffn) === 0x2000n) return { salt, address: getAddress(addr) };
  }
}

const vaultAbi = [
  { type: 'function', name: 'TAG', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'CHAINS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

async function deploy() {
  const { pub, keys, recFile, wallet, local } = setup({ sends: !has('dry') });
  if (!keys) throw new Error('--keys DIR is required');
  const wal = wallet(path.join(keys, 'owner.txt'));
  const me = wal.account.address;
  const platform = getAddress(opt('platform', me));
  const vault = getAddress(opt('vault', BUNKER_VAULT));
  const fdv = Number(opt('fdv', '2'));
  if (!(fdv > 0.1 && fdv < 1000)) throw new Error('--fdv out of range');

  if (!(await pub.getCode({ address: CREATE2_DEPLOYER }))) throw new Error('no CREATE2 deployer on this chain');
  if (!(await pub.getCode({ address: POOL_MANAGER }))) throw new Error('no Uniswap v4 PoolManager on this chain');
  const [tag, chains] = await Promise.all([
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'TAG' }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'CHAINS' }),
  ]).catch(() => [null, null]);
  if (tag !== keccak256(toBytes('BunkerVault.execute.v1')) || chains !== 67n) throw new Error(`${vault} is not a BunkerVault`);

  const p = launchParams(fdv);
  const art = artifact('BunkerLaunchpad');
  const ctor = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }, { type: 'uint128' }],
    [POOL_MANAGER, vault, platform, p.sqrtPriceX96, p.tickUpper, p.liquidity],
  );
  const initCode = concat([art.bytecode, ctor]);
  const t0 = Date.now();
  const { salt, address } = mineSalt(initCode);
  console.log(`chain ${await pub.getChainId()}${local ? ' (local)' : ''} · deployer ${me} · balance ${formatEther(await pub.getBalance({ address: me }))} ETH`);
  console.log(`vault ${vault} · platform ${platform}`);
  console.log(`pool: tickUpper ${p.tickUpper} · start FDV ${p.startFdvEth.toFixed(4)} ETH · liquidity ${p.liquidity} · dust ${p.dust} wei`);
  console.log(`mined salt ${salt} in ${Date.now() - t0} ms → launchpad ${address}`);
  if (await pub.getCode({ address })) throw new Error(`${address} already has code`);
  if (has('dry')) return;

  const gas = await pub.estimateGas({ account: me, to: CREATE2_DEPLOYER, data: concat([salt, initCode]) });
  const hash = await wal.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initCode]), gas: (gas * 12n) / 10n });
  console.log(`tx ${hash}`);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !(await pub.getCode({ address }))) throw new Error('launchpad deploy failed');
  console.log(`BunkerLaunchpad ${address} · block ${r.blockNumber} · gas ${r.gasUsed}`);
  const out = {
    launchpad: address, salt, deployBlock: Number(r.blockNumber), tx: hash, vault, platform, deployer: me,
    tickUpper: p.tickUpper, sqrtPriceX96: p.sqrtPriceX96.toString(), liquidity: p.liquidity.toString(), fdvEth: fdv,
  };
  fs.writeFileSync(recFile, JSON.stringify(out, null, 2));
  console.log(`wrote ${recFile}`);
}

const stateViewAbi = [
  { type: 'function', name: 'getFeeGrowthInside', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'int24' }, { type: 'int24' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'function', name: 'getPositionInfo', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }, { type: 'int24' }, { type: 'int24' }, { type: 'bytes32' }], outputs: [{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }] },
];

/** Every coin with its uncollected fees (what collect() would pay out right now). */
async function coinsWithFees(pub, launchpad) {
  const { abi } = artifact('BunkerLaunchpad');
  const tokAbi = artifact('BunkerLaunchToken').abi;
  const [count, tickUpper] = await Promise.all([
    pub.readContract({ address: launchpad, abi, functionName: 'coinsCount' }),
    pub.readContract({ address: launchpad, abi, functionName: 'tickUpper' }),
  ]);
  const tokens = count ? await pub.readContract({ address: launchpad, abi, functionName: 'coinsSlice', args: [0n, count] }) : [];
  const M = (1n << 256n) - 1n;
  const out = [];
  for (const token of tokens) {
    const id = await pub.readContract({ address: launchpad, abi, functionName: 'poolId', args: [token] });
    const [g, p, sym] = await Promise.all([
      pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getFeeGrowthInside', args: [id, TICK_LOWER, tickUpper] }),
      pub.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getPositionInfo', args: [id, launchpad, TICK_LOWER, tickUpper, pad('0x00', { size: 32 })] }),
      pub.readContract({ address: token, abi: tokAbi, functionName: 'symbol' }),
    ]);
    const owed = (now, last) => (((now - last) & M) * p[0]) >> 128n;
    out.push({ token, symbol: sym, eth: owed(g[0], p[1]), tokens: owed(g[1], p[2]) });
  }
  return out;
}

async function status() {
  const { pub, launchpad } = setup({ sends: false });
  if (!launchpad) throw new Error('no launchpad: pass --launchpad or --keys');
  const { abi } = artifact('BunkerLaunchpad');
  const [platform, vault] = await Promise.all([
    pub.readContract({ address: launchpad, abi, functionName: 'platform' }),
    pub.readContract({ address: launchpad, abi, functionName: 'vault' }),
  ]);
  const coins = await coinsWithFees(pub, launchpad);
  console.log(`launchpad ${launchpad} · vault ${vault} · platform ${platform} · ${coins.length} coins`);
  let total = 0n;
  for (const c of coins) {
    total += c.eth;
    console.log(`  $${c.symbol.padEnd(12)} ${c.token}  uncollected ${formatEther(c.eth)} ETH + ${formatEther(c.tokens)} tokens`);
  }
  console.log(`uncollected ETH (all coins) ${formatEther(total)} · platform half ${formatEther(total - total / 2n)}`);
}

async function collect() {
  const { pub, keys, launchpad, wallet } = setup({ sends: true });
  if (!keys || !launchpad) throw new Error('--keys DIR and a launchpad (deployed or --launchpad) are required');
  const wal = wallet(path.join(keys, 'owner.txt'));
  const min = parseEther(opt('min', '0.001'));
  const { abi } = artifact('BunkerLaunchpad');
  const coins = (await coinsWithFees(pub, launchpad)).filter(c => c.eth >= min);
  if (!coins.length) return console.log('nothing above the minimum');
  for (const c of coins) {
    const { request } = await pub.simulateContract({ account: wal.account, address: launchpad, abi, functionName: 'collect', args: [c.token] });
    const hash = await wal.writeContract(request);
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(`$${c.symbol} collect ${hash} · ${r.status} · ${formatEther(c.eth)} ETH split 50/50`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const run = { deploy, status, collect }[cmd];
  if (!run) {
    console.error('usage: launchpad.mjs deploy|status|collect --rpc URL [--keys DIR] [--mainnet]');
    process.exit(1);
  }
  run().catch(e => {
    console.error(e.shortMessage ?? e.message ?? e);
    process.exit(1);
  });
}
