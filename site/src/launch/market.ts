// Everything the site shows comes from Ethereum itself: the launchpad's storage and logs, Uniswap v4's StateView,
// the v4 Quoter and Chainlink. No indexer, no backend, no database.
import { decodeEventLog, encodeAbiParameters, getAddress, keccak256, zeroAddress, type Hex, type Log } from 'viem';
import launchpadAbi from './abi/BunkerLaunchpad';
import tokenAbi from './abi/BunkerLaunchToken';
import { feedAbi, quoterAbi, stateViewAbi, swapEvent, transferEvent } from './abi/external';
import { client as chainClient } from '../chains';
import { DEPLOY_BLOCK, ETH_USD_FEED, FEE, LAUNCHPAD, POOL_MANAGER, STATE_VIEW, TICK_LOWER, TICK_SPACING, V4_QUOTER } from './config';
import { cget, cset } from './cache';

export const client = chainClient(1);

export const lp = () => {
  if (!LAUNCHPAD) throw new Error('Launchpad not deployed yet.');
  return LAUNCHPAD;
};

export function poolKey(token: Hex) {
  return { currency0: zeroAddress, currency1: token, fee: FEE, tickSpacing: TICK_SPACING, hooks: lp() } as const;
}

export function poolIdOf(token: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [zeroAddress, token, FEE, TICK_SPACING, lp()],
    ),
  );
}

/** ETH per whole token from the pool's sqrtPriceX96 (token is currency1, both 18 decimals). */
export function priceFromSqrt(sqrtPriceX96: bigint): number {
  const x = Number(sqrtPriceX96) / 2 ** 96;
  return 1 / (x * x);
}

export interface CoinRow {
  token: Hex;
  name: string;
  symbol: string;
  identity: Hex;
  creator: Hex;
  leaf: number;
  launchedAt: number;
  launchBlock: bigint;
  feeTo: Hex;
  feeVault: Hex;
  poolId: Hex;
  sqrtPriceX96: bigint;
  priceEth: number;
  mcapEth: number;
}

type CoinTuple = readonly [Hex, Hex, number, bigint, Hex, bigint, Hex];
type MC = { status: 'success' | 'failure'; result?: unknown };

export async function loadCoins(): Promise<CoinRow[]> {
  const LP = lp();
  const count = Number(await client.readContract({ address: LP, abi: launchpadAbi, functionName: 'coinsCount' }));
  if (!count) return [];
  const addrs: Hex[] = [];
  for (let from = 0; from < count; from += 500) {
    const part = (await client.readContract({
      address: LP,
      abi: launchpadAbi,
      functionName: 'coinsSlice',
      args: [BigInt(from), 500n],
    })) as readonly Hex[];
    addrs.push(...part);
  }
  const calls = addrs.flatMap(t => [
    { address: LP, abi: launchpadAbi, functionName: 'coins', args: [t] },
    { address: t, abi: tokenAbi, functionName: 'name' },
    { address: t, abi: tokenAbi, functionName: 'symbol' },
    { address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [poolIdOf(t)] },
  ]);
  const res = (await client.multicall({ contracts: calls, allowFailure: true } as never)) as unknown as MC[];
  const rows: CoinRow[] = [];
  addrs.forEach((t, i) => {
    const [c, n, s, slot] = res.slice(i * 4, i * 4 + 4);
    if (c.status !== 'success') return;
    const [identity, creator, leaf, launchedAt, feeTo, launchBlock, feeVault] = c.result as unknown as CoinTuple;
    const sqrt = slot.status === 'success' ? (slot.result as unknown as readonly [bigint])[0] : 0n;
    const priceEth = sqrt ? priceFromSqrt(sqrt) : 0;
    rows.push({
      token: t,
      name: n.status === 'success' ? String(n.result) : '?',
      symbol: s.status === 'success' ? String(s.result) : '?',
      identity,
      creator,
      leaf: Number(leaf),
      launchedAt: Number(launchedAt),
      launchBlock,
      feeTo,
      feeVault,
      poolId: poolIdOf(t),
      sqrtPriceX96: sqrt,
      priceEth,
      mcapEth: priceEth * 1e9,
    });
  });
  return rows.reverse(); // newest first
}

export async function ethUsd(): Promise<number> {
  const r = await client.readContract({ address: ETH_USD_FEED, abi: feedAbi, functionName: 'latestRoundData' });
  return Number(r[1]) / 1e8;
}

// ---------------------------------------------------------------- swaps (v4 PoolManager Swap events)

export interface Swap {
  block: bigint;
  tx: Hex;
  logIndex: number;
  buy: boolean;
  eth: number; // ETH moved (paid on buys, received on sells), fee included
  tokens: number;
  priceEth: number; // after the swap
  preEth: number; // before the swap (derived from the pool math)
  sender: Hex;
}

function toSwap(l: Log): Swap {
  const { args } = decodeEventLog({ abi: [swapEvent], data: l.data, topics: l.topics }) as unknown as {
    args: { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; sender: Hex };
  };
  const buy = args.amount0 < 0n;
  const sp = Number(args.sqrtPriceX96) / 2 ** 96;
  const L = Number(args.liquidity);
  const a0 = Math.abs(Number(args.amount0));
  const a1 = Math.abs(Number(args.amount1));
  // single position: buy → tokens out = L·(√pre − √post); sell → ETH out = L·(1/√pre − 1/√post)
  const spPre = L > 0 ? (buy ? sp + a1 / L : 1 / (1 / sp + a0 / L)) : sp;
  return {
    block: l.blockNumber!,
    tx: l.transactionHash!,
    logIndex: l.logIndex!,
    buy,
    eth: a0 / 1e18,
    tokens: a1 / 1e18,
    priceEth: 1 / (sp * sp),
    preEth: 1 / (spPre * spPre),
    sender: args.sender,
  };
}

/** eth_getLogs over a long range in chunks, halving the chunk when the RPC refuses. */
async function chunkedLogs(q: Record<string, unknown>, from: bigint, to: bigint): Promise<Log[]> {
  const out: Log[] = [];
  let step = 49_999n;
  let start = from;
  while (start <= to) {
    const end = start + step > to ? to : start + step;
    try {
      out.push(...((await client.getLogs({ ...q, fromBlock: start, toBlock: end } as never)) as Log[]));
      start = end + 1n;
    } catch (e) {
      if (step < 500n) throw e;
      step /= 4n;
    }
  }
  return out;
}

export async function swapsSince(poolIds: Hex[], from: bigint, to?: bigint): Promise<Swap[]> {
  if (!poolIds.length) return [];
  const latest = to ?? (await client.getBlockNumber());
  const logs = await chunkedLogs(
    { address: POOL_MANAGER, event: swapEvent, args: { id: poolIds } },
    from > DEPLOY_BLOCK ? from : DEPLOY_BLOCK,
    latest,
  );
  return logs.map(toSwap);
}

export interface Stats24 {
  vol: number;
  trades: number;
  change: number | null;
}

/** 24h volume / trades / change for many pools with one eth_getLogs. */
export async function stats24(coins: CoinRow[]): Promise<Record<string, Stats24>> {
  if (!coins.length) return {};
  const latest = await client.getBlockNumber();
  const from = latest > 7_300n ? latest - 7_300n : 0n;
  const ids = coins.map(c => c.poolId);
  const logs = (await client.getLogs({
    address: POOL_MANAGER,
    event: swapEvent,
    args: { id: ids },
    fromBlock: from > DEPLOY_BLOCK ? from : DEPLOY_BLOCK,
    toBlock: latest,
  } as never)) as Log[];
  const out: Record<string, Stats24> = {};
  for (const c of coins) out[c.poolId] = { vol: 0, trades: 0, change: null };
  const first: Record<string, number> = {};
  for (const l of logs) {
    const id = (l.topics[1] as Hex).toLowerCase();
    const key = ids.find(x => x.toLowerCase() === id);
    if (!key) continue;
    const s = toSwap(l);
    out[key].vol += s.eth;
    out[key].trades += 1;
    if (first[key] === undefined) first[key] = s.preEth;
  }
  const dayAgo = Date.now() / 1000 - 86_400;
  for (const c of coins) {
    const ref = c.launchedAt > dayAgo ? startPriceEth() : first[c.poolId];
    if (ref && c.priceEth) out[c.poolId].change = (c.priceEth / ref - 1) * 100;
  }
  return out;
}

let START_PRICE = 0;
export const startPriceEth = () => START_PRICE;
let TICK_UPPER = 0;
export async function launchShape() {
  if (TICK_UPPER) return { tickUpper: TICK_UPPER, startPriceEth: START_PRICE };
  const [sqrt, tick] = await Promise.all([
    client.readContract({ address: lp(), abi: launchpadAbi, functionName: 'startSqrtPriceX96' }),
    client.readContract({ address: lp(), abi: launchpadAbi, functionName: 'tickUpper' }),
  ]);
  START_PRICE = priceFromSqrt(sqrt as bigint);
  TICK_UPPER = Number(tick);
  return { tickUpper: TICK_UPPER, startPriceEth: START_PRICE };
}

// ---------------------------------------------------------------- one coin

export interface LaunchInfo {
  token: Hex;
  name: string;
  symbol: string;
  meta: { description?: string; website?: string; x?: string; telegram?: string };
  metaRaw: string;
  devBuy: bigint;
  devTokens: bigint;
  creator: Hex;
  identity: Hex;
  leaf: number;
  devTo: Hex;
  devVault: Hex;
  feeTo: Hex;
  feeVault: Hex;
  digest: Hex;
  seed: Hex;
  root: Hex;
  wots: Hex[];
  auth: Hex[];
  image: Hex;
  tx: Hex;
  block: bigint;
}

/** Every log of a launch sits in its launch block: one eth_getLogs, cached forever (it never changes). */
export async function launchInfo(token: Hex, launchBlock: bigint): Promise<LaunchInfo | null> {
  const key = `launch:${lp()}:${token}`.toLowerCase();
  const hit = await cget<LaunchInfo>(key);
  if (hit) return hit;
  const logs = await client.getLogs({ address: lp(), fromBlock: launchBlock, toBlock: launchBlock });
  const info: Partial<LaunchInfo> = { token };
  for (const l of logs) {
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi: launchpadAbi, data: l.data, topics: l.topics }) as never;
    } catch {
      continue;
    }
    if (String(ev.args.token ?? '').toLowerCase() !== token.toLowerCase()) continue;
    const a = ev.args as Record<string, never>;
    if (ev.eventName === 'Launched') {
      Object.assign(info, {
        name: a.name,
        symbol: a.symbol,
        metaRaw: a.meta,
        devBuy: a.devBuy,
        devTokens: a.devTokens,
        creator: a.creator,
        identity: a.identity,
        leaf: Number(a.leaf),
        tx: l.transactionHash,
        block: l.blockNumber,
      });
      try {
        info.meta = JSON.parse(a.meta || '{}');
      } catch {
        info.meta = {};
      }
    } else if (ev.eventName === 'Payees') {
      Object.assign(info, { devTo: a.devTo, devVault: a.devVault, feeTo: a.feeTo, feeVault: a.feeVault });
    } else if (ev.eventName === 'Attested') {
      Object.assign(info, { digest: a.digest, seed: a.seed, root: a.root, wots: [...(a.wots as Hex[])], auth: [...(a.auth as Hex[])] });
    } else if (ev.eventName === 'Image') {
      info.image = a.image;
    }
  }
  if (!info.name || !info.digest) return null;
  info.image ??= '0x';
  await cset(key, info);
  return info as LaunchInfo;
}

export async function imageOf(token: Hex, launchBlock: bigint): Promise<Hex | null> {
  try {
    return (await launchInfo(token, launchBlock))?.image ?? null;
  } catch {
    return null;
  }
}

/** Uncollected trading fees of a coin's locked position (what `collect` would pay out right now). */
export async function pendingFees(token: Hex): Promise<{ eth: bigint; tokens: bigint }> {
  const { tickUpper } = await launchShape();
  const id = poolIdOf(token);
  const [g, p] = await Promise.all([
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getFeeGrowthInside', args: [id, TICK_LOWER, tickUpper] }),
    client.readContract({
      address: STATE_VIEW,
      abi: stateViewAbi,
      functionName: 'getPositionInfo',
      args: [id, lp(), TICK_LOWER, tickUpper, `0x${'00'.repeat(32)}`],
    }),
  ]);
  const M = (1n << 256n) - 1n;
  const owed = (now: bigint, last: bigint) => ((((now - last) & M) * p[0]) >> 128n);
  return { eth: owed(g[0], p[1]), tokens: owed(g[1], p[2]) };
}

export async function quote(token: Hex, buy: boolean, amount: bigint): Promise<bigint> {
  const { result } = await client.simulateContract({
    address: V4_QUOTER,
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: poolKey(token), zeroForOne: buy, exactAmount: amount, hookData: '0x' }],
  });
  return result[0];
}

export interface Holder {
  address: Hex;
  balance: bigint;
}

export async function holders(token: Hex, fromBlock: bigint): Promise<Holder[]> {
  const latest = await client.getBlockNumber();
  const logs = await chunkedLogs({ address: token, event: transferEvent }, fromBlock, latest);
  const bal = new Map<string, bigint>();
  for (const l of logs) {
    const { args } = decodeEventLog({ abi: [transferEvent], data: l.data, topics: l.topics }) as unknown as {
      args: { from: Hex; to: Hex; value: bigint };
    };
    if (args.from !== zeroAddress) bal.set(args.from, (bal.get(args.from) ?? 0n) - args.value);
    bal.set(args.to, (bal.get(args.to) ?? 0n) + args.value);
  }
  return [...bal.entries()]
    .filter(([a, b]) => b > 0n && a !== zeroAddress)
    .map(([address, balance]) => ({ address: getAddress(address), balance }))
    .sort((a, b) => (b.balance > a.balance ? 1 : -1));
}

/** Block → unix time, interpolated between two known points (12 s slots; exact at both ends). */
export function blockClock(a: { block: bigint; ts: number }, b: { block: bigint; ts: number }) {
  const span = Number(b.block - a.block) || 1;
  const rate = (b.ts - a.ts) / span;
  return (n: bigint) => a.ts + Number(n - a.block) * rate;
}

/** One coin, straight from storage (deep links work before the board has loaded). */
export async function loadOne(token: Hex): Promise<CoinRow | null> {
  const LP = lp();
  const [c, n, s, slot] = (await client.multicall({
    contracts: [
      { address: LP, abi: launchpadAbi, functionName: 'coins', args: [token] },
      { address: token, abi: tokenAbi, functionName: 'name' },
      { address: token, abi: tokenAbi, functionName: 'symbol' },
      { address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [poolIdOf(token)] },
    ],
    allowFailure: true,
  } as never)) as unknown as MC[];
  if (c.status !== 'success') return null;
  const [identity, creator, leaf, launchedAt, feeTo, launchBlock, feeVault] = c.result as unknown as CoinTuple;
  if (!launchedAt) return null;
  const sqrt = slot.status === 'success' ? (slot.result as unknown as readonly [bigint])[0] : 0n;
  const priceEth = sqrt ? priceFromSqrt(sqrt) : 0;
  return {
    token,
    name: n.status === 'success' ? String(n.result) : '?',
    symbol: s.status === 'success' ? String(s.result) : '?',
    identity,
    creator,
    leaf: Number(leaf),
    launchedAt: Number(launchedAt),
    launchBlock,
    feeTo,
    feeVault,
    poolId: poolIdOf(token),
    sqrtPriceX96: sqrt,
    priceEth,
    mcapEth: priceEth * 1e9,
  };
}
