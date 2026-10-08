import { useEffect, useSyncExternalStore } from 'react';
import { parseAbi } from 'viem';
import { client, MULTICALL3, type PriceKey } from './chains';

/** USD prices for natives / peg targets. Missing key = unpriced (render "—"). */
export type Prices = Partial<Record<PriceKey | 'sol', number>>;

// Chainlink aggregators on Ethereum mainnet, each checked via description() on 2026-10-08.
export const FEEDS = {
  eth: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', // ETH / USD
  btc: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', // BTC / USD
  bnb: '0x14e613AC84a31f709eadbdF89C6CC390fDc9540A', // BNB / USD
  pol: '0x7bAC85A8a13A4BcD8abb3eB7d6b4d632c5a57676', // MATIC / USD (POL migrated 1:1)
  sol: '0x4ffC43a60e009B551865A93d232E33Fce9f01507', // SOL / USD
} as const;

const AGG = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']);
const MAX_AGE = 48 * 3600; // feeds with 24h heartbeats; anything older is treated as unpriced

let state: Prices = { usd: 1 };
let loadedAt = 0;
let inflight: Promise<Prices> | null = null;
const subs = new Set<() => void>();

export async function fetchPrices(): Promise<Prices> {
  if (inflight) return inflight;
  inflight = (async () => {
    const keys = Object.keys(FEEDS) as (keyof typeof FEEDS)[];
    const res = await client(1).multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: keys.map((k) => ({ address: FEEDS[k], abi: AGG, functionName: 'latestRoundData' }) as const),
    });
    const now = Date.now() / 1000;
    const next: Prices = { usd: 1 };
    res.forEach((r, i) => {
      if (r.status !== 'success') return;
      const [, answer, , updatedAt] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
      if (answer <= 0n || now - Number(updatedAt) > MAX_AGE) return;
      next[keys[i]] = Number(answer) / 1e8;
    });
    state = next;
    loadedAt = Date.now();
    subs.forEach((f) => f());
    return next;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function getPrices(): Prices {
  return state;
}

/** Live native prices; fetches once on first use and refreshes every 60s while mounted. */
export function usePrices(): Prices {
  const p = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
  useEffect(() => {
    if (Date.now() - loadedAt > 55_000) fetchPrices().catch(() => {});
    const id = setInterval(() => fetchPrices().catch(() => {}), 60_000);
    return () => clearInterval(id);
  }, []);
  return p;
}
