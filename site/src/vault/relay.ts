import { useEffect, useState } from 'react';
import type { Hex } from 'viem';
import { RELAY_URL } from '../config';

// The gasless relayer: a small service with a hot wallet that submits a signed bunker message and is paid by the
// fee inside that message. It can not change a recipient, an amount or a route, and anyone else could submit the
// same message, so nothing here depends on it.

export interface RelayInfo {
  ok: boolean;
  relayer: Hex;
  vault: Hex;
  swap: Hex;
  /** a sentence when it is not taking work right now, else null */
  paused: string | null;
  /** wei it asks per gas, and the flat part of its fee */
  gasPrice: string;
  flat: string;
  gas: { withdraw: number; perEth: number; perToken: number; buy: number; sell: number };
}

/** DEV only: ?relay=http://127.0.0.1:8652 points the page at a local relayer. */
const devUrl = (() => {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(location.search).get('relay');
  return v && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(v) ? v : null;
})();
const infoUrl = devUrl ? `${devUrl}/info` : RELAY_URL;
const sendUrl = devUrl ? `${devUrl}/relay` : RELAY_URL;

export async function relayInfo(): Promise<RelayInfo> {
  const r = await fetch(infoUrl, { cache: 'no-store' });
  const j = (await r.json()) as RelayInfo & { error?: string };
  if (!r.ok || !j.ok) throw new Error(j.error ?? 'The relayer is not available.');
  return j;
}

export async function relaySend(body: unknown): Promise<{ hash?: Hex; done?: boolean }> {
  const r = await fetch(sendUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {
    throw new Error('The relayer did not answer. Your signed message is saved here: send it again in a moment, or use a wallet.');
  });
  const j = (await r.json().catch(() => ({}))) as { hash?: Hex; done?: boolean; error?: string };
  if (!r.ok) throw new Error(j.error ?? 'The relayer refused it.');
  return j;
}

/** What the relayer asks for a trip of `gasUnits`. */
export const relayFee = (info: RelayInfo, gasUnits: number) => BigInt(gasUnits) * BigInt(info.gasPrice) + BigInt(info.flat);

/** Live relayer terms, refreshed every 30 s. `info` is null while loading or when there is no relayer. */
export function useRelay(): RelayInfo | null {
  const [info, setInfo] = useState<RelayInfo | null>(null);
  useEffect(() => {
    let dead = false;
    const load = () => relayInfo().then(i => { if (!dead) setInfo(i); }, () => { if (!dead) setInfo(null); });
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  return info;
}
