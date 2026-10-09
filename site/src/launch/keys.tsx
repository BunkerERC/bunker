// Post-quantum keys for this tab: the bunker phrase's entropy → XMSS creator identity (1,024 one-time launch keys) +
// the BunkerVault account of the same phrase. Secrets live in memory only (or sealed with a passcode, if the user asks).
// The tree of public leaf hashes is cached.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Hex } from 'viem';
import * as xmss from './pq/xmss.js';
import * as wots from '../lib/wots.js';
import { forgetSealed, sealEntropy, sealedLabel, unsealEntropy } from './pq/phrase';
import { client } from './market';
import { LAUNCHPAD } from './config';
import launchpadAbi from './abi/BunkerLaunchpad';

export interface Identity {
  master: Uint8Array;
  seed: Uint8Array;
  levels: Uint8Array[][];
  root: Uint8Array;
  seedHex: Hex;
  rootHex: Hex;
  id: Hex;
}

interface KeysState {
  status: 'locked' | 'building' | 'ready';
  progress: number; // leaves built, of 1,024
  identity: Identity | null;
  vaultMaster: Uint8Array | null;
  vaultId: Hex | null;
  /** leaves burned on-chain, plus any this browser has ever signed with */
  used: Set<number>;
  usedOnChain: Set<number>;
  saved: string | null; // label of a sealed identity on this device
  unlock(entropy: Uint8Array): Promise<void>;
  lock(): void;
  refreshLeaves(): Promise<Set<number>>;
  /** A random unused leaf, from a fresh read of the on-chain bitmap plus every leaf this browser ever signed with.
   *  Random (not lowest) so two devices signing at once almost never pick the same one. */
  reserveLeaf(): Promise<number>;
  /** Signs `digest` with `leaf`: re-checks the leaf on-chain, records it as used (memory + storage) BEFORE the
   *  signature exists, and refuses if any of that fails. Never signs twice with one leaf. */
  signWith(leaf: number, digest: Hex): Promise<xmss.Sig>;
  seal(pass: string): Promise<void>;
  unseal(pass: string): Promise<void>;
  forget(): void;
}

const Ctx = createContext<KeysState | null>(null);
export const shortId = (id: Hex | string) => `pq·${id.slice(2, 10)}`;

const leavesKey = (seedHex: string) => `bunker:xmss:leaves:v1:${seedHex.slice(2, 18)}`;
const signedKey = (id: string) => `bunker:xmss:signed:v1:${id.toLowerCase()}`;

function loadLeaves(seedHex: string): Uint8Array[] | null {
  try {
    const raw = localStorage.getItem(leavesKey(seedHex));
    if (!raw) return null;
    const bin = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
    if (bin.length !== xmss.LEAVES * 32) return null;
    return Array.from({ length: xmss.LEAVES }, (_, i) => bin.slice(i * 32, i * 32 + 32));
  } catch {
    return null;
  }
}

function saveLeaves(seedHex: string, leaves: Uint8Array[]) {
  try {
    const bin = new Uint8Array(leaves.length * 32);
    leaves.forEach((l, i) => bin.set(l, i * 32));
    let s = '';
    for (let i = 0; i < bin.length; i += 0x8000) s += String.fromCharCode(...bin.subarray(i, i + 0x8000));
    localStorage.setItem(leavesKey(seedHex), btoa(s));
  } catch {
    /* storage full or blocked: rebuild next time */
  }
}

function loadSigned(id: string): number[] {
  try {
    return JSON.parse(localStorage.getItem(signedKey(id)) ?? '[]');
  } catch {
    return [];
  }
}

/** Records a leaf as used. Returns false if storage could not keep it (then the caller must not sign). */
function addSigned(id: string, leaf: number): boolean {
  try {
    const s = new Set(loadSigned(id));
    s.add(leaf);
    localStorage.setItem(signedKey(id), JSON.stringify([...s]));
    return loadSigned(id).includes(leaf);
  } catch {
    return false;
  }
}

async function buildLeaves(master: Uint8Array, seed: Uint8Array, onProgress: (n: number) => void): Promise<Uint8Array[]> {
  const n = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4));
  const per = Math.ceil(xmss.LEAVES / n);
  const out: Uint8Array[] = new Array(xmss.LEAVES);
  const progress = new Array(n).fill(0);
  await Promise.all(
    Array.from({ length: n }, (_, w) => {
      const from = w * per;
      const to = Math.min(xmss.LEAVES, from + per);
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(new URL('./pq/treeWorker.js', import.meta.url), { type: 'module' });
        worker.onmessage = e => {
          if (e.data.type === 'progress') {
            progress[w] = e.data.done;
            onProgress(progress.reduce((a, b) => a + b, 0));
          } else {
            (e.data.leaves as ArrayBuffer[] | Uint8Array[]).forEach((l, i) => (out[from + i] = new Uint8Array(l as ArrayBuffer)));
            worker.terminate();
            resolve();
          }
        };
        worker.onerror = err => {
          worker.terminate();
          reject(err);
        };
        worker.postMessage({ master, seed, from, to });
      });
    }),
  );
  return out;
}

export function KeysProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<KeysState['status']>('locked');
  const [progress, setProgress] = useState(0);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [vaultMaster, setVaultMaster] = useState<Uint8Array | null>(null);
  const [usedOnChain, setUsedOnChain] = useState<Set<number>>(new Set());
  const [localSigned, setLocalSigned] = useState<number[]>([]);
  const [saved, setSaved] = useState<string | null>(() => sealedLabel());
  const entropyRef = useRef<Uint8Array | null>(null);
  const memSigned = useRef<Set<number>>(new Set()); // survives storage being cleared mid-session

  const vaultId = useMemo(() => (vaultMaster ? (wots.accountId(vaultMaster) as Hex) : null), [vaultMaster]);

  const unlock = useCallback(async (entropy: Uint8Array) => {
    setStatus('building');
    setProgress(0);
    const { master, seed } = xmss.identityKeys(entropy);
    const seedHex = xmss.toHex(seed);
    let leaves = loadLeaves(seedHex);
    if (leaves) {
      // cached public leaves: spot-check two against the secret before trusting them
      for (const l of [Math.floor(Math.random() * xmss.LEAVES), Math.floor(Math.random() * xmss.LEAVES)]) {
        if (xmss.toHex(xmss.leafHash(master, seed, l)) !== xmss.toHex(leaves[l])) {
          leaves = null;
          break;
        }
      }
    }
    if (!leaves) {
      leaves = await buildLeaves(master, seed, setProgress);
      saveLeaves(seedHex, leaves);
    }
    setProgress(xmss.LEAVES);
    const levels = xmss.treeFromLeaves(seed, leaves);
    const root = xmss.rootOf(levels);
    const id = xmss.toHex(xmss.identityId(seed, root));
    entropyRef.current = entropy;
    setIdentity({ master, seed, levels, root, seedHex, rootHex: xmss.toHex(root), id });
    setVaultMaster(wots.masterFromEntropy(entropy));
    setLocalSigned(loadSigned(id));
    setStatus('ready');
  }, []);

  const lock = useCallback(() => {
    entropyRef.current = null;
    setIdentity(null);
    setVaultMaster(null);
    setUsedOnChain(new Set());
    setLocalSigned([]);
    setStatus('locked');
  }, []);

  const refreshLeaves = useCallback(async (): Promise<Set<number>> => {
    if (!identity || !LAUNCHPAD) return new Set<number>();
    const words = (await client.readContract({
      address: LAUNCHPAD,
      abi: launchpadAbi,
      functionName: 'leafBitmap',
      args: [identity.id],
    })) as readonly bigint[];
    const s = new Set<number>();
    words.forEach((w, i) => {
      for (let b = 0; b < 256; b++) if ((w >> BigInt(b)) & 1n) s.add(i * 256 + b);
    });
    setUsedOnChain(s);
    setLocalSigned(loadSigned(identity.id));
    return s;
  }, [identity]);

  useEffect(() => {
    refreshLeaves().catch(() => {});
  }, [refreshLeaves]);

  const used = useMemo(() => new Set([...usedOnChain, ...localSigned]), [usedOnChain, localSigned]);

  const reserveLeaf = useCallback(async () => {
    if (!identity) throw new Error('Unlock your keys first.');
    const onchain = await refreshLeaves();
    const taken = new Set([...onchain, ...loadSigned(identity.id), ...memSigned.current]);
    const free: number[] = [];
    for (let l = 0; l < xmss.LEAVES; l++) if (!taken.has(l)) free.push(l);
    if (!free.length) throw new Error('All 1,024 one-time launch keys of this phrase are used. Make a new phrase.');
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    return free[r[0] % free.length];
  }, [identity, refreshLeaves]);

  const signWith = useCallback(
    async (leaf: number, digest: Hex) => {
      if (!identity) throw new Error('Unlock your keys first.');
      if (!LAUNCHPAD) throw new Error('Launchpad not deployed.');
      const burned = (await client.readContract({
        address: LAUNCHPAD,
        abi: launchpadAbi,
        functionName: 'isLeafUsed',
        args: [identity.id, leaf],
      })) as boolean;
      if (burned || memSigned.current.has(leaf) || loadSigned(identity.id).includes(leaf))
        throw new Error(`One-time key #${leaf} was already used. Nothing was signed.`);
      // burned locally BEFORE the signature exists; refuse if this browser can't remember it
      memSigned.current.add(leaf);
      if (!addSigned(identity.id, leaf))
        throw new Error('This browser is blocking storage, so it could not record the one-time key. Allow site storage and retry. Nothing was signed.');
      setLocalSigned(loadSigned(identity.id));
      const d = xmss.fromHex(digest);
      const sig = xmss.sign(identity.master, identity.seed, identity.levels, leaf, d);
      const back = xmss.rootFromSignature(identity.seed, leaf, d, sig.wots, sig.auth);
      if (xmss.toHex(back) !== identity.rootHex) throw new Error('Signature self-check failed. Nothing was sent.');
      return sig;
    },
    [identity],
  );

  const seal = useCallback(
    async (pass: string) => {
      if (!entropyRef.current || !identity) throw new Error('Unlock first.');
      await sealEntropy(entropyRef.current, pass, shortId(identity.id));
      setSaved(sealedLabel());
    },
    [identity],
  );

  const unseal = useCallback(async (pass: string) => unlock(await unsealEntropy(pass)), [unlock]);

  const forget = useCallback(() => {
    forgetSealed();
    setSaved(null);
  }, []);

  const value: KeysState = {
    status,
    progress,
    identity,
    vaultMaster,
    vaultId,
    used,
    usedOnChain,
    saved,
    unlock,
    lock,
    refreshLeaves,
    reserveLeaf,
    signWith,
    seal,
    unseal,
    forget,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useKeys(): KeysState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useKeys outside KeysProvider');
  return v;
}
