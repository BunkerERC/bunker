// BUNKER SWAP + RELAYER: deploy, watch, relay.
//
//   node launch/swap.mjs deploy  --rpc URL --keys DIR [--vault 0x..] [--router 0x..] [--platform 0x..] [--fee-bps 50] [--mainnet]
//   node launch/swap.mjs status  --rpc URL [--keys DIR | --swap 0x..]
//   node launch/swap.mjs collect --rpc URL --keys DIR [--mainnet]
//   node launch/swap.mjs relayer --rpc URL[,URL2] --key FILE --swap 0x.. [--vault 0x..] [--launchpad 0x..] [--token 0x..]
//                                [--port 8787] [--host 127.0.0.1] [--secret-file FILE] [--state FILE] [--origins a,b]
//                                [--flat 0.0001] [--markup 1.2] [--max-gwei 60] [--min-balance 0.002] [--rate-ip 12] [--rate-id 6]
//                                [--free-cap 0.0005] [--free-per-day 3] [--free-per-hour 10] [--mainnet]
//
// deploy: BunkerSwap(vault, Universal Router, platform, fee) from DIR/owner.txt. The fee is fixed forever.
//   Address saved to DIR/swap.json.
// collect: swap fees are pushed to the platform wallet with every swap. This only sends what could not be pushed.
// relayer: a small HTTP service with a hot wallet that only pays gas. It submits signed bunker withdrawals and
//   bunker swaps for people who have no funded wallet, and is paid by the fee / tip inside the signed message. It
//   can not change a recipient, an amount or a route: everything is fixed by the hash signature. Anyone else could
//   submit the same message, so nobody depends on it.
//     GET  /info   what it charges right now
//     POST /relay  {kind:'withdraw', id, nonce, transfers, fee, nextKey, sig}
//                  {kind:'swap', order, nextKey, sig, commands, inputs}
//   A swap it accepted is watched until it lands: if the price moves away, the same signature is sent again after
//   the order's deadline, which hands the funds back and frees the bunker's key.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, http as httpTransport, fallback, getAddress, isAddress, isHex, formatEther,
  formatGwei, parseEther, parseGwei, parseAbi, zeroAddress, encodeFunctionData, BaseError, ContractFunctionRevertedError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const art = n => JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', `${n}.sol`, `${n}.json`), 'utf8'));

export const MAINNET_VAULT = '0x39C71b635409b1f98dc632e08d3B29515ddb2727';
export const UNIVERSAL_ROUTER = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af';
const MAINNET_TOKEN = '0xBDC4cE7c4718d20498e7D549751FF336690eb6D7';
const MAINNET_LAUNCHPAD = '0xe5871db88A72e4B18Fe37175C4774718aB356000';
/** Tokens the relayer swaps besides $BUNKER and launchpad coins (all checked on-chain, see site/src/chains.ts). */
const MAJORS = [
  '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
  '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
  '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
  '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
];

const ERRORS = [
  'error UnknownAccount()', 'error BadSignature()', 'error BadNextKey()', 'error NotRelayer()',
  'error Insufficient(address token)', 'error BadTransfer()', 'error NothingReceived()', 'error Locked()',
  'error ClaimFailed()', 'error OutOfGas()', 'error BadOrder()', 'error BadRoute()', 'error BadConfig()',
  'error NothingThere()', 'error TooLittle(uint256 out)', 'error BoxFailed()', 'error PayFailed()',
  'error NotPlatform()', 'error NotSelf()', 'error NotSubmitter()', 'error TokenCallFailed()',
];
export const VAULT_ABI = parseAbi([
  'struct Transfer { address token; address to; uint256 amount; }',
  'function accounts(bytes32 id) view returns (bytes32 key, uint64 nonce)',
  'function balanceOf(bytes32 id, address token) view returns (uint256)',
  'function execute(bytes32 id, Transfer[] transfers, address relayer, uint256 fee, bytes32 nextKey, bytes32[67] sig)',
  ...ERRORS,
]);
export const SWAP_ABI = parseAbi([
  'struct Order { bytes32 id; uint64 nonce; address tokenIn; address tokenOut; uint256 amountIn; uint256 minOut; uint256 tip; address submitter; uint64 deadline; bytes32 route; }',
  'function run(Order o, bytes32 nextKey, bytes32[67] sig, bytes commands, bytes[] inputs)',
  'function rescue(Order o, address token) returns (uint256)',
  'function boxOf(Order o) view returns (address)',
  'function collect()',
  'function owed() view returns (uint256)',
  'function platform() view returns (address)',
  'function FEE_BPS() view returns (uint256)',
  'function VAULT() view returns (address)',
  'function ROUTER() view returns (address)',
  'function BOX() view returns (address)',
  'event Swapped(bytes32 indexed id, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 tip, address submitter)',
  'event Returned(bytes32 indexed id, address indexed token, uint256 amount, address submitter)',
  'event Stranded(bytes32 indexed id, address indexed token, address box)',
  ...ERRORS,
]);
const LAUNCHPAD_ABI = parseAbi(['function tokenAddress(bytes32 identity, uint32 leaf) view returns (address)', 'function identityOf(address token) view returns (bytes32)']);
const COINS_ABI = [{ type: 'function', name: 'coins', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }],
  outputs: [{ name: 'identity', type: 'bytes32' }, { name: 'creator', type: 'address' }, { name: 'leaf', type: 'uint32' },
    { name: 'launchedAt', type: 'uint64' }, { name: 'feeTo', type: 'address' }, { name: 'launchBlock', type: 'uint64' },
    { name: 'feeVault', type: 'bytes32' }] }];
void LAUNCHPAD_ABI;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, fallbackValue) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return fallbackValue;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
};
const flag = name => args.includes('--' + name);
const isLocal = url => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url);
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const say = (...a) => console.log(stamp(), ...a);
const short = h => (h && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h);

function loadKey(file) {
  const key = fs.readFileSync(file, 'utf8').match(/0x[0-9a-fA-F]{64}/)?.[0];
  if (!key) throw new Error(`${file} holds no private key`);
  return key;
}
const readJson = (file, fallbackValue) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallbackValue; } };

function setup() {
  const rpc = opt('rpc');
  if (!rpc) throw new Error('--rpc is required');
  const urls = rpc.split(',').map(u => u.trim()).filter(Boolean); // several = fallback in order
  const transport = urls.length > 1 ? fallback(urls.map(u => httpTransport(u))) : httpTransport(urls[0]);
  // local only if EVERY endpoint is local: a fallback list must never slip a real-chain RPC past the --mainnet check
  const localCount = urls.filter(isLocal).length;
  if (localCount && localCount !== urls.length) throw new Error('--rpc mixes local and remote endpoints; use one kind');
  const local = localCount === urls.length;
  if (!local && !flag('mainnet') && cmd !== 'status') throw new Error('This is real Ethereum mainnet. Add --mainnet to send real transactions.');
  const pub = createPublicClient({ chain: mainnet, transport, pollingInterval: local ? 100 : 2000 });
  const keys = opt('keys');
  const recFile = keys && path.join(keys, local ? 'swap-fork.json' : 'swap.json');
  const rec = recFile ? readJson(recFile, {}) : {};
  const swap = opt('swap') ?? rec.swap;
  const wallet = file => createWalletClient({ account: privateKeyToAccount(loadKey(file)), chain: mainnet, transport });
  return { rpc, local, pub, keys, recFile, rec, swap: swap && getAddress(swap), wallet };
}

async function send(pub, wal, req) {
  const hash = await wal.writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${req.functionName} reverted: ${hash}`);
  return r;
}

// ------------------------------------------------------------------ deploy / status / collect

async function deploy() {
  const { pub, keys, recFile, wallet, local } = setup();
  if (!keys) throw new Error('--keys DIR is required');
  const wal = wallet(path.join(keys, 'owner.txt'));
  const vault = getAddress(opt('vault', MAINNET_VAULT));
  const router = getAddress(opt('router', UNIVERSAL_ROUTER));
  const platform = getAddress(opt('platform', wal.account.address));
  const feeBps = BigInt(opt('fee-bps', '50'));
  if (feeBps > 100n) throw new Error('--fee-bps can be 100 (1%) at most');
  for (const [name, a] of [['vault', vault], ['router', router]])
    if (!(await pub.getCode({ address: a }))) throw new Error(`no contract at the ${name} address ${a}`);
  const prior = readJson(recFile, null);
  if (prior?.swap && (await pub.getCode({ address: prior.swap })) && !flag('again'))
    throw new Error(`already deployed at ${prior.swap} (${recFile}). Add --again to deploy another one.`);

  const a = art('BunkerSwap');
  say(`deploying BunkerSwap from ${wal.account.address}  vault ${vault}  router ${router}  platform ${platform}  fee ${feeBps} bps`);
  const hash = await wal.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args: [vault, router, platform, feeBps] });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy reverted: ${hash}`);
  const swap = getAddress(r.contractAddress);
  const box = await pub.readContract({ address: swap, abi: SWAP_ABI, functionName: 'BOX' });
  const rec = { swap, box, vault, router, platform, feeBps: Number(feeBps), block: Number(r.blockNumber), tx: hash, chain: local ? 'fork' : 'mainnet' };
  fs.writeFileSync(recFile, JSON.stringify(rec, null, 2));
  say(`BunkerSwap ${swap}  (block ${r.blockNumber}, ${r.gasUsed} gas)  box code ${box}`);
  say(`saved ${recFile}`);
  return rec;
}

async function status() {
  const { pub, swap, rec } = setup();
  if (!swap) throw new Error('no swap address: pass --swap or --keys');
  const read = fn => pub.readContract({ address: swap, abi: SWAP_ABI, functionName: fn });
  const [fee, platform, owed, vault, router] = await Promise.all([read('FEE_BPS'), read('platform'), read('owed'), read('VAULT'), read('ROUTER')]);
  console.log(`BunkerSwap ${swap}`);
  console.log(`  vault ${vault}  router ${router}`);
  console.log(`  fee ${Number(fee) / 100}%  ->  platform ${platform}`);
  console.log(`  not yet paid out: ${formatEther(owed)} ETH${owed > 0n ? '  (run collect)' : ''}`);
  if (rec.block) {
    try {
      const logs = await pub.getLogs({ address: swap, event: SWAP_ABI.find(x => x.name === 'Swapped'), fromBlock: BigInt(rec.block), toBlock: 'latest' });
      const fees = logs.reduce((s, l) => s + l.args.fee, 0n);
      console.log(`  swaps ${logs.length}  fees earned ${formatEther(fees)} ETH  bunkers ${new Set(logs.map(l => l.args.id)).size}`);
    } catch (e) {
      console.log(`  (could not read the swap log: ${e.shortMessage ?? e.message})`);
    }
  }
}

async function collect() {
  const { pub, swap, keys, wallet } = setup();
  if (!swap || !keys) throw new Error('--keys DIR is required');
  const owed = await pub.readContract({ address: swap, abi: SWAP_ABI, functionName: 'owed' });
  if (owed === 0n) return say('nothing to collect: every swap fee was already paid straight to the platform wallet');
  const wal = wallet(path.join(keys, 'owner.txt'));
  const r = await send(pub, wal, { address: swap, abi: SWAP_ABI, functionName: 'collect' });
  say(`collected ${formatEther(owed)} ETH  tx ${r.transactionHash}`);
}

// ------------------------------------------------------------------ relayer

/** Gas the relayer quotes with. Higher than a typical run, so a quote usually covers the real cost with room. */
export const GAS = { withdraw: 190_000, perEth: 45_000, perToken: 80_000, buy: 650_000, sell: 520_000 };

class Refuse extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const B32 = /^0x[0-9a-fA-F]{64}$/;
const need = (ok, msg) => { if (!ok) throw new Refuse(400, msg); };
const uint = (v, name) => {
  need(typeof v === 'string' && /^\d{1,78}$/.test(v), `${name} must be a decimal string`);
  return BigInt(v);
};
const addr = (v, name) => { need(typeof v === 'string' && isAddress(v), `${name} must be an address`); return getAddress(v); };
const b32 = (v, name) => { need(typeof v === 'string' && B32.test(v), `${name} must be 32 bytes of hex`); return v; };
const sigOf = v => { need(Array.isArray(v) && v.length === 67 && v.every(x => typeof x === 'string' && B32.test(x)), 'sig must be 67 hashes'); return v; };

function revertName(e) {
  if (e instanceof BaseError) {
    const r = e.walk(x => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? r.shortMessage;
    return e.shortMessage;
  }
  return e?.message ?? String(e);
}
const WHY = {
  BadSignature: 'The signature does not match this message and the bunker\'s current key.',
  UnknownAccount: 'That bunker does not exist.',
  Insufficient: 'The bunker does not hold enough for this.',
  TooLittle: 'The price moved: the swap would return less than the minimum you signed.',
  BadRoute: 'The route does not match the signed order.',
  BadOrder: 'The order is not valid (one side must be ETH, and the amount must cover the fee and the tip).',
  NothingThere: 'Nothing arrived to swap.',
  BadNextKey: 'The next key is not valid.',
  NotRelayer: 'This message is locked to another submitter.',
  NotSubmitter: 'This order is locked to another submitter.',
};

async function relayer() {
  const { pub, local, wallet, swap } = setup();
  const keyFile = opt('key');
  if (!keyFile) throw new Error('--key FILE is required (a small hot wallet that only pays gas)');
  if (!swap) throw new Error('--swap 0x.. is required');
  const wal = wallet(keyFile);
  const me = wal.account.address;
  const vault = getAddress(opt('vault', MAINNET_VAULT));
  const launchpad = opt('launchpad', local ? undefined : MAINNET_LAUNCHPAD);
  const allow = new Set([opt('token', local ? undefined : MAINNET_TOKEN), ...MAJORS, ...(opt('allow', '') || '').split(',')]
    .filter(Boolean).map(a => getAddress(a.trim()).toLowerCase()));
  const port = Number(opt('port', '8787'));
  const host = opt('host', '127.0.0.1');
  const secret = opt('secret-file') ? fs.readFileSync(opt('secret-file'), 'utf8').trim() : '';
  const stateFile = opt('state');
  const origins = (opt('origins', '') || '').split(',').map(s => s.trim()).filter(Boolean);
  const flat = parseEther(opt('flat', '0.0001'));
  const markup = BigInt(Math.round(Number(opt('markup', '1.2')) * 100));
  const maxBase = parseGwei(opt('max-gwei', '60'));
  const minBalance = parseEther(opt('min-balance', '0.002'));
  // An expired order that can not pay a tip (its input is a token) is handed back at the relayer's own cost, so the
  // bunker's key is not left hanging. That is a gift, so it is rationed: a ceiling per trip, per bunker and per hour.
  const freeCap = parseEther(opt('free-cap', '0.0005'));
  const freeDay = Number(opt('free-per-day', '3'));
  const freeHour = Number(opt('free-per-hour', '10'));
  const minTip = parseGwei(opt('min-tip-gwei', '0.05'));
  const maxTip = parseGwei(opt('tip-gwei', '2'));
  const rateIp = Number(opt('rate-ip', '12')); // relay posts per minute from one address
  const rateId = Number(opt('rate-id', '6')); // ...and for one bunker

  if ((await pub.readContract({ address: swap, abi: SWAP_ABI, functionName: 'VAULT' })).toLowerCase() !== vault.toLowerCase())
    throw new Error('that BunkerSwap is not for this vault');

  // ---- gas price (cached a few seconds)
  let fees = { at: 0 };
  async function gas(fresh) {
    if (!fresh && Date.now() - fees.at < 4000) return fees;
    const [block, prioRaw, balance] = await Promise.all([
      pub.getBlock({ blockTag: 'latest' }),
      pub.estimateMaxPriorityFeePerGas().catch(() => minTip),
      pub.getBalance({ address: me }),
    ]);
    const base = block.baseFeePerGas ?? 0n;
    const prio = prioRaw < minTip ? minTip : prioRaw > maxTip ? maxTip : prioRaw;
    fees = {
      at: Date.now(), base, prio, balance, time: block.timestamp,
      cost: (base * 110n) / 100n + prio, // what a transaction really costs per gas, with a little room
      quote: (((base * 125n) / 100n + prio) * markup) / 100n, // what it asks per gas
    };
    return fees;
  }
  const pausedWhy = f => (f.balance < minBalance ? 'The relayer is out of gas money. Use a wallet to submit.'
    : f.base > maxBase ? 'Gas is too high for the relayer right now. Use a wallet to submit.' : null);

  // ---- which tokens it swaps
  const coinCache = new Map();
  async function swappable(token) {
    const k = token.toLowerCase();
    if (allow.has(k)) return true;
    if (!launchpad) return false;
    if (coinCache.has(k)) return coinCache.get(k);
    let ok = false;
    try {
      const c = await pub.readContract({ address: getAddress(launchpad), abi: COINS_ABI, functionName: 'coins', args: [token] });
      ok = BigInt(c[0]) !== 0n;
    } catch { ok = false; }
    if (ok) coinCache.set(k, true); // only cache a yes: a coin can be launched later
    return ok;
  }

  // ---- limits
  const hits = new Map();
  function limit(key, max, windowMs) {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter(t => now - t < windowMs);
    if (list.length >= max) throw new Refuse(429, 'Too many requests. Try again in a minute.');
    list.push(now);
    hits.set(key, list);
  }
  setInterval(() => { const now = Date.now(); for (const [k, l] of hits) if (!l.some(t => now - t < 3_600_000)) hits.delete(k); }, 600_000).unref();

  // ---- what is in flight
  /** key `${id}:${nonce}` -> { body, hash, sentAt, tries, firstAt } */
  const pending = new Map(Object.entries(stateFile ? readJson(stateFile, {}) : {}));
  const persist = () => { if (stateFile) try { fs.writeFileSync(stateFile, JSON.stringify(Object.fromEntries(pending))); } catch (e) { say('state write failed:', e.message); } };

  function parse(b) {
    need(b && typeof b === 'object', 'send JSON');
    const nextKey = b32(b.nextKey, 'nextKey');
    const sig = sigOf(b.sig);
    if (b.kind === 'withdraw') {
      const id = b32(b.id, 'id');
      const nonce = uint(String(b.nonce), 'nonce');
      const fee = uint(b.fee, 'fee');
      need(Array.isArray(b.transfers) && b.transfers.length >= 1 && b.transfers.length <= 8, 'transfers: 1 to 8');
      const transfers = b.transfers.map((t, i) => ({ token: addr(t.token, `transfers[${i}].token`), to: addr(t.to, `transfers[${i}].to`), amount: uint(t.amount, `transfers[${i}].amount`) }));
      return { kind: 'withdraw', id, nonce, pay: fee, transfers,
        req: { address: vault, abi: VAULT_ABI, functionName: 'execute', args: [id, transfers, zeroAddress, fee, nextKey, sig] } };
    }
    if (b.kind === 'swap') {
      const o = b.order;
      need(o && typeof o === 'object', 'order missing');
      const order = {
        id: b32(o.id, 'order.id'), nonce: uint(String(o.nonce), 'order.nonce'), tokenIn: addr(o.tokenIn, 'order.tokenIn'),
        tokenOut: addr(o.tokenOut, 'order.tokenOut'), amountIn: uint(o.amountIn, 'order.amountIn'), minOut: uint(o.minOut, 'order.minOut'),
        tip: uint(o.tip, 'order.tip'), submitter: addr(o.submitter, 'order.submitter'), deadline: uint(String(o.deadline), 'order.deadline'),
        route: b32(o.route, 'order.route'),
      };
      need(typeof b.commands === 'string' && isHex(b.commands) && b.commands.length <= 2 + 2 * 16, 'commands: up to 16 bytes of hex');
      need(Array.isArray(b.inputs) && b.inputs.length <= 16 && b.inputs.every(x => typeof x === 'string' && isHex(x)), 'inputs: hex strings');
      need(b.inputs.reduce((n, x) => n + x.length, 0) <= 2 * 8192, 'inputs too large');
      return { kind: 'swap', id: order.id, nonce: order.nonce, order,
        req: { address: swap, abi: SWAP_ABI, functionName: 'run', args: [order, nextKey, sig, b.commands, b.inputs] } };
    }
    throw new Refuse(400, 'kind must be withdraw or swap');
  }

  let queue = Promise.resolve();
  const inLine = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  /** Checks a message and sends it. `again` = a retry by the watcher (no rate limits, no "already in flight"). */
  async function submit(body, again) {
    const m = parse(body);
    const key = `${m.id}:${m.nonce}`.toLowerCase();
    const f = await gas(m.kind === 'swap'); // a swap turns into a hand-back at its deadline: judge it on the latest block
    const [, nonceNow] = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'accounts', args: [m.id] });
    if (nonceNow > m.nonce) { pending.delete(key); persist(); return { done: true }; }
    need(nonceNow === m.nonce, 'That key is not the bunker\'s current one.');
    const prior = pending.get(key);
    if (prior && !again) {
      if (JSON.stringify(prior.body) !== JSON.stringify(body)) throw new Refuse(409, 'This key already has a different signed message in flight here.');
      if (Date.now() - prior.sentAt < 60_000) return { hash: prior.hash, pending: true };
    }
    const why = pausedWhy(f);
    if (why) throw new Refuse(503, why);

    let pay = m.pay;
    let expired = false;
    if (m.kind === 'swap') {
      const o = m.order;
      expired = f.time > o.deadline;
      const token = o.tokenIn === zeroAddress ? o.tokenOut : o.tokenIn;
      if (!expired) {
        need((o.tokenIn === zeroAddress) !== (o.tokenOut === zeroAddress), 'One side of a swap must be ETH.');
        need(o.submitter === zeroAddress || o.submitter === me, 'This order is locked to another submitter.');
        need(o.deadline - f.time <= 3600n, 'The deadline is too far away: an order can be swapped for one hour at most.');
        if (!(await swappable(token)))
          throw new Refuse(403, 'The relayer only swaps $BUNKER, launchpad coins and the big tokens. Submit this one with a wallet.');
        pay = o.tip;
      } else {
        pay = o.tokenIn === zeroAddress && o.tip < o.amountIn ? o.tip : 0n; // a tip is only ever paid out of returned ETH
      }
    }

    let est;
    try {
      est = await pub.estimateContractGas({ ...m.req, account: me });
    } catch (e) {
      const name = revertName(e);
      throw new Refuse(422, WHY[name] ?? `It would fail on-chain: ${name}`, { reason: name });
    }
    // `est` is the smallest gas LIMIT that works. The vault wants a fixed reserve of gas in hand before each send
    // (so a submitter can not starve one), which makes that limit far higher than what gets burned. Unused gas is
    // refunded, so the price of the trip is the gas actually used.
    const gasLimit = (est * 125n) / 100n + 30_000n;
    const maxFee = f.base * 2n + f.prio;
    let used = est;
    try {
      // with an explicit gas limit and price: some nodes otherwise assume a whole block of gas and refuse on balance
      const r = await pub.createAccessList({ account: me, to: m.req.address, data: encodeFunctionData(m.req), gas: gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: f.prio });
      if (r.gasUsed > 0n && r.gasUsed < est) used = (r.gasUsed * 110n) / 100n;
    } catch { /* node without eth_createAccessList: fall back to the limit */ }
    const cost = used * f.cost;
    if (f.balance < gasLimit * maxFee) throw new Refuse(503, 'The relayer is low on gas money right now. Use a wallet to submit.');
    if (pay < cost) {
      if (!(m.kind === 'swap' && expired && cost <= freeCap))
        throw new Refuse(402, 'The fee in this message no longer covers the gas. Submit it with a wallet, or try again when gas is lower.',
          { need: cost.toString(), have: pay.toString() });
      try {
        limit(`free:${m.id.toLowerCase()}`, freeDay, 86_400_000);
        limit('free:all', freeHour, 3_600_000);
      } catch {
        throw new Refuse(429, 'The relayer has handed back enough expired orders for free for now. Take this one back with a wallet.');
      }
    }

    const hash = await inLine(() => wal.writeContract({ ...m.req, gas: gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: f.prio }));
    pending.set(key, { body, hash, sentAt: Date.now(), firstAt: prior?.firstAt ?? Date.now(), tries: (prior?.tries ?? 0) + 1, kind: m.kind });
    persist();
    say(`${again ? 're-sent' : 'sent'} ${m.kind}${expired ? ' (hand back)' : ''}  bunker ${short(m.id)} key #${m.nonce}  pays ${formatEther(pay)}  gas ~${used} @ ${formatGwei(f.base)} gwei  ${hash}`);
    return { hash };
  }

  // ---- watcher: everything accepted is followed until its key is used on-chain
  async function watch() {
    for (const [key, p] of [...pending]) {
      try {
        const [id, nonce] = key.split(':');
        const [, nonceNow] = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'accounts', args: [id] });
        if (nonceNow > BigInt(nonce)) { pending.delete(key); persist(); say(`landed  bunker ${short(id)} key #${nonce}`); continue; }
        const age = Date.now() - p.sentAt;
        if (Date.now() - p.firstAt > 86_400_000 || p.tries > 40) { pending.delete(key); persist(); say(`gave up  bunker ${short(id)} key #${nonce}`); continue; }
        if (age < 90_000) continue;
        const receipt = await pub.getTransactionReceipt({ hash: p.hash }).catch(() => null);
        if (receipt?.status === 'success') continue; // mined; the nonce read catches up next round
        p.sentAt = Date.now(); // one attempt per 90 s, whatever happens
        await submit(p.body, true).catch(e => { if (!(e instanceof Refuse)) say(`retry failed  ${short(id)} #${nonce}:`, e.shortMessage ?? e.message); });
      } catch (e) {
        say('watch error:', e.shortMessage ?? e.message);
      }
    }
  }
  if (!flag('no-watch')) setInterval(() => watch().catch(() => {}), local ? 2000 : 12_000).unref();

  // ---- http
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = origin && (local || origins.includes(origin)) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
    const reply = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
        return res.end();
      }
      if (secret && req.headers['x-relay-key'] !== secret) return reply(403, { error: 'forbidden' });
      const url = new URL(req.url, 'http://x');
      const ip = (secret && req.headers['x-client-ip']) || req.socket.remoteAddress || '?';

      if (req.method === 'GET' && (url.pathname === '/info' || url.pathname === '/')) {
        limit(`info:${ip}`, 120, 60_000);
        const f = await gas();
        return reply(200, {
          ok: true, relayer: me, chainId: 1, vault, swap, paused: pausedWhy(f),
          gasPrice: f.quote.toString(), flat: flat.toString(), gas: GAS, baseFee: f.base.toString(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/relay') {
        limit(`relay:${ip}`, rateIp, 60_000);
        limit('relay:all', 240, 3_600_000);
        const chunks = [];
        let size = 0;
        for await (const c of req) { size += c.length; if (size > 65_536) throw new Refuse(413, 'too large'); chunks.push(c); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Refuse(400, 'send JSON'); }
        const id = body?.kind === 'swap' ? body?.order?.id : body?.id;
        if (typeof id === 'string') limit(`relay:id:${id.toLowerCase()}`, rateId, 60_000);
        return reply(200, { ok: true, ...(await submit(body, false)) });
      }
      return reply(404, { error: 'not found' });
    } catch (e) {
      if (e instanceof Refuse) return reply(e.status, { error: e.message, ...e.extra });
      say('error:', e.shortMessage ?? e.message);
      return reply(500, { error: 'The relayer hit an error. Try again, or submit with a wallet.' });
    }
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, host, ok); });
  const f = await gas();
  say(`relayer ${me} on ${host}:${port}  balance ${formatEther(f.balance)} ETH  vault ${vault}  swap ${swap}  base fee ${formatGwei(f.base)} gwei${secret ? '  (key required)' : ''}`);
  if (pending.size) say(`${pending.size} message(s) still in flight from before the restart`);
  return server;
}

// ------------------------------------------------------------------ cli

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const run = { deploy, status, collect, relayer }[cmd];
  if (!run) {
    console.error('usage: node launch/swap.mjs deploy|status|collect|relayer --rpc URL ...   (see the top of this file)');
    process.exit(1);
  }
  run().catch(e => {
    console.error(`ERROR: ${e.shortMessage ?? e.message}`);
    process.exit(1);
  });
}
