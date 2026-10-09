import { useEffect, useMemo, useState } from 'react';
import { hexToBytes, keccak256, toBytes } from 'viem';
import { LAUNCHPAD } from './config';
import { useMarket } from './data';
import { shortId } from './keys';
import { ago, compact, pct, usd } from './format';
import { digitsOf } from './pq/xmss.js';
import { launchInfo, type CoinRow, type LaunchInfo, type Stats24 } from './market';
import { imageUrl } from './image';
import { Avatar, Fingerprint, Matrix, Spin, go } from './ui';

type Sort = 'new' | 'mcap' | 'vol';

export default function LaunchHome() {
  const m = useMarket();
  const [sort, setSort] = useState<Sort>('new');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const rows = useMemo(() => {
    const list = [...(m.coins ?? [])];
    if (sort === 'mcap') list.sort((a, b) => b.mcapEth - a.mcapEth);
    if (sort === 'vol') list.sort((a, b) => (m.stats[b.poolId]?.vol ?? 0) - (m.stats[a.poolId]?.vol ?? 0));
    return list;
  }, [m.coins, m.stats, sort]);
  const empty = !LAUNCHPAD || (m.coins !== null && rows.length === 0);

  return (
    <section className="sec lp" id="launch">
      <div className="lp-head">
        <div>
          <h1 className="display lp-h">Launch from<br />the bunker.</h1>
          <p className="sec-p">
            Coins signed with a post-quantum key. The launch transaction checks a hash-based signature over every field
            of the coin before it exists, then burns that key. Liquidity is locked forever. Creators keep 50% of the
            trading fees.
          </p>
          <div className="row" style={{ marginTop: 18, flexWrap: 'wrap' }}>
            <a className="btn primary lg" href="#launch/new">Launch a coin</a>
            <a className="btn lg" href="#launch/keys">My launch keys</a>
          </div>
        </div>
        <div className="lp-spec">
          <div><span>Signature</span><b>XMSS · WOTS w16</b></div>
          <div><span>Checked by</span><b>the launch tx</b></div>
          <div><span>Pool</span><b>Uniswap v4 · ETH · 1%</b></div>
          <div><span>Liquidity</span><b>100% locked forever</b></div>
          <div><span>Fees</span><b><em>50%</em> creator · 50% BUNKER</b></div>
          <div><span>Dev bag</span><b>wallet or your bunker</b></div>
          <div><span>Launch fee · admin keys</span><b>0 · 0</b></div>
        </div>
      </div>

      {empty ? (
        <Bench live={!!LAUNCHPAD} />
      ) : (
        <>
          <div className="lp-board-h">
            <h2 className="display">Coins</h2>
            <span className="dim mono small">{m.coins?.length ?? 0} live</span>
            <span className="grow" />
            <div className="seg">
              {([['new', 'New'], ['mcap', 'Top'], ['vol', 'Volume']] as const).map(([k, l]) => (
                <button key={k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{l}</button>
              ))}
            </div>
            <div className="seg hide-sm">
              <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')}>Grid</button>
              <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button>
            </div>
          </div>
          {m.error && <p className="err" style={{ marginBottom: 10 }}>RPC: {m.error}</p>}
          {m.coins === null ? (
            <div className="panel lp-empty"><Spin /></div>
          ) : view === 'grid' ? (
            <div className="lcards">
              {rows.map(c => <Card key={c.token} c={c} s={m.stats[c.poolId]} u={m.usd ?? 0} />)}
            </div>
          ) : (
            <div className="panel" style={{ overflowX: 'auto' }}><Board rows={rows} /></div>
          )}
        </>
      )}

      <div className="lp-steps">
        <div><span className="n">01</span><b>Phrase</b><p>One 24-word bunker phrase grows 1,024 one-time launch keys in your browser. Same phrase opens your vault.</p></div>
        <div><span className="n">02</span><b>Sign</b><p>One key signs everything: name, ticker, image, dev buy, where the bag and the fees go, your wallet.</p></div>
        <div><span className="n">03</span><b>Verify</b><p>The launch transaction checks the signature and burns the key before the coin exists. No server.</p></div>
        <div><span className="n">04</span><b>Trade</b><p>Plain Uniswap v4 pool, whole supply locked from block one, dev buy in the same transaction.</p></div>
      </div>
    </section>
  );
}

function useLaunch(c: CoinRow | null) {
  const [info, setInfo] = useState<LaunchInfo | null>(null);
  useEffect(() => {
    if (!c) return setInfo(null);
    let dead = false;
    launchInfo(c.token, c.launchBlock).then(i => !dead && setInfo(i)).catch(() => {});
    return () => {
      dead = true;
    };
  }, [c?.token, c?.launchBlock]); // eslint-disable-line react-hooks/exhaustive-deps
  return info;
}

function Card({ c, s, u }: { c: CoinRow; s?: Stats24; u: number }) {
  const info = useLaunch(c);
  const url = imageUrl(info?.image);
  const open = () => go(`#coin/${c.token}`);
  return (
    <div className="lcard" onClick={open} role="link" tabIndex={0} onKeyDown={e => e.key === 'Enter' && open()}>
      <div className="lcard-img">
        {url ? <img src={url} alt={`${c.name} image`} loading="lazy" /> : <Fingerprint digest={info?.digest} height={60} width={2} gap={1} />}
        <span className="lchip ok badge">✓ PQ · #{c.leaf}</span>
        <span className="age">{ago(c.launchedAt)}</span>
      </div>
      <div className="lcard-b">
        <div className="lcard-t">
          <b>${c.symbol}</b>
          <span>{c.name}</span>
        </div>
        <Fingerprint digest={info?.digest} height={12} gap={1} fill />
        <div className="lcard-n">
          <div><span className="k">MCap</span><span className="v">{usd(c.mcapEth * u)}</span></div>
          <div><span className="k">24h</span><span className={`v ${s?.change == null ? '' : s.change >= 0 ? 'green' : 'red'}`}>{pct(s?.change)}</span></div>
          <div><span className="k">Vol</span><span className="v">{s ? usd(s.vol * u) : '—'}</span></div>
        </div>
        <div className="row small dim">by <span className="idc">{shortId(c.identity)}</span></div>
      </div>
    </div>
  );
}

function Board({ rows }: { rows: CoinRow[] }) {
  const m = useMarket();
  const u = m.usd ?? 0;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Coin</th>
          <th className="hide-sm">Signature</th>
          <th>Age</th>
          <th className="num">MCap</th>
          <th className="num hide-sm">24h vol</th>
          <th className="num">24h</th>
          <th className="num hide-sm">Txns</th>
          <th className="hide-sm">Creator</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(c => {
          const s = m.stats[c.poolId];
          return (
            <tr key={c.token} className="click" onClick={() => go(`#coin/${c.token}`)}>
              <td>
                <div className="coin-cell">
                  <Avatar token={c.token} launchBlock={c.launchBlock} size={34} />
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">{c.name}</div>
                    <div className="tk">${c.symbol}</div>
                  </div>
                </div>
              </td>
              <td className="hide-sm"><RowPrint c={c} /></td>
              <td className="dim2 num">{ago(c.launchedAt)}</td>
              <td className="num">{usd(c.mcapEth * u)}</td>
              <td className="num hide-sm">{s ? usd(s.vol * u) : '—'}</td>
              <td className={`num ${s?.change == null ? 'dim' : s.change >= 0 ? 'green' : 'red'}`}>{pct(s?.change)}</td>
              <td className="num dim2 hide-sm">{s ? compact(s.trades, 0) : '—'}</td>
              <td className="hide-sm"><span className="idc">{shortId(c.identity)}</span></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RowPrint({ c }: { c: CoinRow }) {
  const info = useLaunch(c);
  return (
    <span className="row" title="The 67 digits this coin's one-time key signed. Checked on-chain at launch.">
      <Fingerprint digest={info?.digest} height={16} />
      <span className="lchip ok">✓ #{c.leaf}</span>
    </span>
  );
}

/** Empty board: type a ticker, watch the real Winternitz encoding of a message about it light up. */
function Bench({ live }: { live: boolean }) {
  const [t, setT] = useState('BUNKER');
  const tick = t.trim().toUpperCase() || 'BUNKER';
  const digest = useMemo(() => keccak256(toBytes(`bunker/launch/bench/${tick}`)), [tick]);
  const digits = useMemo(() => digitsOf(hexToBytes(digest)), [digest]);
  const steps = digits.reduce((a, d) => a + (15 - d), 0);
  return (
    <div className="lp-bench">
      <div className="lp-bench-l">
        <span className="kicker">{live ? 'No coins yet. Be the first.' : 'Launchpad deploys soon. Make your phrase now.'}</span>
        <h2 className="display">Type a ticker.<br />Watch it get signed.</h2>
        <p className="dim2">
          The real Winternitz encoding: 64 message digits and 3 checksum digits (yellow), each a hash chain 16 steps
          tall. Change one letter and the whole signature moves. A real launch signs every field of the coin.
        </p>
        <div className="lp-bench-in">
          <span>$</span>
          <input value={t} maxLength={12} spellCheck={false} aria-label="ticker" onChange={e => setT(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} />
        </div>
        <a className="btn primary lg" href={`#launch/new?ticker=${encodeURIComponent(tick)}`}>Launch ${tick} →</a>
      </div>
      <div className="lp-bench-r">
        <div className="k">
          <span>67 chains × 16 steps</span>
          <span>verifier walks {steps} hashes</span>
        </div>
        <Matrix digest={digest} />
        <div className="hexline">
          {digits.slice(0, 64).map(d => d.toString(16)).join('')}
          <b>{digits.slice(64).map(d => d.toString(16)).join('')}</b>
        </div>
      </div>
    </div>
  );
}
