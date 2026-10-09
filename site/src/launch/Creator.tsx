import { useEffect, useState } from 'react';
import launchpadAbi from './abi/BunkerLaunchpad';
import { LAUNCHPAD } from './config';
import { useKeys, shortId } from './keys';
import { useMarket } from './data';
import { client } from './market';
import { ago, errText, usd } from './format';
import { Avatar, Copy, go } from './ui';
import KeyGate from './KeyGate';

export default function Creator() {
  const k = useKeys();
  return (
    <section className="sec lp">
      <div className="keys col" style={{ gap: 14 }}>
        <div>
          <a className="dim small mono" href="#launch">← all coins</a>
          <h1 className="display lp-h" style={{ marginTop: 10 }}>Launch keys</h1>
          <p className="sec-p">
            A Merkle tree of 1,024 Winternitz one-time keys, grown from your 24-word bunker phrase. Its root is your
            public creator key. Each launch, and each change to where your fees go, burns one key on-chain.
          </p>
        </div>
        <KeyGate>{k.identity && <Ready />}</KeyGate>
      </div>
    </section>
  );
}

function Ready() {
  const k = useKeys();
  const m = useMarket();
  const id = k.identity!;
  const [onchain, setOnchain] = useState<{ firstSeen: number; launches: number } | null>(null);
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    k.refreshLeaves().catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!LAUNCHPAD) return;
    client
      .readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: 'identities', args: [id.id] })
      .then(r => setOnchain({ firstSeen: Number((r as readonly [bigint, number])[0]), launches: Number((r as readonly [bigint, number])[1]) }))
      .catch(() => {});
  }, [id.id, k.usedOnChain]);

  const mine = (m.coins ?? []).filter(c => c.identity.toLowerCase() === id.id.toLowerCase());
  const pending = [...k.used].filter(l => !k.usedOnChain.has(l));

  const save = async () => {
    setMsg(null);
    if (p1.length < 8) return setMsg({ ok: false, t: 'Use at least 8 characters.' });
    if (p1 !== p2) return setMsg({ ok: false, t: 'The two passcodes differ.' });
    setBusy(true);
    try {
      await k.seal(p1);
      setP1('');
      setP2('');
      setMsg({ ok: true, t: 'Saved on this device, encrypted (AES-GCM, PBKDF2 600k).' });
    } catch (e) {
      setMsg({ ok: false, t: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel">
        <div className="panel-h">
          Creator key <span className="idc">{shortId(id.id)}</span>
          <span className="grow" />
          <button className="btn sm" onClick={k.lock}>Lock</button>
        </div>
        <div className="panel-b">
          <div className="lkv"><span>Identity</span><Copy text={id.id} label={<span className="mono">{id.id.slice(0, 18)}…</span>} /></div>
          <div className="lkv"><span>Merkle root</span><Copy text={id.rootHex} label={<span className="mono">{id.rootHex.slice(0, 18)}…</span>} /></div>
          <div className="lkv"><span>Public seed</span><Copy text={id.seedHex} label={<span className="mono">{id.seedHex.slice(0, 18)}…</span>} /></div>
          <div className="lkv"><span>On-chain since</span><span>{!onchain ? '…' : onchain.firstSeen ? `${ago(onchain.firstSeen)} ago` : 'your first launch registers it'}</span></div>
          <div className="lkv"><span>Launches</span><span className="num">{onchain ? onchain.launches : '…'}</span></div>
          <div className="lkv"><span>Bunker (vault account)</span><a href="#vault" className="mono dim2">{k.vaultId?.slice(0, 18)}… →</a></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          One-time keys <span className="grow" />
          <span className="num small dim2">{k.usedOnChain.size} burned · {1024 - k.used.size} free</span>
        </div>
        <div className="panel-b">
          <div className="leafmap">
            {Array.from({ length: 1024 }, (_, i) => (
              <i key={i} className={k.usedOnChain.has(i) ? 'b' : k.used.has(i) ? 'u' : ''} title={`key #${i}`} />
            ))}
          </div>
          <p className="dim small" style={{ marginTop: 10 }}>
            <span className="accent">■</span> burned on-chain · <span className="amber">■</span> signed in this browser, not landed (never reused) ·
            keys are picked at random, so two devices almost never reach for the same one.
            {pending.length > 0 && ` ${pending.length} signed-but-not-landed.`}
          </p>
        </div>
      </div>

      {mine.length > 0 && (
        <div className="panel">
          <div className="panel-h">Coins you launched</div>
          <table className="tbl">
            <tbody>
              {mine.map(c => (
                <tr key={c.token} className="click" onClick={() => go(`#coin/${c.token}`)}>
                  <td><div className="coin-cell"><Avatar token={c.token} launchBlock={c.launchBlock} size={28} /><b>{c.name}</b><span className="tk">${c.symbol}</span></div></td>
                  <td className="num">{usd(c.mcapEth * (m.usd ?? 0))}</td>
                  <td className="num dim2">key #{c.leaf}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <div className="panel-h">Remember on this device</div>
        <div className="panel-b col" style={{ gap: 10 }}>
          {k.saved ? (
            <div className="row">
              <span className="small dim2">Saved: <span className="idc">{k.saved}</span>. Unlock with your passcode after a reload.</span>
              <span className="grow" />
              <button className="btn sm" onClick={k.forget}>Forget</button>
            </div>
          ) : (
            <>
              <p className="dim small">Optional. Encrypts the phrase with a passcode and keeps it in this browser, so you don’t retype 24 words. Anyone with this device and the passcode can sign as you.</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8 }}>
                <input className="field" type="password" placeholder="passcode" value={p1} onChange={e => setP1(e.target.value)} />
                <input className="field" type="password" placeholder="again" value={p2} onChange={e => setP2(e.target.value)} />
                <button className="btn" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
              </div>
            </>
          )}
          {msg && <p className={msg.ok ? 'ok' : 'err'}>{msg.t}</p>}
        </div>
      </div>
    </>
  );
}
