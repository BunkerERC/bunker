import { useEffect, useMemo, useRef, useState } from 'react';
import { formatEther, parseEther, toBytes, zeroAddress, zeroHash, type Hex } from 'viem';
import launchpadAbi from './abi/BunkerLaunchpad';
import { CHAIN_ID, LAUNCHPAD } from './config';
import { useKeys, shortId } from './keys';
import { useWallet } from '../wallet';
import { useMarket } from './data';
import { launchDigest, type LaunchParams } from './pq/digest';
import { encodeImage, MAX_IMAGE } from './image';
import { client, launchShape } from './market';
import { errText, usd } from './format';
import { Avatar, Fingerprint, TxLink, go } from './ui';
import KeyGate from './KeyGate';

type Dest = 'wallet' | 'vault';
const STEPS = ['Pick an unused one-time key', 'Sign every field with it (in this browser)', 'Check the signature against the contract', 'Approve in your wallet', 'Coin, pool and dev buy land in one block'];

const cleanUrl = (s: string) => {
  const v = s.trim();
  if (!v) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    return u.protocol === 'https:' ? u.href.slice(0, 200) : '';
  } catch {
    return '';
  }
};

export default function LaunchForm({ ticker }: { ticker?: string }) {
  const k = useKeys();
  const w = useWallet();
  const m = useMarket();
  const [img, setImg] = useState<{ hex: Hex; url: string; bytes: number } | null>(null);
  const [imgErr, setImgErr] = useState('');
  const [over, setOver] = useState(false);
  const [name, setName] = useState('');
  // the home page's signature bench hands over a ticker
  const [symbol, setSymbol] = useState(() => (ticker ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12));
  const [desc, setDesc] = useState('');
  const [site, setSite] = useState('');
  const [x, setX] = useState('');
  const [tg, setTg] = useState('');
  const [dev, setDev] = useState('');
  const [devDest, setDevDest] = useState<Dest>('vault');
  const [feeDest, setFeeDest] = useState<Dest>('wallet');
  const [step, setStep] = useState(-1);
  const [err, setErr] = useState('');
  const [hash, setHash] = useState<Hex | null>(null);
  const [startFdv, setStartFdv] = useState<number | null>(null);
  const [bal, setBal] = useState<bigint | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (LAUNCHPAD) launchShape().then(s => setStartFdv(s.startPriceEth * 1e9)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!w.address) return setBal(null);
    client.getBalance({ address: w.address }).then(setBal).catch(() => setBal(null));
  }, [w.address, step]);

  const meta = useMemo(() => {
    const o: Record<string, string> = {};
    if (desc.trim()) o.description = desc.trim().slice(0, 600);
    if (cleanUrl(site)) o.website = cleanUrl(site);
    if (cleanUrl(x)) o.x = cleanUrl(x);
    if (cleanUrl(tg)) o.telegram = cleanUrl(tg);
    return JSON.stringify(o);
  }, [desc, site, x, tg]);

  let devWei = 0n;
  let devBad = false;
  try {
    devWei = dev.trim() ? parseEther(dev.trim()) : 0n;
  } catch {
    devBad = true;
  }
  const devPct = startFdv && devWei > 0n ? (() => {
    const a = Number(formatEther(devWei)) * 0.99;
    return (a / (startFdv + a)) * 100;
  })() : 0;

  const params = (creator: Hex): LaunchParams => ({
    name: name.trim(),
    symbol: symbol.trim(),
    meta,
    image: img?.hex ?? '0x',
    devTo: devDest === 'wallet' ? creator : zeroAddress,
    devVault: devDest === 'vault' && k.vaultId ? k.vaultId : zeroHash,
    feeTo: feeDest === 'wallet' ? creator : zeroAddress,
    feeVault: feeDest === 'vault' && k.vaultId ? k.vaultId : zeroHash,
  });

  // live preview of the digest (moves with every keystroke; the real one is rebuilt at launch)
  const preview = useMemo(
    () =>
      launchDigest({
        chainId: CHAIN_ID,
        launchpad: LAUNCHPAD ?? zeroAddress,
        identity: k.identity?.id ?? zeroHash,
        leaf: 0,
        creator: w.address ?? zeroAddress,
        devBuy: devWei,
        p: params(w.address ?? zeroAddress),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [name, symbol, meta, img, devWei, devDest, feeDest, k.identity, w.address],
  );

  const nameBytes = toBytes(name.trim()).length;
  const formErr =
    !name.trim() ? 'Name your coin.' :
    nameBytes > 32 ? 'Name is over 32 bytes.' :
    !/^[A-Za-z0-9$_.-]{1,12}$/.test(symbol.trim()) ? 'Ticker: 1–12 letters or digits.' :
    toBytes(meta).length > 1024 ? 'Description and links are too long.' :
    devBad ? 'Dev buy is not a number.' : '';

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setImgErr('');
    try {
      setImg(await encodeImage(f));
    } catch (e) {
      setImgErr(errText(e));
    }
  };

  const launch = async () => {
    setErr('');
    setHash(null);
    try {
      if (!LAUNCHPAD) throw new Error('The launchpad is not deployed yet.');
      if (formErr) throw new Error(formErr);
      if (!w.address || w.chainId !== CHAIN_ID) throw new Error('Connect a wallet on Ethereum first.');
      if (!k.identity || !k.vaultId) throw new Error('Unlock your bunker phrase first.');
      if (!w.walletClient) throw new Error('Wallet not ready, try again.');
      const creator = w.address;

      setStep(0);
      const leaf = await k.reserveLeaf();
      const p = params(creator);

      setStep(1);
      const digest = launchDigest({ chainId: CHAIN_ID, launchpad: LAUNCHPAD, identity: k.identity.id, leaf, creator, devBuy: devWei, p });
      const onchain = await client.readContract({
        address: LAUNCHPAD,
        abi: launchpadAbi,
        functionName: 'launchDigest',
        args: [k.identity.id, leaf, creator, devWei, p] as never,
      });
      if (onchain !== digest) throw new Error('The contract computes a different message. Nothing was signed.');
      const sig = await k.signWith(leaf, digest);
      const s = { seed: k.identity.seedHex, root: k.identity.rootHex, leaf, wots: sig.wots, auth: sig.auth };

      setStep(2);
      const { request, result: token } = await client.simulateContract({
        account: creator,
        address: LAUNCHPAD,
        abi: launchpadAbi,
        functionName: 'launch',
        args: [p, s] as never,
        value: devWei,
      });

      setStep(3);
      const gas = await client.estimateContractGas({ ...request, account: creator } as never);
      const h = await w.walletClient.writeContract({ ...(request as object), account: creator, gas: (gas * 12n) / 10n } as never);
      setHash(h);

      setStep(4);
      const r = await client.waitForTransactionReceipt({ hash: h });
      if (r.status !== 'success') throw new Error('The launch transaction reverted.');
      setStep(5);
      m.refresh();
      k.refreshLeaves().catch(() => {});
      go(`#coin/${token}`);
    } catch (e) {
      setErr(errText(e));
      setStep(-1);
    }
  };

  const busy = step >= 0 && step < 5;
  const gasCost = m.gasGwei ? (1_300_000 + (img?.bytes ?? 0) * 24) * m.gasGwei * 1e-9 : null;

  return (
    <section className="sec lp lp-launch">
      <div>
        <a className="dim small mono" href="#launch">← all coins</a>
        <h1 className="display lp-h" style={{ marginTop: 10 }}>Launch a coin</h1>
        <p className="sec-p">
          One transaction creates the token, its Uniswap v4 pool with the whole supply locked in, and your dev buy,
          after the contract checks your post-quantum signature over all of it.
        </p>
        <div className="form">
          <div
            className={`drop ${over ? 'over' : ''}`}
            onClick={() => file.current?.click()}
            onDragOver={e => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={e => {
              e.preventDefault();
              setOver(false);
              onFile(e.dataTransfer.files[0]);
            }}
          >
            <span className="av" style={{ width: 72, height: 72 }}>
              {img ? <img src={img.url} alt="" /> : <span className="dim tiny">image</span>}
            </span>
            <div>
              <b>{img ? 'Change image' : 'Drop an image or click'}</b>
              <div className="dim small">
                Stored on-chain with the coin: squared to 256 px, max {MAX_IMAGE / 1024} KB.
                {img && <span className="dim2"> · {(img.bytes / 1024).toFixed(1)} KB</span>}
              </div>
              {imgErr && <div className="err">{imgErr}</div>}
            </div>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={e => onFile(e.target.files?.[0])} />
          </div>

          <div className="two">
            <label>
              <span className="lbl">Name</span>
              <input className="field" value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="Bunker Cat" />
            </label>
            <label>
              <span className="lbl">Ticker</span>
              <input className="field mono" value={symbol} maxLength={12} onChange={e => setSymbol(e.target.value.replace(/\s/g, '').toUpperCase())} placeholder="BCAT" />
            </label>
          </div>
          <label>
            <span className="lbl">
              Description <em>optional</em>
            </span>
            <textarea className="field" rows={3} value={desc} maxLength={600} onChange={e => setDesc(e.target.value)} />
          </label>
          <div className="three">
            <label>
              <span className="lbl">
                Website <em>optional</em>
              </span>
              <input className="field" value={site} onChange={e => setSite(e.target.value)} placeholder="https://" />
            </label>
            <label>
              <span className="lbl">
                X <em>optional</em>
              </span>
              <input className="field" value={x} onChange={e => setX(e.target.value)} placeholder="https://x.com/…" />
            </label>
            <label>
              <span className="lbl">
                Telegram <em>optional</em>
              </span>
              <input className="field" value={tg} onChange={e => setTg(e.target.value)} placeholder="https://t.me/…" />
            </label>
          </div>

          <div>
            <span className="lbl">
              Dev buy <em>same transaction as the pool, so nobody can get in before you</em>
            </span>
            <div className="trade-amt">
              <input className="field" inputMode="decimal" value={dev} onChange={e => setDev(e.target.value)} placeholder="0" />
              <span className="unit">ETH</span>
            </div>
            <div className="row small dim2" style={{ marginTop: 6, justifyContent: 'space-between' }}>
              <span>{devPct > 0 ? `≈ ${devPct.toFixed(1)}% of the supply` : 'Optional'}</span>
              <span>wallet: {bal == null ? '—' : `${Number(formatEther(bal)).toFixed(4)} ETH`}</span>
            </div>
          </div>

          <div>
            <span className="lbl">Dev bag goes to</span>
            <div className="opt">
              <button className={devDest === 'vault' ? 'on' : ''} onClick={() => setDevDest('vault')}>
                <b>My bunker</b>
                <span>Lands in your BunkerVault. Only your 24 words can move it, no ECDSA key can.</span>
              </button>
              <button className={devDest === 'wallet' ? 'on' : ''} onClick={() => setDevDest('wallet')}>
                <b>My wallet</b>
                <span>Normal tokens in the connected wallet.</span>
              </button>
            </div>
          </div>
          <div>
            <span className="lbl">Your 50% of trading fees goes to</span>
            <div className="opt">
              <button className={feeDest === 'wallet' ? 'on' : ''} onClick={() => setFeeDest('wallet')}>
                <b>My wallet</b>
                <span>ETH lands in the connected wallet on every collect.</span>
              </button>
              <button className={feeDest === 'vault' ? 'on' : ''} onClick={() => setFeeDest('vault')}>
                <b>My bunker</b>
                <span>Fees stack up in your BunkerVault, where only your 24 words reach.</span>
              </button>
            </div>
            <p className="dim small" style={{ marginTop: 6 }}>Either way only your bunker phrase can change it later. The other 50% goes to BUNKER.</p>
          </div>
        </div>
      </div>

      <div className="col sticky" style={{ gap: 14 }}>
        <div className="panel">
          <div className="panel-h">Preview</div>
          <div className="panel-b col" style={{ gap: 12 }}>
            <div className="coin-cell">
              <Avatar token={zeroAddress} image={img?.hex ?? null} size={52} />
              <div style={{ minWidth: 0 }}>
                <div className="nm" style={{ fontSize: 16 }}>{name.trim() || 'Your coin'}</div>
                <div className="tk">${symbol.trim() || 'TICKER'}</div>
              </div>
            </div>
            {desc.trim() && <p className="dim2 small">{desc.trim().slice(0, 180)}</p>}
            <div>
              <div className="row small dim" style={{ justifyContent: 'space-between' }}>
                <span>signature fingerprint</span>
                <span className="mono">{preview.slice(0, 12)}…</span>
              </div>
              <div style={{ marginTop: 6 }}>
                <Fingerprint digest={preview} height={44} width={3} gap={1} />
              </div>
            </div>
            <div className="signs">
              <div>name, ticker, description, links and image</div>
              <div>dev buy amount and where the bag goes</div>
              <div>where your fees go</div>
              <div>the wallet sending the transaction</div>
              <div>this launchpad and this chain</div>
            </div>
            <div className="lkv">
              <span>Start market cap</span>
              <span className="num">{startFdv ? `${startFdv.toFixed(2)} ETH · ${usd(startFdv * (m.usd ?? 0))}` : '—'}</span>
            </div>
            <div className="lkv">
              <span>Network cost</span>
              <span className="num">{gasCost != null ? `~${gasCost < 0.001 ? gasCost.toFixed(5) : gasCost.toFixed(4)} ETH` : '—'}</span>
            </div>
            <div className="lkv">
              <span>Platform fee to launch</span>
              <span className="num">0</span>
            </div>
          </div>
        </div>

        {k.status !== 'ready' ? (
          <KeyGate why="Your coin is signed with keys grown from your bunker phrase. Unlock or create one to launch.">{null}</KeyGate>
        ) : (
          <div className="panel">
            <div className="panel-b col" style={{ gap: 10 }}>
              <div className="row small" style={{ justifyContent: 'space-between' }}>
                <span className="dim">signing as</span>
                <a href="#launch/keys" className="idc">{shortId(k.identity!.id)}</a>
              </div>
              <div className="row small" style={{ justifyContent: 'space-between' }}>
                <span className="dim">one-time keys left</span>
                <span className="num">{1024 - k.used.size}</span>
              </div>
              {!w.address ? (
                <button className="btn primary lg block" disabled={w.connecting} onClick={() => w.connect()}>
                  Connect wallet
                </button>
              ) : w.chainId !== CHAIN_ID ? (
                <button className="btn primary lg block" onClick={() => w.switchChain(CHAIN_ID).catch(e => setErr(errText(e)))}>
                  Switch to Ethereum
                </button>
              ) : (
                <button className="btn primary lg block" disabled={busy || !!formErr || !LAUNCHPAD} onClick={launch}>
                  {!LAUNCHPAD ? 'Launchpad deploys soon' : busy ? 'Launching…' : 'Sign & launch'}
                </button>
              )}
              {formErr && name && <p className="dim small">{formErr}</p>}
              {step >= 0 && (
                <div className="steps">
                  {STEPS.map((s, i) => (
                    <div key={s} className={i < step ? 'done' : i === step ? 'on' : ''}>
                      <i>{i < step ? '✓' : i === step ? '›' : '·'}</i>
                      {s}
                    </div>
                  ))}
                </div>
              )}
              {hash && (
                <p className="small dim2">
                  tx <TxLink h={hash} />
                </p>
              )}
              {err && <p className="err">{err}</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
