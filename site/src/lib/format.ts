export function fmtUsd(v: number | undefined, opts: { dash?: boolean } = {}): string {
  if (v === undefined || !Number.isFinite(v)) return opts.dash === false ? '' : '—';
  if (v === 0) return '$0';
  if (v < 0.01) return '<$0.01';
  if (v < 1000) return `$${v.toFixed(2)}`;
  if (v < 1e6) return `$${(v / 1e3).toFixed(v < 1e4 ? 2 : 1)}K`;
  if (v < 1e9) return `$${(v / 1e6).toFixed(2)}M`;
  return `$${(v / 1e9).toFixed(2)}B`;
}

export function fmtAmt(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a < 0.0001) return '<0.0001';
  if (a < 1) return v.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '');
  if (a < 1000) return v.toFixed(a < 10 ? 4 : 2).replace(/\.?0+$/, '');
  if (a < 1e6) return `${(v / 1e3).toFixed(2)}K`;
  if (a < 1e9) return `${(v / 1e6).toFixed(2)}M`;
  if (a < 1e12) return `${(v / 1e9).toFixed(2)}B`;
  return v.toExponential(2);
}

export const short = (a: string, n = 4) => (a.length > 2 * n + 3 ? `${a.slice(0, n + (a.startsWith('0x') ? 2 : 0))}…${a.slice(-n)}` : a);

/** bigint → float with decimals (for display/pricing only) */
export function toNum(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const s = raw.toString().padStart(decimals + 1, '0');
  return Number(`${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals, s.length - decimals + 12) || '0'}`);
}
