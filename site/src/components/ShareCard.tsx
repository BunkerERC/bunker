import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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

/** Post text; share targets add the link to this scan after it. */
export function postText(d: CardData) {
  const money = d.usd >= 1 ? fmtUsd(d.usd) : '';
  return d.status === 'exposed'
    ? `my wallet's public key is already out${money ? `. ${money} sitting on an exposed key` : ''}.\n\nentering bunker mode $BUNKER\n\nscan yours:`
    : `my wallet never signed. public key still hidden behind a hash${money ? `, ${money} safe for now` : ''}.\n\nstaying in the bunker $BUNKER\n\nscan yours:`;
}

/** Link to this exact scan (the site opens with the address already scanned). */
export const scanLink = (d: CardData) => `https://${SITE}/#scan?a=${d.address}`;

// ------------------------------------------------------------------ button + modal
export function ShareButton({ data }: { data: CardData | null }) {
  // freeze the data when opened: the scan keeps re-rendering (prices, chains) and must not redraw the card
  const [snap, setSnap] = useState<CardData | null>(null);
  const close = useCallback(() => setSnap(null), []);
  return (
    <>
      <button className="btn sm share-btn" disabled={!data} onClick={() => data && setSnap({ ...data })} title={data ? 'Share this result' : 'Waiting for the scan'}>
        share
      </button>
      {snap && <ShareModal data={snap} onClose={close} />}
    </>
  );
}

function ShareModal({ data, onClose }: { data: CardData; onClose: () => void }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [img, setImg] = useState('');
  const [msg, setMsg] = useState('');
  const [intent, setIntent] = useState('');
  const [copied, setCopied] = useState(false);

  // draw once, off-screen, then show the finished PNG
  useEffect(() => {
    let dead = false;
    let url = '';
    const c = document.createElement('canvas');
    drawCard(c, data)
      .then(() => new Promise<Blob | null>(res => c.toBlob(res, 'image/png')))
      .then(b => {
        if (dead || !b) return;
        url = URL.createObjectURL(b);
        setBlob(b);
        setImg(url);
      })
      .catch(() => { if (!dead) setMsg('Could not draw the card in this browser.'); });
    return () => { dead = true; if (url) URL.revokeObjectURL(url); };
  }, [data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const text = postText(data);
  const link = scanLink(data);
  const file = blob ? new File([blob], `bunker-${data.status}-${data.address.slice(0, 8)}.png`, { type: 'image/png' }) : null;
  const xUrl = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
  const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text.replace(/\s*scan yours:$/, ''))}`;

  const download = () => {
    if (!file) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const post = async () => {
    if (!file) return;
    setMsg('');
    // phones: the share sheet hands the image straight to the X app
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ files: [file], text: `${text} ${link}` }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
    // desktop: X can't take an image from a link, so copy it, open the post, paste
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

  const copyLink = () => navigator.clipboard?.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }, () => {});

  // portal to <body>: the scan results animate with a transform, which would trap a fixed overlay inside them
  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal card-modal" role="dialog" aria-label="Share your scan" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span>Share your scan</span>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="card-frame">
          {img ? <img className="card-img" src={img} width={W} height={H} alt={`BUNKER scan card: ${data.status.toUpperCase()}`} /> : <div className="card-wait">drawing the card…</div>}
        </div>
        <div className="card-actions">
          <button className="btn primary" disabled={!blob} onClick={post}>Post on X with the card</button>
          <button className="btn" disabled={!blob} onClick={download}>Download PNG</button>
        </div>
        <div className="card-links">
          <span className="dim small">share link</span>
          <a className="btn sm" href={xUrl} target="_blank" rel="noreferrer">Share on X</a>
          <a className="btn sm" href={tgUrl} target="_blank" rel="noreferrer">Telegram</a>
          <button className="btn sm" onClick={copyLink}>{copied ? 'copied' : 'Copy link'}</button>
        </div>
        {msg && <p className="small card-msg">{msg}{intent && <> <a href={intent} target="_blank" rel="noreferrer">Open X</a></>}</p>}
        <p className="dim small card-note">The card is made in your browser. Nothing is uploaded.</p>
      </div>
    </div>,
    document.body,
  );
}
