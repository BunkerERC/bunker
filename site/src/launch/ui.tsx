import { useEffect, useState, type ReactNode } from 'react';
import { hexToBytes, type Hex } from 'viem';
import { digitsOf } from './pq/xmss.js';
import { imageUrl } from './image';
import { launchInfo } from './market';
import { EXPLORER } from './config';
import { short } from './format';

/** Hash links inside the single-page app (#launch, #coin/0x…). */
export const go = (hash: string) => {
  if (location.hash !== hash) location.hash = hash;
};

/** The 67 Winternitz digits a coin's launch signature committed to: its post-quantum fingerprint. */
export function Fingerprint({ digest, height = 18, width = 2, gap = 1, fill = false }: { digest?: Hex | null; height?: number; width?: number; gap?: number; fill?: boolean }) {
  const d = digest ? digitsOf(hexToBytes(digest)) : Array.from({ length: 67 }, () => 1);
  return (
    <span className="fp" style={{ height, gap, width: fill ? '100%' : undefined }} aria-label="signature fingerprint">
      {d.map((v, i) => (
        <i
          key={i}
          className={i >= 64 ? 'ck' : ''}
          style={{ width: fill ? undefined : width, flex: fill ? 1 : undefined, height: `${Math.max(8, ((v + 1) / 16) * 100)}%`, opacity: digest ? undefined : 0.15 }}
        />
      ))}
    </span>
  );
}

/** The whole Winternitz signature as a grid: 67 hash chains, 16 steps each, lit up to the digit the key signed. */
export function Matrix({ digest }: { digest: Hex }) {
  const d = digitsOf(hexToBytes(digest));
  return (
    <div className="matrix" aria-label="Winternitz chains">
      {d.map((v, i) => (
        <div key={i} className={`c ${i >= 64 ? 'ck' : ''}`}>
          {Array.from({ length: 16 }, (_, r) => (
            <i key={r} className={r >= 15 - v ? 'on' : ''} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Coin image from its on-chain launch log. Falls back to the fingerprint (never a made-up logo). */
export function Avatar({ token, launchBlock, size = 36, image }: { token: Hex; launchBlock?: bigint; size?: number; image?: Hex | null }) {
  const [hex, setHex] = useState<Hex | null>(image ?? null);
  const [digest, setDigest] = useState<Hex | null>(null);
  useEffect(() => {
    if (image !== undefined) return setHex(image);
    if (launchBlock === undefined) return;
    let dead = false;
    launchInfo(token, launchBlock)
      .then(i => {
        if (dead || !i) return;
        setHex(i.image);
        setDigest(i.digest);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [token, launchBlock, image]);
  const url = imageUrl(hex);
  return (
    <span className="av" style={{ width: size, height: size }}>
      {url ? <img src={url} alt="" loading="lazy" /> : <Fingerprint digest={digest} height={size * 0.5} width={Math.max(1, size / 60)} gap={0} />}
    </span>
  );
}

export function Copy({ text, label, className }: { text: string; label?: ReactNode; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`copy ${className ?? ''}`}
      title="Copy"
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <span className="green">copied</span> : (label ?? short(text))}
    </button>
  );
}

export const Ext = ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
  <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
    {children}
  </a>
);

export const AddrLink = ({ a, n = 4 }: { a: Hex; n?: number }) => (
  <Ext href={`${EXPLORER}/address/${a}`} className="mono dim2">
    {short(a, n)}
  </Ext>
);

export const TxLink = ({ h, children }: { h: Hex; children?: ReactNode }) => (
  <Ext href={`${EXPLORER}/tx/${h}`} className="mono dim2">
    {children ?? short(h, 4)}
  </Ext>
);

export const Spin = () => <i className="spin" aria-label="loading" />;
