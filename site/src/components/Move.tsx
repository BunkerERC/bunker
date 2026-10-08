import { useEffect, useMemo, useState } from 'react';
import { getAddress } from 'viem';
import { CHAINS, txUrl, type ChainInfo } from '../chains';
import { usePrices, type Prices } from '../prices';
import { fmtAmt, fmtUsd, short, toNum } from '../lib/format';
import { addCustomToken, assetUsd, readEvmChain, sumUsd, type Asset } from '../lib/scan';
import {
  checkDestination,
  destFormat,
  destVerdict,
  planNativeSweep,
  sweepChain,
  type DestCheck,
  type NativePlan,
  type Step,
} from '../lib/sweep';
import { useEvmAddress, type ChainState } from '../lib/useEvmAddress';
import { useWallet, walletErrorMessage } from '../wallet';
import { Chip, Logo, Spinner, StepIcon } from './ui';

export function Move() {
  const w = useWallet();
  const prices = usePrices();
  const src = useEvmAddress(w.address, { nfts: true });
  const [dest, setDest] = useState('');
  const [checks, setChecks] = useState<DestCheck['perChain']>([]);
  const [touched, setTouched] = useState<Set<number>>(new Set());

  const fmtErr = dest.trim() ? destFormat(dest, w.address) : null;
  const destAddr = !fmtErr && dest.trim() ? getAddress(dest.trim()) : undefined;

  useEffect(() => {
    setChecks([]);
    if (!destAddr) return;
    let dead = false;
    checkDestination(destAddr, (r) => !dead && setChecks((p) => [...p.filter((x) => x.chainId !== r.chainId), r]));
    return () => {
      dead = true;
    };
  }, [destAddr]);
  const dv = destVerdict(checks);
  const ready = !!destAddr && dv.ok;

  const rows = useMemo(
    () =>
      CHAINS.map((c) => {
        const s = src.chains[c.id];
        const all = s ? [...s.assets, ...s.extra, ...s.nfts].filter((a) => a.raw > 0n) : [];
        return { c, s, all, value: sumUsd(all, prices) };
      }),
    [src.chains, prices],
  );
  const withAssets = rows.filter((r) => r.all.length > 0 || touched.has(r.c.id)).sort((a, b) => b.value - a.value);
  const loading = rows.filter((r) => !r.s || r.s.status === 'loading');
  const emptyDone = rows.filter((r) => r.s?.status === 'done' && r.all.length === 0 && !touched.has(r.c.id));
  const total = rows.reduce((t, r) => t + r.value, 0);

  if (!w.address) {
    return (
      <section className="sec" id="move">
        <MoveHead />
        <div className="panel">
          <div className="panel-body" style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
            <div className="big-note">Connect the wallet you want to empty.</div>
            <div className="dim2" style={{ maxWidth: 560 }}>
              MOVE reads its balances on 7 EVM chains, then sweeps the ones you tick to a fresh address that has never signed.
              Everything is a normal transfer signed in your wallet. No contracts, no custody.
            </div>
            <button className="btn primary" onClick={() => w.connect()} disabled={w.connecting}>
              {w.connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
            {w.error && <div className="err">{w.error}</div>}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="sec" id="move">
      <MoveHead />
      <div className="steps2">
        <div className="panel">
          <div className="panel-head">
            <span className="step-n">1</span>
            <span className="kicker">source</span>
            <span className="mono" style={{ fontSize: 12.5 }}>
              {w.address}
            </span>
            <Chip status={src.verdict.status} />
            <span className="grow" style={{ flex: 1 }} />
            <span className="mono">{loading.length ? <Spinner /> : fmtUsd(total)}</span>
          </div>
          <div className="panel-body dim2" style={{ fontSize: 12.5 }}>
            {src.verdict.reason}
            {src.verdict.status === 'hidden' && (
              <div className="amber" style={{ marginTop: 6 }}>
                This wallet never signed: it already is a bunker. Moving out of it means signing, which exposes it. Only move if you
                plan to retire it.
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className={`step-n ${ready ? '' : 'off'}`}>2</span>
            <span className="kicker">bunker (fresh address)</span>
          </div>
          <div className="panel-body">
            <div className="dest-row">
              <input
                className="field"
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder="0x… a NEW address from your wallet that has never signed anything"
                spellCheck={false}
                aria-label="Destination address"
              />
            </div>
            {fmtErr && <div className="err">✗ {fmtErr}</div>}
            {destAddr && (
              <>
                <div className="chainchecks">
                  {CHAINS.map((c) => {
                    const r = checks.find((x) => x.chainId === c.id);
                    const bad = r && (r.error || (r.nonce ?? 0) > 0 || (r.code && r.code !== '0x'));
                    return (
                      <span key={c.id} className="cc" title={r ? `nonce ${r.nonce ?? '?'} · code ${r.code && r.code !== '0x' ? 'yes' : 'none'}` : 'checking'}>
                        <Logo src={c.logo} size={13} />
                        {c.short}
                        {!r ? <Spinner size={8} /> : bad ? <span className="bad">✗</span> : <span className="ok">✓</span>}
                      </span>
                    );
                  })}
                </div>
                {dv.error && <div className="err">✗ {dv.error}</div>}
                {ready && <div className="okline">✓ Never signed on any chain, no code. Valid bunker.</div>}
              </>
            )}
            <details className="help">
              <summary>how to get a fresh address</summary>
              <ul>
                <li>
                  <b>MetaMask:</b> account menu → <b>Add account</b>.
                </li>
                <li>
                  <b>Rabby:</b> <b>Add address</b> → <b>Create new address</b>.
                </li>
                <li>
                  <b>Hardware (Ledger/Trezor):</b> use the next account index.
                </li>
                <li>
                  Same seed phrase is fine. Copy the address, paste it here, and <b>never sign anything with it</b>. Not even a login.
                </li>
              </ul>
            </details>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className={`step-n ${ready ? '' : 'off'}`}>3</span>
            <span className="kicker">move, chain by chain</span>
            <span className="dim" style={{ fontSize: 12 }}>
              Tokens first, native coin last (minus gas).
            </span>
          </div>
          {withAssets.map(({ c, s, all, value }) => (
            <ChainMove
              key={c.id}
              chain={c}
              state={s}
              assets={all}
              value={value}
              prices={prices}
              dest={ready ? destAddr : undefined}
              onRefresh={() => src.refresh(c.id)}
              onStart={() => setTouched((t) => new Set(t).add(c.id))}
            />
          ))}
          {loading.length > 0 && (
            <div className="empty-line" style={{ paddingTop: 12 }}>
              <Spinner /> reading {loading.map((r) => r.c.short).join(' · ')}…
            </div>
          )}
          {emptyDone.length > 0 && (
            <div className="empty-line" style={{ paddingTop: 12 }}>
              <span className="logos">
                {emptyDone.map((r) => (
                  <Logo key={r.c.id} src={r.c.logo} size={14} />
                ))}
              </span>
              nothing to move on {emptyDone.map((r) => r.c.short).join(' · ')}
            </div>
          )}
        </div>
      </div>
      <div className="rule">
        <b>The rule after this:</b> if you ever sign with the bunker address, its key is public. Move the rest to the next fresh
        address. Same seed is fine. Calm, not rushed.
      </div>
    </section>
  );
}

function MoveHead() {
  return (
    <div className="sec-head">
      <h1 className="display sec-h">Move</h1>
      <p className="sec-p">Sweep a wallet into a fresh address whose public key is still behind a hash.</p>
    </div>
  );
}

function defaultChecked(a: Asset) {
  if (a.kind === 'native') return true;
  if (a.kind === 'erc721') return false;
  return a.known;
}

function ChainMove({
  chain,
  state,
  assets,
  value,
  prices,
  dest,
  onRefresh,
  onStart,
}: {
  chain: ChainInfo;
  state?: ChainState;
  assets: Asset[];
  value: number;
  prices: Prices;
  dest?: `0x${string}`;
  onRefresh(): void;
  onStart(): void;
}) {
  const w = useWallet();
  const [over, setOver] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<'auto' | 'sequential'>('auto');
  const [steps, setSteps] = useState<Step[]>([]);
  const [phase, setPhase] = useState<'idle' | 'switching' | 'running' | 'done' | 'failed'>('idle');
  const [err, setErr] = useState<string>();
  const [after, setAfter] = useState<{ left: Asset[]; mode: string; dust?: bigint }>();
  const [plan, setPlan] = useState<NativePlan>();
  const [tok, setTok] = useState('');
  const [tokErr, setTokErr] = useState<string>();
  const [tokBusy, setTokBusy] = useState(false);

  const sorted = useMemo(
    () =>
      [...assets].sort((a, b) => {
        if (a.kind === 'native') return -1;
        if (b.kind === 'native') return 1;
        return (assetUsd(b, prices) ?? -1) - (assetUsd(a, prices) ?? -1);
      }),
    [assets, prices],
  );
  const isOn = (a: Asset) => over[a.key] ?? defaultChecked(a);
  const selected = sorted.filter(isOn);
  const nativeSel = selected.find((a) => a.kind === 'native');
  const selUsd = sumUsd(selected, prices);

  // pre-flight gas math for the dust note
  useEffect(() => {
    setPlan(undefined);
    if (!dest || !nativeSel || !w.address) return;
    let dead = false;
    planNativeSweep(chain.id, w.address, dest).then(
      (p) => !dead && setPlan(p),
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [dest, chain.id, w.address, !!nativeSel, nativeSel?.raw]); // eslint-disable-line react-hooks/exhaustive-deps

  const nativePrice = prices[chain.nativePrice];
  const dustNative = plan ? toNum(plan.dustMax, 18) : undefined;
  const busy = phase === 'switching' || phase === 'running';

  const move = async () => {
    if (!dest || !w.address || !w.provider) return;
    onStart();
    setErr(undefined);
    setAfter(undefined);
    setSteps([]);
    setPhase('switching');
    try {
      await w.switchChain(chain.id);
    } catch (e) {
      setErr(walletErrorMessage(e));
      setPhase('idle');
      return;
    }
    setPhase('running');
    const res = await sweepChain({
      provider: w.provider,
      chainId: chain.id,
      from: w.address,
      to: dest,
      assets: selected,
      mode,
      onSteps: setSteps,
    });
    try {
      const r = await readEvmChain(w.address, chain.id);
      setAfter({ left: r.assets.filter((a) => a.raw > 0n), mode: res.mode, dust: res.dustMax });
    } catch {
      setAfter({ left: [], mode: res.mode, dust: res.dustMax });
    }
    setPhase(res.ok ? 'done' : 'failed');
    onRefresh();
  };

  const addTok = async () => {
    setTokErr(undefined);
    setTokBusy(true);
    try {
      await addCustomToken(chain.id, tok.trim());
      setTok('');
      onRefresh();
    } catch (e) {
      setTokErr((e as Error).message);
    } finally {
      setTokBusy(false);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--line)' }}>
      <div className="panel-head" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="mv-head" style={{ width: '100%' }}>
          <Logo src={chain.logo} size={18} />
          <span className="name">{chain.name}</span>
          <span className="tot">{fmtUsd(value)}</span>
          {state?.indexer === 'loading' && (
            <span className="dim" style={{ fontSize: 11 }}>
              <Spinner size={9} /> indexer
            </span>
          )}
          <span className="grow" />
          <select className="field" value={mode} onChange={(e) => setMode(e.target.value as 'auto' | 'sequential')} disabled={busy} aria-label="Send mode">
            <option value="auto">auto (batch if wallet can)</option>
            <option value="sequential">one tx per asset</option>
          </select>
          <button className="btn primary sm" disabled={!dest || !selected.length || busy || !w.provider} onClick={move}>
            {phase === 'switching' ? 'switching…' : phase === 'running' ? 'moving…' : `Move to bunker${selected.length ? ` · ${fmtUsd(selUsd)}` : ''}`}
          </button>
        </div>
      </div>
      <div>
        {sorted.map((a) => {
          const usd = assetUsd(a, prices);
          return (
            <div className="asset-row" key={a.key}>
              <label>
                <input
                  type="checkbox"
                  checked={isOn(a)}
                  disabled={busy}
                  onChange={(e) => setOver((o) => ({ ...o, [a.key]: e.target.checked }))}
                />
                <Logo src={a.logo} size={16} square={a.kind === 'erc721'} />
                <span className="sym">
                  {a.kind === 'erc721' ? `${a.symbol} #${short(String(a.tokenId), 4)}` : a.symbol}
                </span>
                {a.kind === 'erc721' && <span className="tag">NFT</span>}
                {a.kind === 'erc20' && !a.known && <span className="tag">unknown</span>}
                {a.source === 'custom' && <span className="tag">custom</span>}
              </label>
              <span className="amt">{a.kind === 'erc721' ? '1' : fmtAmt(a.amount)}</span>
              <span className="usd">{fmtUsd(usd)}</span>
            </div>
          );
        })}
      </div>
      <div className="addtok">
        <input className="field" value={tok} onChange={(e) => setTok(e.target.value)} placeholder={`+ token address on ${chain.name}`} spellCheck={false} aria-label={`Add token on ${chain.name}`} />
        <button className="btn sm" disabled={!tok.trim() || tokBusy} onClick={addTok}>
          {tokBusy ? <Spinner size={9} /> : 'add'}
        </button>
      </div>
      {tokErr && (
        <div className="err" style={{ padding: '0 12px 8px', marginTop: 0 }}>
          {tokErr}
        </div>
      )}
      {nativeSel && plan && phase === 'idle' && (
        <div className="result dim" style={{ fontSize: 12 }}>
          Native sweep leaves dust ≤ {fmtAmt(dustNative!)} {chain.nativeSymbol}
          {nativePrice !== undefined ? ` (${fmtUsd(dustNative! * nativePrice)})` : ''} for gas safety
          {chain.opStack ? ', incl. L1 data fee' : chain.nitro ? ', L1 cost included in gas' : ''}.
        </div>
      )}
      {err && (
        <div className="err" style={{ padding: '0 12px 10px' }}>
          ✗ {err}
        </div>
      )}
      {steps.length > 0 && (
        <div className="log">
          {steps.map((s) => (
            <div className="log-row" key={s.id}>
              <StepIcon status={s.status} />
              <span>
                {s.label}{' '}
                <span className="note">
                  {s.status === 'wallet' ? 'confirm in wallet…' : s.status === 'pending' ? 'waiting for block…' : s.note ?? ''}
                </span>
              </span>
              {s.hash ? (
                <a className="mono dim2" style={{ fontSize: 11.5 }} href={txUrl(chain.id, s.hash)} target="_blank" rel="noreferrer">
                  {short(s.hash, 5)} ↗
                </a>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
      )}
      {after && (
        <div className="result">
          {phase === 'done' ? <b className="green">✓ Moved ({after.mode === 'batch' ? 'one atomic batch' : 'one tx per asset'}).</b> : <b className="red">✗ Stopped.</b>}{' '}
          Source now holds on {chain.name}:{' '}
          {after.left.length === 0 ? (
            <b>nothing</b>
          ) : (
            after.left.map((a, i) => (
              <span key={a.key} className="mono">
                {i > 0 ? ', ' : ''}
                {fmtAmt(a.amount)} {a.symbol}
                {assetUsd(a, prices) !== undefined ? ` (${fmtUsd(assetUsd(a, prices))})` : ''}
              </span>
            ))
          )}
          {phase === 'done' && (
            <div style={{ marginTop: 6 }}>
              From now on: if you ever sign with the bunker address, move the rest to the next fresh address.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
