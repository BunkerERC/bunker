import { useCallback, useEffect, useMemo, useState } from 'react';
import { CHAINS, addrUrl, type ChainInfo } from '../chains';
import { usePrices, type Prices } from '../prices';
import { btcLabel, classifyBtc, classifySol, detectAddress, isContractCode, isDelegation, type Status, type Verdict } from '../lib/exposure';
import { fmtAmt, fmtUsd } from '../lib/format';
import { assetPrice, assetUsd, readBtc, readSol, sumUsd, type Asset, type BtcRead, type SolRead } from '../lib/scan';
import { useEvmAddress, type ChainState } from '../lib/useEvmAddress';
import { Chip, CopyBtn, Logo, Spinner } from './ui';
import { ShareButton, type CardData } from './ShareCard';

export interface Totals {
  status: Status;
  value: number;
  atRisk: number;
}
type Report = (key: string, t: Totals | null) => void;

export const MAX_ADDR = 25;

/** Results for a list of addresses (EVM / BTC / SOL), with a running total of value at risk. */
export function ScanResults({ list }: { list: string[] }) {
  const [totals, setTotals] = useState<Record<string, Totals>>({});

  const report: Report = useCallback((key, t) => {
    setTotals((prev) => {
      if (!t) {
        const { [key]: _drop, ...rest } = prev;
        void _drop;
        return rest;
      }
      const p = prev[key];
      if (p && p.status === t.status && p.value === t.value && p.atRisk === t.atRisk) return prev;
      return { ...prev, [key]: t };
    });
  }, []);

  const agg = useMemo(() => {
    const vals = Object.values(totals);
    return {
      risk: vals.reduce((s, t) => s + t.atRisk, 0),
      exposed: vals.filter((t) => t.status === 'exposed').length,
      hidden: vals.filter((t) => t.status === 'hidden').length,
      warn: vals.filter((t) => t.status === 'warn').length,
      pending: list.length - vals.filter((t) => t.status !== 'pending').length,
    };
  }, [totals, list.length]);

  if (!list.length) return null;
  const shareUrl = `${location.origin}${location.pathname}#scan?a=${list.join(',')}`;
  return (
    <div className="panel results">
      <div className="sumbar">
        <div className="sum-item">
          <span className="sum-k">value on public keys</span>
          <span className={`sum-v ${agg.risk > 0 ? 'red' : ''}`}>{fmtUsd(agg.risk)}</span>
        </div>
        <div className="sum-item">
          <span className="sum-k">addresses</span>
          <span className="sum-v sum-counts">
            <span className="red">{agg.exposed} exposed</span>
            <span className="green">{agg.hidden} hidden</span>
            {agg.warn > 0 && <span className="amber">{agg.warn} check</span>}
            {agg.pending > 0 && <Spinner />}
          </span>
        </div>
        <span className="grow" />
        <CopyBtn text={shareUrl} label="copy link to this scan" />
      </div>
      {list.map((a) => (
        <Group key={a} raw={a} report={report} />
      ))}
    </div>
  );
}

function Group({ raw, report }: { raw: string; report: Report }) {
  const d = detectAddress(raw);
  useEffect(() => () => report(raw, null), [raw, report]);
  if (d.kind === 'evm') return <EvmGroup address={d.address} rk={raw} report={report} />;
  if (d.kind === 'btc') return <BtcGroup address={d.address} rk={raw} btcType={d.btcType} report={report} />;
  if (d.kind === 'sol') return <SolGroup address={d.address} rk={raw} report={report} />;
  return (
    <div className="grp">
      <div className="grp-head">
        <Chip status="warn" label="✗ invalid" />
        <div className="grp-addr">
          <span className="addr">{raw}</span>
        </div>
        <span />
        <div className="grp-reason">{d.why}</div>
      </div>
    </div>
  );
}

function GroupHead({
  verdict,
  address,
  kind,
  atRisk,
  value,
  explorer,
  extra,
  share,
}: {
  verdict: Verdict;
  address: string;
  kind: string;
  atRisk: number;
  value: number;
  explorer?: string;
  extra?: React.ReactNode;
  /** card data once the verdict is final; null while loading; undefined = no share button */
  share?: CardData | null;
}) {
  const [why, setWhy] = useState(false);
  return (
    <div className="grp-head">
      <Chip status={verdict.status} />
      <div className="grp-addr">
        {explorer ? (
          <a className="addr" href={explorer} target="_blank" rel="noreferrer">
            {address}
          </a>
        ) : (
          <span className="addr">{address}</span>
        )}
        <span className="badge">{kind}</span>
        <CopyBtn text={address} />
        {share !== undefined && <ShareButton data={share} />}
      </div>
      <div className="grp-risk">
        <small>at risk</small>
        <span className={atRisk > 0 ? 'red' : verdict.status === 'warn' && value > 0 ? 'amber' : 'dim2'}>
          {verdict.status === 'pending' ? <Spinner /> : fmtUsd(atRisk)}
        </span>
      </div>
      <div className="grp-reason">
        {verdict.reason}{' '}
        {verdict.caveat && (
          <button className="linkish" onClick={() => setWhy((w) => !w)}>
            {why ? 'hide caveat' : 'caveat'}
          </button>
        )}
        {why && verdict.caveat && <div className="caveat">{verdict.caveat}</div>}
        {extra}
      </div>
    </div>
  );
}

/* ---------------- EVM ---------------- */

function chainValue(s: ChainState | undefined, prices: Prices) {
  if (!s) return { value: 0, unpriced: 0, all: [] as Asset[] };
  const all = [...s.assets, ...s.extra].filter((a) => a.raw > 0n);
  const value = sumUsd(all, prices);
  const unpriced = all.filter((a) => assetPrice(a, prices) === undefined).length;
  return { value, unpriced, all };
}

function rowReason(c: ChainInfo, s: ChainState, verdict: Verdict, signedOn: string[]): string {
  if (s.status === 'error') return "RPC didn't answer";
  if (s.status === 'loading') return 'reading…';
  if (isDelegation(s.code)) return '7702-delegated here';
  if (isContractCode(s.code)) return 'contract code here';
  if ((s.nonce ?? 0) > 0) return `signed ${s.nonce} tx here`;
  if (verdict.status === 'exposed') return `nonce 0 here; key public via ${signedOn.join(', ') || 'another chain'}`;
  if (verdict.status === 'hidden') return 'nonce 0 · no code';
  return 'nonce 0 here';
}

function EvmGroup({ address, rk, report }: { address: `0x${string}`; rk: string; report: Report }) {
  const prices = usePrices();
  const { chains, verdict, safe, refresh } = useEvmAddress(address);
  const [open, setOpen] = useState<number | null>(null);

  const signedOn = CHAINS.filter((c) => (chains[c.id]?.nonce ?? 0) > 0 || isDelegation(chains[c.id]?.code)).map((c) => c.name);
  const rows = CHAINS.map((c) => ({ c, s: chains[c.id], ...chainValue(chains[c.id], prices) }));
  const active = rows.filter(
    ({ s, all }) =>
      !s || s.status !== 'done' || (s.nonce ?? 0) > 0 || (s.code && s.code !== '0x') || all.length > 0,
  );
  active.sort((a, b) => b.value - a.value);
  const empty = rows.filter((r) => !active.includes(r));
  const value = rows.reduce((t, r) => t + r.value, 0);
  const atRisk = verdict.status === 'exposed' ? value : 0;
  const settled = rows.every(r => r.s && r.s.status !== 'loading');
  const share: CardData | null = settled && (verdict.status === 'exposed' || verdict.status === 'hidden')
    ? {
        status: verdict.status, address, kind: 'EVM',
        detail: verdict.status === 'hidden' ? `Never signed on ${CHAINS.length} chains` : signedOn.length ? `Signed on ${signedOn.slice(0, 3).join(', ')}${signedOn.length > 3 ? ` +${signedOn.length - 3} more` : ''}` : 'Public key on-chain',
        usd: verdict.status === 'exposed' ? atRisk : value,
      }
    : null;

  useEffect(() => {
    report(rk, { status: verdict.status, value, atRisk });
  }, [rk, report, verdict.status, value, atRisk]);

  return (
    <div className="grp">
      <GroupHead
        verdict={verdict}
        address={address}
        kind="EVM"
        atRisk={atRisk}
        value={value}
        explorer={addrUrl(1, address)}
        share={share}
        extra={
          safe && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {safe.owners.map((o, i) => (
                <span key={o} className="cc" title="Safe owner">
                  <Chip status={safe.ownerStatus[i]} label={safe.ownerStatus[i] === 'pending' ? '…' : safe.ownerStatus[i] === 'exposed' ? '✗' : safe.ownerStatus[i] === 'hidden' ? '✓' : '⚠︎'} />
                  <span className="mono">{o.slice(0, 6)}…{o.slice(-4)}</span>
                </span>
              ))}
            </div>
          )
        }
      />
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 150 }}>chain</th>
            <th style={{ width: 96 }}>status</th>
            <th>reason</th>
            <th>assets</th>
            <th className="right" style={{ width: 90 }}>
              value
            </th>
            <th className="right" style={{ width: 90 }}>
              at risk
            </th>
          </tr>
        </thead>
        <tbody>
          {active.map(({ c, s, value: v, unpriced, all }) => {
            const loading = !s || s.status === 'loading';
            const st: Status = loading ? 'pending' : s.status === 'error' ? 'warn' : verdict.status;
            const isOpen = open === c.id;
            return (
              <FragmentRow key={c.id}>
                <tr className="r click" onClick={() => setOpen(isOpen ? null : c.id)} aria-expanded={isOpen}>
                  <td className="c-chain">
                    <div className="cell-chain">
                      <Logo src={c.logo} />
                      <span>{c.name}</span>
                    </div>
                  </td>
                  <td className="c-status">
                    <Chip status={st} />
                  </td>
                  <td className="c-reason reason-cell">
                    {s ? rowReason(c, s, verdict, signedOn) : 'reading…'}
                    {s?.status === 'error' && (
                      <>
                        {' '}
                        <button
                          className="linkish"
                          onClick={(e) => {
                            e.stopPropagation();
                            refresh(c.id);
                          }}
                        >
                          retry
                        </button>
                      </>
                    )}
                  </td>
                  <td className="c-assets">
                    <AssetSummary all={all} prices={prices} loading={loading} indexer={s?.indexer} />
                  </td>
                  <td className="c-value num">
                    {loading ? '' : fmtUsd(v)}
                    {unpriced > 0 && !loading && <span className="dim"> +{unpriced}</span>}
                  </td>
                  <td className="c-risk num">
                    {loading ? <Spinner /> : st === 'exposed' && v > 0 ? <span className="red">{fmtUsd(v)}</span> : <span className="dim">$0</span>}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="details">
                    <td colSpan={6}>
                      <AssetDetails all={all} prices={prices} indexer={s?.indexer} chain={c} address={address} />
                    </td>
                  </tr>
                )}
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
      {empty.length > 0 && (
        <div className="empty-line">
          <span className="logos">
            {empty.map(({ c }) => (
              <Logo key={c.id} src={c.logo} size={14} />
            ))}
          </span>
          <span>
            {empty.length} chain{empty.length > 1 ? 's' : ''} empty, never signed: {empty.map(({ c }) => c.short).join(' · ')}
          </span>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function AssetSummary({ all, prices, loading, indexer }: { all: Asset[]; prices: Prices; loading: boolean; indexer?: string }) {
  if (loading) return <Spinner />;
  const sorted = [...all].sort((a, b) => (assetUsd(b, prices) ?? -1) - (assetUsd(a, prices) ?? -1));
  const top = sorted.slice(0, 3);
  return (
    <div className="cell-assets">
      {top.length === 0 && <span className="dim">empty</span>}
      {top.map((a) => (
        <span className="a" key={a.key}>
          <Logo src={a.logo} size={14} />
          {fmtAmt(a.amount)} {a.symbol}
        </span>
      ))}
      {sorted.length > 3 && <span className="dim">+{sorted.length - 3}</span>}
      {indexer === 'loading' && (
        <span className="dim" title="Blockscout indexer: more tokens incoming">
          <Spinner size={9} />
        </span>
      )}
    </div>
  );
}

function AssetDetails({
  all,
  prices,
  indexer,
  chain,
  address,
}: {
  all: Asset[];
  prices: Prices;
  indexer?: string;
  chain: ChainInfo;
  address: string;
}) {
  const sorted = [...all].sort((a, b) => (assetUsd(b, prices) ?? -1) - (assetUsd(a, prices) ?? -1));
  return (
    <div>
      <table className="dtl">
        <tbody>
          {sorted.map((a) => {
            const p = assetPrice(a, prices);
            return (
              <tr key={a.key}>
                <td>
                  <span className="tok">
                    <Logo src={a.logo} size={14} />
                    <span>{a.symbol}</span>
                    {a.source === 'indexer' && <span className="tag">indexer</span>}
                    {a.source === 'custom' && <span className="tag">custom</span>}
                  </span>
                </td>
                <td className="num mono dim2">{fmtAmt(a.amount)}</td>
                <td className="num mono dim">{p === undefined ? '—' : `@ ${fmtUsd(p)}`}</td>
                <td className="num mono">{fmtUsd(assetUsd(a, prices))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="dim" style={{ fontSize: 11.5, marginTop: 6 }}>
        {chain.blockscout
          ? indexer === 'loading'
            ? 'Blockscout indexer still loading more tokens…'
            : indexer === 'error'
              ? 'Indexer unavailable: curated tokens only.'
              : 'Curated tokens via RPC + Blockscout index.'
          : 'Curated majors via RPC multicall. Add any token in MOVE.'}{' '}
        <a href={addrUrl(chain.id, address)} target="_blank" rel="noreferrer" className="dim2">
          explorer ↗
        </a>
      </div>
    </div>
  );
}

/* ---------------- Bitcoin ---------------- */

function BtcGroup({ address, rk, btcType, report }: { address: string; rk: string; btcType: import('../lib/exposure').BtcType; report: Report }) {
  const prices = usePrices();
  const [st, setSt] = useState<{ s: 'loading' | 'done' | 'error'; d?: BtcRead }>({ s: 'loading' });
  const [n, setN] = useState(0);
  useEffect(() => {
    let dead = false;
    setSt({ s: 'loading' });
    readBtc(address).then(
      (d) => !dead && setSt({ s: 'done', d }),
      () => !dead && setSt({ s: 'error' }),
    );
    return () => {
      dead = true;
    };
  }, [address, n]);
  const d = st.d;
  const verdict: Verdict =
    btcType === 'p2tr'
      ? classifyBtc({ btcType, spentTxo: 0, mempoolSpentTxo: 0 })
      : d
        ? classifyBtc({ btcType, spentTxo: d.spentTxo, mempoolSpentTxo: d.mempoolSpentTxo })
        : st.s === 'error'
          ? { status: 'warn', reason: "mempool.space didn't answer. Retry." }
          : { status: 'pending', reason: 'reading mempool.space…' };
  const btc = d ? Number(d.sats) / 1e8 : 0;
  const value = prices.btc !== undefined ? btc * prices.btc : 0;
  const atRisk = verdict.status === 'exposed' ? value : 0;
  useEffect(() => report(rk, { status: verdict.status, value, atRisk }), [rk, report, verdict.status, value, atRisk]);
  return (
    <div className="grp">
      <GroupHead
        verdict={verdict} address={address} kind={btcLabel(btcType)} atRisk={atRisk} value={value} explorer={`https://mempool.space/address/${address}`}
        share={st.s === 'done' && (verdict.status === 'exposed' || verdict.status === 'hidden') ? {
          status: verdict.status, address, kind: btcLabel(btcType),
          detail: btcType === 'p2tr' ? 'Taproot: the public key is in the address' : verdict.status === 'exposed' ? 'Spent from before: key revealed on-chain' : 'Never spent from: key still behind a hash',
          usd: verdict.status === 'exposed' ? atRisk : value,
        } : null}
      />
      <table className="tbl">
        <tbody>
          <tr className="r">
            <td className="c-chain" style={{ width: 150 }}>
              <div className="cell-chain">
                <Logo src="/chains/bitcoin.png" />
                <span>Bitcoin</span>
              </div>
            </td>
            <td className="c-status" style={{ width: 96 }}>
              <Chip status={verdict.status} />
            </td>
            <td className="c-reason reason-cell">
              {d ? `${d.txCount} tx · spent ${d.spentTxo + d.mempoolSpentTxo}×` : st.s === 'error' ? (
                <button className="linkish" onClick={() => setN((x) => x + 1)}>
                  retry
                </button>
              ) : (
                'reading…'
              )}
            </td>
            <td className="c-assets">
              {st.s === 'loading' ? (
                <Spinner />
              ) : (
                <div className="cell-assets">
                  <span className="a">
                    <Logo src="/chains/bitcoin.png" size={14} />
                    {fmtAmt(btc)} BTC
                  </span>
                </div>
              )}
            </td>
            <td className="c-value num" style={{ width: 90 }}>
              {d ? fmtUsd(prices.btc !== undefined ? value : undefined) : ''}
            </td>
            <td className="c-risk num" style={{ width: 90 }}>
              {st.s === 'loading' ? <Spinner /> : atRisk > 0 ? <span className="red">{fmtUsd(atRisk)}</span> : <span className="dim">$0</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- Solana ---------------- */

function SolGroup({ address, rk, report }: { address: string; rk: string; report: Report }) {
  const prices = usePrices();
  const [st, setSt] = useState<{ s: 'loading' | 'done' | 'error'; d?: SolRead }>({ s: 'loading' });
  useEffect(() => {
    let dead = false;
    readSol(address).then(
      (d) => !dead && setSt({ s: 'done', d }),
      () => !dead && setSt({ s: 'error' }),
    );
    return () => {
      dead = true;
    };
  }, [address]);
  const verdict = classifySol();
  const d = st.d;
  const sol = d ? Number(d.lamports) / 1e9 : 0;
  const stable = d ? d.tokens.filter((t) => t.known).reduce((s, t) => s + t.amount, 0) : 0;
  const value = (prices.sol !== undefined ? sol * prices.sol : 0) + stable;
  useEffect(() => report(rk, { status: 'exposed', value, atRisk: value }), [rk, report, value]);
  const shown = d ? d.tokens.slice(0, 2) : [];
  return (
    <div className="grp">
      <GroupHead
        verdict={verdict} address={address} kind="Solana · ed25519" atRisk={value} value={value} explorer={`https://solscan.io/account/${address}`}
        share={st.s !== 'loading' ? { status: 'exposed', address, kind: 'Solana', detail: 'Solana: the address is the public key', usd: value } : null}
      />
      <table className="tbl">
        <tbody>
          <tr className="r">
            <td className="c-chain" style={{ width: 150 }}>
              <div className="cell-chain">
                <Logo src="/chains/solana.png" />
                <span>Solana</span>
              </div>
            </td>
            <td className="c-status" style={{ width: 96 }}>
              <Chip status="exposed" />
            </td>
            <td className="c-reason reason-cell">address = public key</td>
            <td className="c-assets">
              {st.s === 'loading' ? (
                <Spinner />
              ) : st.s === 'error' ? (
                <span className="dim">balance unavailable</span>
              ) : (
                <div className="cell-assets">
                  <span className="a">
                    <Logo src="/chains/solana.png" size={14} />
                    {fmtAmt(sol)} SOL
                  </span>
                  {shown.map((t) => (
                    <span className="a" key={t.mint}>
                      <Logo src={t.logo} size={14} />
                      {fmtAmt(t.amount)} {t.symbol}
                    </span>
                  ))}
                  {d && d.tokens.length > 2 && <span className="dim">+{d.tokens.length - 2}</span>}
                </div>
              )}
            </td>
            <td className="c-value num" style={{ width: 90 }}>
              {d ? fmtUsd(prices.sol !== undefined ? value : undefined) : ''}
            </td>
            <td className="c-risk num" style={{ width: 90 }}>
              {st.s === 'loading' ? <Spinner /> : value > 0 ? <span className="red">{fmtUsd(value)}</span> : <span className="dim">$0</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
