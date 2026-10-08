import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAINS, chainById } from '../chains';
import { classifyEvm, isContractCode, type EvmChainFacts, type SafeFacts, type Status, type Verdict } from './exposure';
import { readEvmChain, readIndexerNfts, readIndexerTokens, readNonceCode, readSafe, type Asset, type EvmRead } from './scan';

export interface ChainState {
  status: 'loading' | 'done' | 'error';
  nonce?: number;
  code?: `0x${string}`;
  assets: Asset[];
  indexer: 'none' | 'loading' | 'done' | 'error';
  extra: Asset[];
  nfts: Asset[];
}

/* short-lived cache so SCAN and MOVE don't double-fetch the same address */
const cache = new Map<string, { t: number; p: Promise<EvmRead> }>();
const idxCache = new Map<string, { t: number; p: Promise<Asset[]> }>();
const TTL = 20_000;

function cachedRead(address: `0x${string}`, chainId: number, force: boolean): Promise<EvmRead> {
  const k = `${chainId}:${address.toLowerCase()}`;
  const hit = cache.get(k);
  if (!force && hit && Date.now() - hit.t < TTL) return hit.p;
  const p = readEvmChain(address, chainId);
  cache.set(k, { t: Date.now(), p });
  p.catch(() => cache.delete(k));
  return p;
}
function cachedIdx(kind: 'tok' | 'nft', address: string, chainId: number, force: boolean): Promise<Asset[]> {
  const k = `${kind}:${chainId}:${address.toLowerCase()}`;
  const hit = idxCache.get(k);
  if (!force && hit && Date.now() - hit.t < 60_000) return hit.p;
  const p = kind === 'tok' ? readIndexerTokens(address, chainId) : readIndexerNfts(address, chainId);
  idxCache.set(k, { t: Date.now(), p });
  p.catch(() => idxCache.delete(k));
  return p;
}

export function ownerVerdicts(facts: Map<string, EvmChainFacts[]>, owners: string[]): Status[] {
  return owners.map((o) => classifyEvm(facts.get(o.toLowerCase()) ?? []).status);
}

export interface EvmAddressState {
  chains: Record<number, ChainState>;
  verdict: Verdict;
  safe?: SafeFacts;
  /** re-read one chain (or all) bypassing the cache */
  refresh(chainId?: number): void;
}

const blank = (): ChainState => ({ status: 'loading', assets: [], indexer: 'none', extra: [], nfts: [] });

export function useEvmAddress(address: `0x${string}` | undefined, opts: { nfts?: boolean } = {}): EvmAddressState {
  const [chains, setChains] = useState<Record<number, ChainState>>({});
  const [safe, setSafe] = useState<SafeFacts>();
  const [tick, setTick] = useState<{ n: number; only?: number }>({ n: 0 });
  const live = useRef<Record<number, number>>({});
  const gen = useRef(0);

  useEffect(() => {
    if (!address) return;
    const run = ++gen.current;
    const force = tick.n > 0;
    const targets = tick.only ? [tick.only] : CHAINS.map((c) => c.id);
    for (const id of targets) live.current[id] = run;
    const patch = (id: number, p: Partial<ChainState>) => {
      if (live.current[id] !== run) return;
      setChains((prev) => ({ ...prev, [id]: { ...(prev[id] ?? blank()), ...p } }));
    };
    if (!tick.only) {
      setChains(Object.fromEntries(CHAINS.map((c) => [c.id, blank()])));
      setSafe(undefined);
    } else patch(tick.only, { status: 'loading' });

    for (const id of targets) {
      const c = chainById(id);
      cachedRead(address, id, force)
        .then((r) => patch(id, { status: 'done', nonce: r.nonce, code: r.code, assets: r.assets }))
        .catch(() => patch(id, { status: 'error' }));
      if (c.blockscout) {
        patch(id, { indexer: 'loading' });
        cachedIdx('tok', address, id, force)
          .then((extra) => patch(id, { extra, indexer: 'done' }))
          .catch(() => patch(id, { indexer: 'error' }));
        if (opts.nfts && id === 1) {
          cachedIdx('nft', address, id, force)
            .then((nfts) => patch(id, { nfts }))
            .catch(() => {});
        }
      }
    }
  }, [address, tick, opts.nfts]);

  // Safe owners: only once a chain reports contract code
  const contractChain = CHAINS.find((c) => isContractCode(chains[c.id]?.code))?.id;
  useEffect(() => {
    if (!address || !contractChain) return;
    let dead = false;
    (async () => {
      const s = await readSafe(address, contractChain).catch(() => null);
      if (dead || !s) return;
      const name = chainById(contractChain).name;
      const facts = new Map<string, EvmChainFacts[]>();
      const publish = () =>
        !dead && setSafe({ chainName: name, ...s, ownerStatus: ownerVerdicts(facts, s.owners) });
      publish();
      await Promise.all(
        s.owners.map(async (o) => {
          const arr: EvmChainFacts[] = CHAINS.map((c) => ({ chainName: c.name }));
          facts.set(o.toLowerCase(), arr);
          await Promise.all(
            CHAINS.map(async (c, i) => {
              try {
                const r = await readNonceCode(o, c.id);
                arr[i] = { chainName: c.name, nonce: r.nonce, code: r.code };
              } catch {
                arr[i] = { chainName: c.name, error: true };
              }
            }),
          );
          publish();
        }),
      );
    })();
    return () => {
      dead = true;
    };
  }, [address, contractChain]);

  const facts: EvmChainFacts[] = CHAINS.map((c) => {
    const s = chains[c.id];
    if (!s || s.status === 'loading') return { chainName: c.name };
    if (s.status === 'error') return { chainName: c.name, error: true };
    return { chainName: c.name, nonce: s.nonce, code: s.code };
  });
  const verdict = address ? classifyEvm(facts, safe) : { status: 'pending' as const, reason: '' };

  const refresh = useCallback((only?: number) => setTick((t) => ({ n: t.n + 1, only })), []);
  return { chains, verdict, safe, refresh };
}
