import { useEffect, useRef, useState } from 'react';
import { fmtUsd } from '../lib/format';

/** What a scan found for one address, as it goes on the card. */
export interface CardData {
  status: 'exposed' | 'hidden';
  address: string;
  kind: string; // "EVM", "Taproot", "Solana · ed25519"
  detail: string; // "Signed on Ethereum, Base" / "Never signed on 7 chains"
  usd: number; // at risk (exposed) or sitting behind a hash (hidden)
}

const W = 1200, H = 675;
const SITE = 'bunkereth.xyz';
const RED = '#ff5257', GREEN = '#2ecf6e', YELLOW = '#f2c230';

const shortAddr = (a: string) => (a.length > 16 ? `${a.slice(0, a.startsWith('0x') ? 8 : 6)}…${a.slice(-6)}` : a);

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });
}

type Ctx = CanvasRenderingContext2D;
function font(ctx: Ctx, f: string, stretch: CanvasFontStretch = 'semi-expanded', spacing = '0px') {
  ctx.font = f;
  if ('fontStretch' in ctx) ctx.fontStretch = stretch;
  if ('letterSpacing' in ctx) ctx.letterSpacing = spacing;
}
function fit(ctx: Ctx, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

/** Draws the 1200x675 card (X's in-feed image ratio). Same-origin images only, so the canvas stays exportable. */
export async function drawCard(canvas: HTMLCanvasElement, d: CardData) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d') as Ctx;
  await Promise.all([
    document.fonts.load('900 100px Archivo'),
    document.fonts.load('600 20px "JetBrains Mono"'),
    document.fonts.load('500 26px Archivo'),
  ]).catch(() => {});
  const [hero, mark] = await Promise.all([loadImg('/hero-bunker.jpg'), loadImg('/logo-mark.png')]);
  const exposed = d.status === 'exposed';
  const tone = exposed ? RED : GREEN;

  // background: the bunker, fading into black on the left
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const hw = W * 0.66, hh = (hero.height / hero.width) * hw;
  ctx.globalAlpha = 0.9;
  ctx.drawImage(hero, W - hw, (H - hh) / 2 + 20, hw, hh);
  ctx.globalAlpha = 1;
  let g = ctx.createLinearGradient(W - hw, 0, W - hw * 0.45, 0);
  g.addColorStop(0, '#000');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(W - hw, 0, hw * 0.55, H);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, W, H);
  g = ctx.createLinearGradient(0, H - 200, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, '#000');
  ctx.fillStyle = g;
  ctx.fillRect(0, H - 200, W, 200);
  // a wash of the verdict colour behind the stamp
  g = ctx.createRadialGradient(300, 300, 0, 300, 300, 520);
  g.addColorStop(0, exposed ? 'rgba(255,82,87,0.16)' : 'rgba(46,207,110,0.14)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // header: mark + wordmark, kicker
  const mh = 30, mw = (mark.width / mark.height) * mh;
  ctx.drawImage(mark, 64, 52, mw, mh);
  ctx.fillStyle = '#f4f4f4';
  font(ctx, '900 34px Archivo', 'semi-expanded', '0.5px');
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('BUNKER', 64 + mw + 14, 80);
  ctx.fillStyle = YELLOW;
  font(ctx, '600 18px "JetBrains Mono"', 'normal', '6px');
  ctx.fillText('BUNKER MODE · KEY SCAN', 64, 150);

  // the stamp
  font(ctx, '900 150px Archivo', 'semi-expanded', '1px');
  const word = exposed ? 'EXPOSED' : 'HIDDEN';
  const tw = ctx.measureText(word).width;
  const sx = 64, sy = 182, pad = 26, bw = tw + pad * 2, bh = 168;
  ctx.save();
  ctx.translate(sx + bw / 2, sy + bh / 2);
  ctx.rotate((-4 * Math.PI) / 180);
  ctx.shadowColor = tone;
  ctx.shadowBlur = 34;
  ctx.strokeStyle = tone;
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.roundRect(-bw / 2, -bh / 2, bw, bh, 14);
  ctx.stroke();
  ctx.shadowBlur = 22;
  ctx.fillStyle = tone;
  ctx.textBaseline = 'middle';
  ctx.fillText(word, -bw / 2 + pad, 8);
  ctx.restore();
  ctx.textBaseline = 'alphabetic';

  // address + what the scan saw
  ctx.fillStyle = '#e6e6e6';
  font(ctx, '500 30px "JetBrains Mono"', 'normal', '0px');
  ctx.fillText(`${shortAddr(d.address)}`, 64, 424);
  const aw = ctx.measureText(shortAddr(d.address)).width;
  ctx.fillStyle = '#8a8a8a';
  font(ctx, '500 18px "JetBrains Mono"', 'normal', '2px');
  ctx.fillText(d.kind.toUpperCase(), 64 + aw + 18, 422);
  ctx.fillStyle = '#b5b5b5';
  font(ctx, '500 26px Archivo', 'normal', '0px');
  ctx.fillText(fit(ctx, d.detail, 700), 64, 468);

  // the money line
  const money = d.usd >= 1 ? fmtUsd(d.usd) : '';
  let x = 64;
  if (money) {
    ctx.fillStyle = tone;
    font(ctx, '900 64px Archivo', 'semi-expanded', '0px');
    ctx.fillText(money, x, 556);
    x += ctx.measureText(money).width + 18;
  }
  ctx.fillStyle = '#e6e6e6';
  font(ctx, '600 28px Archivo', 'normal', '0px');
  const tail = exposed
    ? money ? 'sitting on a public key' : 'Public key on-chain. Nothing on it yet.'
    : money ? 'still behind a hash' : 'Public key still behind a hash.';
  ctx.fillText(tail, x, 550);

  // footer
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(64, 596, W - 128, 1);
  ctx.fillStyle = YELLOW;
  font(ctx, '600 24px "JetBrains Mono"', 'normal', '0px');
  ctx.fillText(`${SITE}  ·  scan yours`, 64, 640);
  ctx.fillStyle = '#f4f4f4';
  font(ctx, '900 28px Archivo', 'semi-expanded', '1px');
  const end = exposed ? 'ENTER BUNKER MODE.' : 'STAY IN THE BUNKER.';
  ctx.textAlign = 'right';
  ctx.fillText(end, W - 64, 640);
  ctx.textAlign = 'left';
}

export function postText(d: CardData) {
  const money = d.usd >= 1 ? fmtUsd(d.usd) : '';
  return d.status === 'exposed'
    ? `my wallet's public key is already out${money ? `. ${money} sitting on an exposed key` : ''}.\n\nentering bunker mode → ${SITE}\n\n$BUNKER`
    : `my wallet never signed. public key still hidden behind a hash${money ? `, ${money} safe for now` : ''}.\n\nscan yours → ${SITE}\n\n$BUNKER`;
}

// ------------------------------------------------------------------ button + modal
export function ShareButton({ data }: { data: CardData | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm share-btn" disabled={!data} onClick={() => setOpen(true)} title={data ? 'Make a share card' : 'Waiting for the scan'}>
        share card
      </button>
      {open && data && <ShareModal data={data} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareModal({ data, onClose }: { data: CardData; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [msg, setMsg] = useState('');
  const [intent, setIntent] = useState('');

  useEffect(() => {
    let dead = false;
    const c = ref.current!;
    drawCard(c, data)
      .then(() => new Promise<Blob | null>(res => c.toBlob(res, 'image/png')))
      .then(b => { if (!dead) setBlob(b); })
      .catch(() => { if (!dead) setMsg('Could not draw the card in this browser.'); });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { dead = true; window.removeEventListener('keydown', onKey); };
  }, [data, onClose]);

  const text = postText(data);
  const file = blob ? new File([blob], `bunker-${data.status}-${data.address.slice(0, 8)}.png`, { type: 'image/png' }) : null;
  const xUrl = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

  const post = async () => {
    if (!file) return;
    setMsg('');
    // phones: the share sheet hands the image straight to the X app
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ files: [file], text }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
    // desktop: copy the image, open the post, paste
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': file })]);
      setMsg('Card copied. Paste it into the post (Ctrl+V / ⌘V).');
    } catch {
      download();
      setMsg('Card downloaded. Attach it to the post.');
    }
    const w = window.open(xUrl, '_blank');
    if (w) w.opener = null;
    else setIntent(xUrl);
  };

  const download = () => {
    if (!file) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal card-modal" role="dialog" aria-label="Share card" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span>Share your scan</span>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <canvas ref={ref} className="card-canvas" width={W} height={H} />
        <div className="card-actions">
          <button className="btn primary" disabled={!blob} onClick={post}>Post on X</button>
          <button className="btn" disabled={!blob} onClick={download}>Download PNG</button>
          <span className="grow" />
          <span className="dim small">Made in your browser. Nothing is uploaded.</span>
        </div>
        {msg && <p className="small card-msg">{msg}{intent && <> <a href={intent} target="_blank" rel="noreferrer">Open X</a></>}</p>}
      </div>
    </div>
  );
}
