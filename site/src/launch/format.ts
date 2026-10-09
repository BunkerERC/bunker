import { formatUnits } from 'viem';

export const short = (h: string, n = 4) => (h && h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);

const SUB = '₀₁₂₃₄₅₆₇₈₉';
const sub = (n: number) => String(n).split('').map(d => SUB[+d]).join('');

/** Compact number: 1.23K, 4.5M, 7.8B. */
export function compact(n: number, digits = 2): string {
  if (!isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(digits) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(digits) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(digits) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(digits === 0 ? 0 : 1) + 'K';
  if (a >= 1e3) return (n / 1e3).toFixed(digits) + 'K';
  if (a >= 1) return n.toFixed(digits);
  if (a === 0) return '0';
  return tiny(n);
}

/** Small prices GMGN-style: 0.0₅1234. */
export function tiny(n: number, sig = 4): string {
  if (n === 0) return '0';
  if (Math.abs(n) >= 0.01) return n.toPrecision(sig).replace(/\.?0+$/, '');
  const s = n.toExponential(sig - 1); // 1.234e-7
  const [m, e] = s.split('e');
  const zeros = -Number(e) - 1;
  const digits = m.replace('.', '').replace('-', '');
  return `${n < 0 ? '-' : ''}0.0${sub(zeros)}${digits}`;
}

export const usd = (n: number | null | undefined, digits = 1) =>
  n == null || !isFinite(n) ? '—' : n >= 1 || n === 0 ? `$${compact(n, digits)}` : `$${tiny(n)}`;

export function eth(wei: bigint, digits = 4): string {
  const s = formatUnits(wei, 18);
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, digits).replace(/0+$/, '');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '');
}

export const tokens = (raw: bigint) => compact(Number(formatUnits(raw, 18)), 2);

export function ago(sec: number): string {
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return `${Math.max(1, Math.round(s))}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const pct = (n: number | null | undefined, digits = 1) =>
  n == null || !isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;

export function errText(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string; code?: number; details?: string };
  if (any?.code === 4001) return 'Rejected in the wallet.';
  const m = any?.shortMessage ?? any?.message ?? String(e);
  if (/rejected|denied/i.test(m)) return 'Rejected in the wallet.';
  const reason = m.match(/reverted with the following reason:\s*\n?(.*)/)?.[1];
  return (reason ?? m).split('\n')[0];
}
