import { useState } from 'react';
import type { Status } from '../lib/exposure';

const CHIP_TEXT: Record<Status, string> = {
  exposed: '✗ exposed',
  hidden: '✓ hidden',
  warn: '⚠︎ check',
  pending: 'checking',
};

export function Chip({ status, label }: { status: Status; label?: string }) {
  return (
    <span className={`chip ${status}`}>
      {status === 'pending' && <span className="spin" style={{ width: 8, height: 8 }} />}
      {label ?? CHIP_TEXT[status]}
    </span>
  );
}

export const Spinner = ({ size }: { size?: number }) => (
  <span className="spin" style={size ? { width: size, height: size } : undefined} aria-label="loading" />
);

/** Real logo or an empty 1px-framed tile. Never a stand-in. */
export function Logo({ src, size = 16, square }: { src?: string; size?: number; square?: boolean }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <span className={`tile${square ? ' sq' : ''}`} style={{ width: size, height: size }} />;
  return (
    <img
      className="logo"
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: square ? 3 : '50%' }}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBad(true)}
    />
  );
}

export function CopyBtn({ text, label = 'copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm ghost"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => {},
        );
      }}
    >
      {done ? 'copied' : label}
    </button>
  );
}

export function StepIcon({ status }: { status: string }) {
  if (status === 'done') return <span className="green mono">✓</span>;
  if (status === 'failed') return <span className="red mono">✗</span>;
  if (status === 'skipped') return <span className="dim mono">–</span>;
  if (status === 'queued') return <span className="dim mono">·</span>;
  return <Spinner />;
}
