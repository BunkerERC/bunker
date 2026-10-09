// One shared poll of the chain for the whole app: coins, 24h stats, ETH price, gas. Draws cached data instantly.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { LAUNCHPAD } from './config';
import { client, ethUsd, launchShape, loadCoins, stats24, type CoinRow, type Stats24 } from './market';

interface Market {
  coins: CoinRow[] | null;
  stats: Record<string, Stats24>;
  usd: number | null;
  gasGwei: number | null;
  block: bigint | null;
  error: string | null;
  refresh(): void;
}

const Ctx = createContext<Market | null>(null);
const SNAP = `bunker:launch:market:v1:${LAUNCHPAD}`;

function loadSnap(): CoinRow[] | null {
  try {
    const raw = sessionStorage.getItem(SNAP);
    if (!raw) return null;
    return JSON.parse(raw, (_k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
  } catch {
    return null;
  }
}

function saveSnap(c: CoinRow[]) {
  try {
    sessionStorage.setItem(SNAP, JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
  } catch {
    /* ignore */
  }
}

export function MarketProvider({ children }: { children: ReactNode }) {
  const [coins, setCoins] = useState<CoinRow[] | null>(() => (LAUNCHPAD ? loadSnap() : []));
  const [stats, setStats] = useState<Record<string, Stats24>>({});
  const [usd, setUsd] = useState<number | null>(null);
  const [gasGwei, setGas] = useState<number | null>(null);
  const [block, setBlock] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const [p, g, b] = await Promise.all([ethUsd().catch(() => null), client.getGasPrice().catch(() => null), client.getBlockNumber().catch(() => null)]);
      if (p) setUsd(p);
      if (g) setGas(Number(g) / 1e9);
      if (b) setBlock(b);
      if (!LAUNCHPAD) return;
      await launchShape();
      const c = await loadCoins();
      setCoins(c);
      saveSnap(c);
      setError(null);
      stats24(c).then(setStats).catch(() => {});
    } catch (e) {
      setError((e as Error).message?.split('\n')[0] ?? 'RPC error');
      setCoins(c => c ?? []);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (!document.hidden) load();
    }, 15_000);
    return () => clearInterval(t);
  }, [load]);

  return <Ctx.Provider value={{ coins, stats, usd, gasGwei, block, error, refresh: load }}>{children}</Ctx.Provider>;
}

export function useMarket(): Market {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMarket outside MarketProvider');
  return v;
}
