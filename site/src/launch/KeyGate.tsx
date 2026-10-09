import { useMemo, useState, type ReactNode } from 'react';
import { useKeys } from './keys';
import { isPhrase, newPhrase, phraseEntropy } from './pq/phrase';
import { errText } from './format';

/** Renders children once the bunker phrase is unlocked; otherwise create / open / unlock a saved one. */
export default function KeyGate({ children, why }: { children: ReactNode; why?: ReactNode }) {
  const k = useKeys();
  if (k.status === 'ready') return <>{children}</>;
  if (k.status === 'building') return <Building done={k.progress} />;
  return <Unlock why={why} />;
}

export function Building({ done }: { done: number }) {
  return (
    <div className="panel">
      <div className="panel-h">
        Growing your 1,024 one-time launch keys <span className="grow" />
        <span className="num dim2">{done}/1024</span>
      </div>
      <div className="panel-b">
        <div className="leafmap" aria-hidden>
          {Array.from({ length: 1024 }, (_, i) => (
            <i key={i} className={i < done ? 'b' : ''} />
          ))}
        </div>
        <div className="build">
          <i style={{ width: `${(done / 1024) * 100}%` }} />
        </div>
        <p className="dim small" style={{ marginTop: 10 }}>
          About a million keccak256 hashes across your CPU cores. Only the public tree is cached; the phrase never
          leaves this tab.
        </p>
      </div>
    </div>
  );
}

function Unlock({ why }: { why?: ReactNode }) {
  const k = useKeys();
  const [mode, setMode] = useState<'start' | 'create' | 'import' | 'saved'>(k.saved ? 'saved' : 'start');
  const [phrase, setPhrase] = useState('');
  const [typed, setTyped] = useState(['', '']);
  const [wrote, setWrote] = useState(false);
  const [input, setInput] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const words = phrase ? phrase.split(' ') : [];
  const quiz = useMemo(() => [Math.floor(Math.random() * 12), 12 + Math.floor(Math.random() * 12)], [phrase]);
  const quizOk = words.length === 24 && quiz.every((q, i) => typed[i].trim().toLowerCase() === words[q]);

  const run = async (f: () => Promise<void>) => {
    setErr('');
    setBusy(true);
    try {
      await f();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-h">
        Bunker phrase <span className="lchip">locked</span>
      </div>
      <div className="panel-b col" style={{ gap: 12 }}>
        {why && <p className="dim2">{why}</p>}

        {mode === 'start' && (
          <>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={() => { setPhrase(newPhrase()); setMode('create'); }}>
                Create a bunker phrase
              </button>
              <button className="btn" onClick={() => setMode('import')}>I have one</button>
              {k.saved && <button className="btn" onClick={() => setMode('saved')}>Unlock {k.saved}</button>}
            </div>
            <p className="dim small">
              The same 24 words open your BunkerVault and sign your launches. Made in this browser, never your wallet's
              seed and never an ECDSA key, so breaking wallets tells an attacker nothing about it.
            </p>
          </>
        )}

        {mode === 'create' && (
          <>
            <p className="warn-text">
              Write these 24 words on paper. They are the only way to sign as this creator, move your fee share or open
              your bunker. Nobody can recover them, us included.
            </p>
            <ol className="phrase-grid">
              {words.map((w, i) => (
                <li key={i}><span>{i + 1}</span>{w}</li>
              ))}
            </ol>
            <div className="vault-quiz">
              {quiz.map((q, i) => (
                <label key={q}>
                  word #{q + 1}
                  <input
                    className="field mono"
                    value={typed[i]}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={e => setTyped(t => t.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                </label>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={wrote} onChange={e => setWrote(e.target.checked)} /> I wrote all 24 words down offline
            </label>
            <div className="row">
              <button className="btn primary" disabled={!quizOk || !wrote || busy} onClick={() => run(() => k.unlock(phraseEntropy(phrase)))}>
                Grow my keys
              </button>
              <button className="btn" onClick={() => { setMode('start'); setPhrase(''); setTyped(['', '']); setWrote(false); }}>
                Back
              </button>
            </div>
          </>
        )}

        {mode === 'import' && (
          <>
            <textarea
              className="field mono phrase-input"
              rows={3}
              placeholder="24-word bunker phrase"
              value={input}
              autoComplete="off"
              spellCheck={false}
              onChange={e => { setInput(e.target.value); setErr(''); }}
            />
            <div className="row">
              <button
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (!isPhrase(input)) throw new Error('That is not a valid 24-word bunker phrase.');
                    const e = phraseEntropy(input);
                    setInput('');
                    await k.unlock(e);
                  })
                }
              >
                Unlock
              </button>
              <button className="btn" onClick={() => setMode('start')}>Back</button>
            </div>
            <p className="dim small">Kept in memory only. A reload locks it again unless you save it with a passcode.</p>
          </>
        )}

        {mode === 'saved' && (
          <>
            <p className="dim2 small">
              Saved on this device, encrypted: <span className="idc">{k.saved}</span>
            </p>
            <input
              className="field"
              type="password"
              placeholder="passcode"
              value={pass}
              autoFocus
              onChange={e => setPass(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && pass && run(() => k.unseal(pass))}
            />
            <div className="row">
              <button className="btn primary" disabled={!pass || busy} onClick={() => run(() => k.unseal(pass))}>
                {busy ? 'Decrypting…' : 'Unlock'}
              </button>
              <button className="btn" onClick={() => setMode('start')}>Use the phrase instead</button>
            </div>
          </>
        )}
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}
