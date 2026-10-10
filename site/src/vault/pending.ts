import type { Hex } from 'viem';

// One key = one message. Whatever a key signs is written here BEFORE it leaves the browser, and stays until the
// vault shows that key as used. While an entry exists, nothing else may be signed with that key: only the same
// message can be sent again.

interface Signed {
  nonce: number;
  digest: Hex;
  nextKey: Hex;
  sig: Hex[];
  hash?: Hex;
}

export interface PendingSend extends Signed {
  kind?: 'send';
  transfers: { token: Hex; to: Hex; amount: string }[];
  /** ETH paid from the bunker to whoever submits it (the relayer's fee); absent = 0 */
  fee?: string;
}

export interface PendingSwap extends Signed {
  kind: 'swap';
  order: {
    id: Hex; nonce: string; tokenIn: Hex; tokenOut: Hex; amountIn: string; minOut: string; tip: string;
    submitter: Hex; deadline: string; route: Hex;
  };
  route: { commands: Hex; inputs: Hex[] };
  /** what the order does, in words, for the "signed, not confirmed" line */
  note: string;
}

export type Pending = PendingSend | PendingSwap;
export const isSwap = (p: Pending): p is PendingSwap => p.kind === 'swap';

const keyOf = (vault: Hex, id: Hex, nonce: number) => `bunker:sig:${vault}:${id}:${nonce}`.toLowerCase();

export function loadPending(vault: Hex, id: Hex, nonce: number): Pending | null {
  try {
    const raw = localStorage.getItem(keyOf(vault, id, nonce));
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

export function savePending(vault: Hex, id: Hex, p: Pending) {
  try {
    localStorage.setItem(keyOf(vault, id, p.nonce), JSON.stringify(p));
  } catch {
    /* storage blocked: the signature still goes out, it just can't be re-sent from here */
  }
}

export function clearPending(vault: Hex, id: Hex, nonce: number) {
  try {
    localStorage.removeItem(keyOf(vault, id, nonce));
  } catch {
    /* ignore */
  }
}
