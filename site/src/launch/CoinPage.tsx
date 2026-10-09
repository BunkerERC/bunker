import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatEther, formatUnits, getAddress, hexToBytes, isAddress, parseEther, parseUnits, zeroAddress, zeroHash, type Hex } from 'viem';
import launchpadAbi from './abi/BunkerLaunchpad';
import tokenAbi from './abi/BunkerLaunchToken';
import { CHAIN_ID, DEAD, LAUNCHPAD, POOL_MANAGER, VAULT } from './config';
import { useMarket } from './data';
import { useKeys, shortId } from './keys';
import { useWallet } from '../wallet';
import { feeDigest, launchDigest } from './pq/digest';
import * as xmss from './pq/xmss.js';
import {
  client,
  blockClock,
  holders as loadHolders,
  launchInfo,
  launchShape,
  loadOne,
  pendingFees,
  quote,
  swapsSince,
  type CoinRow,
  type Holder,
  type LaunchInfo,
  type Swap,
} from './market';
import { ago, compact, errText, eth, pct, short, tiny, tokens, usd } from './format';
import { AddrLink, Avatar, Copy, Ext, Fingerprint, Spin, TxLink } from './ui';
import Chart, { candles } from './Chart';

/** https URLs only (no javascript:, data:, etc.), from untrusted on-chain metadata. */
function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

export default function CoinPage({ address }: { address: Hex }) {
  const token = getAddress(address);
  const m = useMarket();
  const fromBoard = m.coins?.find(c => c.token.toLowerCase() === token.toLowerCase()) ?? null;
  const [row, setRow] = useState<CoinRow | null>(fromBoard);
  const [missing, setMissing] = useState(false);
  const [info, setInfo] = useState<LaunchInfo | null>(null);
  const [swaps, setSwaps] = useState<Swap[] | null>(null);
  const [clock, setClock] = useState<((b: bigint) => number) | null>(null);
  const [startPrice, setStartPrice] = useState(0);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);

  // coin + launch logs
  useEffect(() => {
    if (!LAUNCHPAD) return;
    let dead = false;
    loadOne(token)
      .then(r => {
        if (dead) return;
        if (!r) return setMissing(true);
        setRow(r);
        launchInfo(token, r.launchBlock).then(i => !dead && setInfo(i)).catch(() => {});
      })
      .catch(() => {});
    launchShape().then(s => !dead && setStartPrice(s.startPriceEth)).catch(() => {});
    return () => {
      dead = true;
    };
  }, [token, tick]);

  // trades: full history once, then poll
  useEffect(() => {
    if (!row) return;
    let dead = false;
    const load = async () => {
      try {
        const latest = await client.getBlock();
        const s = await swapsSince([row.poolId], row.launchBlock, latest.number);
        if (dead) return;
        setClock(() => blockClock({ block: row.launchBlock, ts: row.launchedAt }, { block: latest.number, ts: Number(latest.timestamp) }));
        setSwaps(s);
      } catch {
        if (!dead) setSwaps(x => x ?? []);
      }
    };
    load();
    const t = setInterval(() => !document.hidden && load(), 12_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [row?.poolId, row?.launchBlock, row?.launchedAt, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  const u = m.usd ?? 0;
  const last = swaps?.length ? swaps[swaps.length - 1].priceEth : row?.priceEth ?? 0;
  const dayAgo = Date.now() / 1000 - 86_400;
  const s24 = useMemo(() => {
    if (!swaps || !clock || !row) return null;
    const w = swaps.filter(s => clock(s.block) >= dayAgo);
    const ref = row.launchedAt > dayAgo ? startPrice : w[0]?.preEth;
    return { vol: w.reduce((a, s) => a + s.eth, 0), trades: w.length, change: ref ? (last / ref - 1) * 100 : null };
  }, [swaps, clock, row, startPrice, last, dayAgo]);

  if (!LAUNCHPAD) return <section className="sec lp"><div className="panel lp-empty"><b>The launchpad is not deployed yet.</b><a href="#launch">Back to the launchpad</a></div></section>;
  if (missing) return <section className="sec lp"><div className="panel lp-empty"><b>No coin at this address on {short(LAUNCHPAD)}.</b><a href="#launch">Back to coins</a></div></section>;
  if (!row) return <section className="sec lp"><div className="panel lp-empty"><Spin /></div></section>;

  const meta = info?.meta ?? {};
  // metadata is whatever the launcher put on-chain: only ever link plain https URLs
  const link = { website: safeUrl(meta.website), x: safeUrl(meta.x), telegram: safeUrl(meta.telegram) };
  return (
    <section className="sec lp lp-coin">
      <a className="dim small mono" href="#launch">← all coins</a>
      <div className="coin-top">
        <Avatar token={token} launchBlock={row.launchBlock} size={56} />
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <h1>{row.name}</h1>
            <span className="tk">${row.symbol}</span>
            <span className="lchip ok" title="The launch transaction verified this coin's hash-based signature">✓ PQ-signed · key #{row.leaf}</span>
          </div>
          <div className="row small dim2" style={{ marginTop: 4, flexWrap: 'wrap', gap: 12 }}>
            <span>
              CA <Copy text={token} label={<span className="mono">{short(token, 6)}</span>} />
            </span>
            <span>
              by <span className="idc">{shortId(row.identity)}</span> · <AddrLink a={row.creator} />
            </span>
            <span>{ago(row.launchedAt)} ago</span>
          </div>
        </div>
        <span className="grow" />
        <div className="coin-links">
          {link.website && <Ext href={link.website} className="btn sm">Website</Ext>}
          {link.x && <Ext href={link.x} className="btn sm">X</Ext>}
          {link.telegram && <Ext href={link.telegram} className="btn sm">Telegram</Ext>}
          <Ext href={`https://etherscan.io/token/${token}`} className="btn sm">Etherscan</Ext>
          <Ext href={`https://dexscreener.com/ethereum/${row.poolId}`} className="btn sm">DEX Screener</Ext>
        </div>
      </div>
      {meta.description && <p className="dim2" style={{ margin: '-4px 0 14px', maxWidth: 780 }}>{meta.description}</p>}

      <div className="lstats">
        <div><div className="k">Price</div><div className="v">{usd(last * u)}</div></div>
        <div><div className="k">Market cap</div><div className="v">{usd(last * 1e9 * u)}</div></div>
        <div><div className="k">24h volume</div><div className="v">{s24 ? usd(s24.vol * u) : '—'}</div></div>
        <div><div className="k">24h</div><div className={`v ${s24?.change == null ? '' : s24.change >= 0 ? 'green' : 'red'}`}>{pct(s24?.change)}</div></div>
        <div><div className="k">Trades 24h</div><div className="v">{s24 ? compact(s24.trades, 0) : '—'}</div></div>
        <div><div className="k">Liquidity</div><div className="v" style={{ fontSize: 13 }}>100% locked</div></div>
      </div>

      <div className="lgrid">
        <div className="col" style={{ gap: 14, minWidth: 0 }}>
          <div className="c-chart"><ChartPanel row={row} swaps={swaps} clock={clock} startPrice={startPrice} usdRate={u} /></div>
          <div className="c-lower"><Lower row={row} info={info} swaps={swaps} clock={clock} usdRate={u} /></div>
        </div>
        <div className="col" style={{ gap: 14 }}>
          <div className="c-trade"><Trade row={row} priceEth={last} onDone={refresh} /></div>
          <div className="c-att"><Attestation row={row} info={info} /></div>
          <div className="c-fees"><Fees row={row} usdRate={u} onDone={refresh} /></div>
          <div className="c-creator"><CreatorControls row={row} onDone={refresh} /></div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- chart

function ChartPanel({ row, swaps, clock, startPrice, usdRate }: { row: CoinRow; swaps: Swap[] | null; clock: ((b: bigint) => number) | null; startPrice: number; usdRate: number }) {
  const [iv, setIv] = useState(60);
  const [mode, setMode] = useState<'mcap' | 'price'>('mcap');
  const data = useMemo(() => {
    if (!swaps || !clock || !startPrice) return [];
    const scale = (mode === 'mcap' ? 1e9 : 1) * (usdRate || 1);
    return candles(swaps.map(s => ({ ts: clock(s.block), pre: s.preEth, post: s.priceEth })), { ts: row.launchedAt, price: startPrice }, iv, scale);
  }, [swaps, clock, startPrice, iv, mode, usdRate, row.launchedAt]);
  return (
    <div className="panel" style={{ overflow: 'hidden' }}>
      <div className="chart-h">
        <div className="seg">
          {[[60, '1m'], [300, '5m'], [900, '15m'], [3600, '1h'], [14400, '4h']].map(([v, l]) => (
            <button key={v} className={iv === v ? 'on' : ''} onClick={() => setIv(v as number)}>{l}</button>
          ))}
        </div>
        <span className="grow" />
        <div className="seg">
          <button className={mode === 'mcap' ? 'on' : ''} onClick={() => setMode('mcap')}>MCap</button>
          <button className={mode === 'price' ? 'on' : ''} onClick={() => setMode('price')}>Price</button>
        </div>
      </div>
      {data.length ? <Chart data={data} money={usdRate > 0} /> : <div className="chart-box empty"><Spin /></div>}
    </div>
  );
}

// ---------------------------------------------------------------- trades / holders / signature tabs

function Lower({ row, info, swaps, clock, usdRate }: { row: CoinRow; info: LaunchInfo | null; swaps: Swap[] | null; clock: ((b: bigint) => number) | null; usdRate: number }) {
  const [tab, setTab] = useState<'trades' | 'holders' | 'sig'>('trades');
  return (
    <div className="panel" style={{ overflow: 'hidden' }}>
      <div className="ltabs">
        <button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Trades</button>
        <button className={tab === 'holders' ? 'on' : ''} onClick={() => setTab('holders')}>Holders</button>
        <button className={tab === 'sig' ? 'on' : ''} onClick={() => setTab('sig')}>Signature</button>
      </div>
      {tab === 'trades' && <Trades swaps={swaps} clock={clock} usdRate={usdRate} symbol={row.symbol} />}
      {tab === 'holders' && <Holders row={row} info={info} />}
      {tab === 'sig' && <Verify row={row} info={info} />}
    </div>
  );
}

function Trades({ swaps, clock, usdRate, symbol }: { swaps: Swap[] | null; clock: ((b: bigint) => number) | null; usdRate: number; symbol: string }) {
  const recent = useMemo(() => (swaps ?? []).slice(-60).reverse(), [swaps]);
  const [makers, setMakers] = useState<Record<string, Hex>>({});
  useEffect(() => {
    const need = recent.filter(s => !makers[s.tx]).slice(0, 40);
    if (!need.length) return;
    let dead = false;
    Promise.all(need.map(s => client.getTransaction({ hash: s.tx }).then(t => [s.tx, t.from] as const).catch(() => null))).then(r => {
      if (dead) return;
      setMakers(mk => ({ ...mk, ...Object.fromEntries(r.filter(Boolean) as [string, Hex][]) }));
    });
    return () => {
      dead = true;
    };
  }, [recent]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!swaps) return <div className="empty"><Spin /></div>;
  if (!recent.length) return <div className="empty">No trades yet.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl">
        <thead>
          <tr><th>Age</th><th>Type</th><th className="num">USD</th><th className="num hide-sm">ETH</th><th className="num">{symbol}</th><th className="num hide-sm">Price</th><th>Maker</th><th className="hide-sm" /></tr>
        </thead>
        <tbody>
          {recent.map(s => (
            <tr key={s.tx + s.logIndex}>
              <td className="dim2 num">{clock ? ago(clock(s.block)) : '—'}</td>
              <td className={s.buy ? 'green' : 'red'}>{s.buy ? 'Buy' : 'Sell'}</td>
              <td className={`num ${s.buy ? 'green' : 'red'}`}>{usd(s.eth * usdRate, 2)}</td>
              <td className="num hide-sm">{s.eth < 0.001 ? tiny(s.eth) : s.eth.toFixed(4)}</td>
              <td className="num">{compact(s.tokens, 2)}</td>
              <td className="num dim2 hide-sm">{usd(s.priceEth * usdRate)}</td>
              <td>{makers[s.tx] ? <AddrLink a={makers[s.tx]} /> : <span className="dim">…</span>}</td>
              <td className="num hide-sm"><TxLink h={s.tx}>↗</TxLink></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Holders({ row, info }: { row: CoinRow; info: LaunchInfo | null }) {
  const [list, setList] = useState<Holder[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let dead = false;
    loadHolders(row.token, row.launchBlock).then(l => !dead && setList(l)).catch(e => !dead && setErr(errText(e)));
    return () => {
      dead = true;
    };
  }, [row.token, row.launchBlock]);
  const label = (a: Hex) => {
    const x = a.toLowerCase();
    if (x === POOL_MANAGER.toLowerCase()) return <span className="lchip acc">Uniswap v4 pool · locked</span>;
    if (VAULT && x === VAULT.toLowerCase()) return <span className="lchip acc">BunkerVault</span>;
    if (x === DEAD.toLowerCase()) return <span className="lchip">burn</span>;
    if (x === row.creator.toLowerCase()) return <span className="lchip warn">creator</span>;
    if (info && x === info.devTo?.toLowerCase()) return <span className="lchip warn">dev</span>;
    return null;
  };
  if (err) return <div className="empty err">{err}</div>;
  if (!list) return <div className="empty"><Spin /></div>;
  const total = 1e9;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl">
        <thead><tr><th>#</th><th>Holder</th><th /><th className="num">Amount</th><th className="num">%</th></tr></thead>
        <tbody>
          {list.slice(0, 25).map((h, i) => {
            const amt = Number(formatUnits(h.balance, 18));
            return (
              <tr key={h.address}>
                <td className="dim num">{i + 1}</td>
                <td><AddrLink a={h.address} n={6} /></td>
                <td>{label(h.address)}</td>
                <td className="num">{compact(amt, 2)}</td>
                <td className="num">{((amt / total) * 100).toFixed(2)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="dim small" style={{ padding: '10px 12px' }}>{list.length} holders. The BunkerVault row holds bags that only a bunker phrase can move.</p>
    </div>
  );
}

/** Re-runs the launch signature check in the browser, from the launch logs alone. */
function Verify({ row, info }: { row: CoinRow; info: LaunchInfo | null }) {
  const [res, setRes] = useState<null | { digestOk: boolean; rootOk: boolean; idOk: boolean; burned: boolean; digits: number[]; leafHash: string; path: xmss.Trace['path']; digest: Hex }>(null);
  const [shown, setShown] = useState(0);
  const [err, setErr] = useState('');
  const run = async () => {
    setErr('');
    setRes(null);
    setShown(0);
    try {
      if (!info || !LAUNCHPAD) throw new Error('Launch logs not loaded yet.');
      const digest = launchDigest({
        chainId: CHAIN_ID,
        launchpad: LAUNCHPAD,
        identity: info.identity,
        leaf: info.leaf,
        creator: info.creator,
        devBuy: info.devBuy,
        p: { name: info.name, symbol: info.symbol, meta: info.metaRaw, image: info.image, devTo: info.devTo, devVault: info.devVault, feeTo: info.feeTo, feeVault: info.feeVault },
      });
      const trace: xmss.Trace = {};
      const root = xmss.rootFromSignature(hexToBytes(info.seed), info.leaf, hexToBytes(digest), info.wots, info.auth, trace);
      const id = xmss.toHex(xmss.identityId(hexToBytes(info.seed), hexToBytes(info.root)));
      const burned = (await client.readContract({ address: LAUNCHPAD, abi: launchpadAbi, functionName: 'isLeafUsed', args: [row.identity, info.leaf] })) as boolean;
      setRes({
        digestOk: digest === info.digest,
        rootOk: xmss.toHex(root) === info.root.toLowerCase(),
        idOk: id === row.identity.toLowerCase(),
        burned,
        digits: trace.digits!,
        leafHash: trace.leafHash!,
        path: trace.path!,
        digest,
      });
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        setShown(n);
        if (n > 67 + 10) clearInterval(t);
      }, 18);
    } catch (e) {
      setErr(errText(e));
    }
  };
  const all = res && res.digestOk && res.rootOk && res.idOk && res.burned;
  return (
    <div className="panel-b col" style={{ gap: 12 }}>
      <p className="dim2 small">
        The launch transaction already checked this signature, or the coin would not exist. This re-runs the same
        math here, with nothing but keccak256 and the launch logs: no server, no ECDSA.
      </p>
      <div className="row">
        <button className="btn primary" onClick={run} disabled={!info}>Verify in my browser</button>
        {res && <span className={all ? 'lchip ok' : 'lchip bad'}>{all ? '✓ valid post-quantum signature' : '✗ mismatch'}</span>}
      </div>
      {err && <p className="err">{err}</p>}
      {res && (
        <>
          <div className="lkv"><span>1 · message rebuilt from public fields</span><span className={res.digestOk ? 'green' : 'red'}>{res.digestOk ? '✓ ' : '✗ '}{short(res.digest, 8)}</span></div>
          <div className="digits">
            {res.digits.map((d, i) => (
              <span key={i} className={`${i >= 64 ? 'ck' : ''} ${i < shown ? 'hot' : ''}`}>{i < shown ? d.toString(16) : '·'}</span>
            ))}
          </div>
          <div className="lkv"><span>2 · 67 hash chains finished → leaf #{info!.leaf}</span><span className="mono dim2">{short(res.leafHash, 8)}</span></div>
          <div className="climb">
            {res.path!.map((p, i) => (
              <div key={i} className={shown > 67 + i ? 'done' : ''}>
                <span>level {p.height}</span>
                <span>{shown > 67 + i ? short(p.node, 10) : '…'}</span>
              </div>
            ))}
          </div>
          <div className="lkv"><span>3 · root matches the creator’s key</span><span className={res.rootOk ? 'green' : 'red'}>{res.rootOk ? '✓' : '✗'} {short(info!.root, 8)}</span></div>
          <div className="lkv"><span>4 · key belongs to creator {shortId(row.identity)}</span><span className={res.idOk ? 'green' : 'red'}>{res.idOk ? '✓' : '✗'}</span></div>
          <div className="lkv"><span>5 · one-time key #{info!.leaf} burned on-chain</span><span className={res.burned ? 'green' : 'red'}>{res.burned ? '✓' : '✗'}</span></div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- right column

function Trade({ row, priceEth, onDone }: { row: CoinRow; priceEth: number; onDone: () => void }) {
  const w = useWallet();
  const m = useMarket();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amt, setAmt] = useState('');
  const [slip, setSlip] = useState(5);
  const [q, setQ] = useState<bigint | null>(null);
  const [qErr, setQErr] = useState('');
  const [bal, setBal] = useState<{ eth: bigint; tok: bigint } | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; t: string; h?: Hex } | null>(null);
  const [n, setN] = useState(0);

  let wei = 0n;
  try {
    wei = amt.trim() ? (side === 'buy' ? parseEther(amt.trim()) : parseUnits(amt.trim(), 18)) : 0n;
  } catch {
    wei = -1n;
  }

  useEffect(() => {
    if (!w.address) return setBal(null);
    Promise.all([
      client.getBalance({ address: w.address }),
      client.readContract({ address: row.token, abi: tokenAbi, functionName: 'balanceOf', args: [w.address] }) as Promise<bigint>,
    ]).then(([e, t]) => setBal({ eth: e, tok: t })).catch(() => {});
  }, [w.address, row.token, n]);

  useEffect(() => {
    setQ(null);
    setQErr('');
    if (wei <= 0n) return;
    let dead = false;
    const t = setTimeout(() => {
      quote(row.token, side === 'buy', wei)
        .then(r => !dead && setQ(r))
        .catch(e => !dead && setQErr(errText(e)));
    }, 250);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [wei, side, row.token]);

  const presets = side === 'buy' ? ['0.01', '0.05', '0.1', '0.5'] : ['25', '50', '75', '100'];
  const go = async () => {
    setMsg(null);
    try {
      if (!w.address || !w.walletClient) throw new Error('Connect a wallet.');
      if (w.chainId !== CHAIN_ID) await w.switchChain(CHAIN_ID);
      if (wei <= 0n) throw new Error('Enter an amount.');
      const out = q ?? (await quote(row.token, side === 'buy', wei));
      const minOut = (out * BigInt(Math.round((100 - slip) * 100))) / 10_000n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      let hash: Hex;
      if (side === 'buy') {
        setBusy('Buying…');
        const { request } = await client.simulateContract({ account: w.address, address: LAUNCHPAD!, abi: launchpadAbi, functionName: 'buy', args: [row.token, minOut, w.address, deadline], value: wei });
        hash = await w.walletClient.writeContract(request as never);
      } else {
        const allowed = (await client.readContract({ address: row.token, abi: tokenAbi, functionName: 'allowance', args: [w.address, LAUNCHPAD!] })) as bigint;
        if (allowed < wei) {
          setBusy('Approving…');
          const ah = await w.walletClient.writeContract({ address: row.token, abi: tokenAbi, functionName: 'approve', args: [LAUNCHPAD!, wei], account: w.address, chain: client.chain } as never);
          await client.waitForTransactionReceipt({ hash: ah });
        }
        setBusy('Selling…');
        const { request } = await client.simulateContract({ account: w.address, address: LAUNCHPAD!, abi: launchpadAbi, functionName: 'sell', args: [row.token, wei, minOut, w.address, deadline] });
        hash = await w.walletClient.writeContract(request as never);
      }
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('Transaction reverted.');
      setMsg({ ok: true, t: side === 'buy' ? 'Bought.' : 'Sold.', h: hash });
      setAmt('');
      setN(x => x + 1);
      onDone();
    } catch (e) {
      setMsg({ ok: false, t: errText(e) });
    } finally {
      setBusy('');
    }
  };

  const outFmt = q == null ? '—' : side === 'buy' ? `${tokens(q)} ${row.symbol}` : `${eth(q, 5)} ETH`;
  const impact = q && wei > 0n && priceEth > 0
    ? side === 'buy'
      ? (Number(formatEther(wei)) / Number(formatUnits(q, 18)) / priceEth - 1) * 100
      : (1 - Number(formatEther(q)) / Number(formatUnits(wei, 18)) / priceEth) * 100
    : null;

  return (
    <div className="panel">
      <div className="panel-b col" style={{ gap: 12 }}>
        <div className="seg buysell" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
          <button className={`b ${side === 'buy' ? 'on' : ''}`} onClick={() => { setSide('buy'); setAmt(''); }}>Buy</button>
          <button className={`s ${side === 'sell' ? 'on' : ''}`} onClick={() => { setSide('sell'); setAmt(''); }}>Sell</button>
        </div>
        <div className="trade-amt">
          <input className="field" inputMode="decimal" placeholder="0" value={amt} onChange={e => setAmt(e.target.value)} />
          <span className="unit">{side === 'buy' ? 'ETH' : row.symbol.slice(0, 7)}</span>
        </div>
        <div className="presets">
          {presets.map(p => (
            <button key={p} onClick={() => {
              if (side === 'buy') setAmt(p);
              else if (bal) setAmt(formatUnits((bal.tok * BigInt(p)) / 100n, 18));
            }}>{side === 'buy' ? p : `${p}%`}</button>
          ))}
        </div>
        <div className="lkv"><span>You get</span><span className="num">{qErr ? <span className="err">{qErr}</span> : outFmt}</span></div>
        <div className="lkv"><span>Price impact (incl. 1% fee)</span><span className={`num ${impact != null && impact > 10 ? 'amber' : ''}`}>{impact == null ? '—' : `${impact.toFixed(2)}%`}</span></div>
        <div className="lkv">
          <span>Slippage</span>
          <span className="row">
            {[1, 5, 15].map(v => <button key={v} className={`btn sm ${slip === v ? '' : 'ghost'}`} onClick={() => setSlip(v)}>{v}%</button>)}
          </span>
        </div>
        {!w.address ? (
          <button className="btn primary lg block" onClick={() => w.connect()}>Connect wallet</button>
        ) : (
          <button className={`btn lg block ${side === 'buy' ? 'buy' : 'sell'}`} disabled={!!busy || wei <= 0n} onClick={go}>
            {busy || (side === 'buy' ? `Buy ${row.symbol}` : `Sell ${row.symbol}`)}
          </button>
        )}
        <div className="row small dim" style={{ justifyContent: 'space-between' }}>
          <span>{bal ? `${eth(bal.eth, 4)} ETH` : ''}</span>
          <span>{bal ? `${tokens(bal.tok)} ${row.symbol}` : ''}</span>
        </div>
        {msg && <p className={msg.ok ? 'ok' : 'err'}>{msg.t} {msg.h && <TxLink h={msg.h} />}</p>}
        <p className="dim tiny">Plain Uniswap v4 pool: any router, aggregator or bot can trade it too. {m.usd ? '' : ''}</p>
      </div>
    </div>
  );
}

function Attestation({ row, info }: { row: CoinRow; info: LaunchInfo | null }) {
  return (
    <div className="panel">
      <div className="panel-h">Provenance</div>
      <div className="panel-b col" style={{ gap: 10 }}>
        <div className="att-ok">
          <span className="tick">✓</span>
          <div className="small">
            <b>Hash-based signature checked by the launch transaction.</b>
            <div className="dim2">XMSS over keccak256 · one-time key #{row.leaf} of 1,024 · burned on-chain.</div>
          </div>
        </div>
        <Fingerprint digest={info?.digest} height={34} width={3} />
        <div className="lkv"><span>Creator key</span><span className="idc">{shortId(row.identity)}</span></div>
        <div className="lkv"><span>Launch tx</span>{info ? <TxLink h={info.tx} /> : <span className="dim">…</span>}</div>
        <div className="lkv"><span>Dev buy</span><span className="num">{info ? `${eth(info.devBuy, 4)} ETH → ${info.devVault !== zeroHash ? 'a bunker' : 'wallet'}` : '…'}</span></div>
      </div>
    </div>
  );
}

function Fees({ row, usdRate, onDone }: { row: CoinRow; usdRate: number; onDone: () => void }) {
  const w = useWallet();
  const [f, setF] = useState<{ eth: bigint; tokens: bigint } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [n, setN] = useState(0);
  useEffect(() => {
    let dead = false;
    pendingFees(row.token).then(x => !dead && setF(x)).catch(() => {});
    const t = setInterval(() => pendingFees(row.token).then(x => !dead && setF(x)).catch(() => {}), 20_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [row.token, n]);
  const collect = async () => {
    setMsg('');
    setBusy(true);
    try {
      if (!w.address || !w.walletClient) throw new Error('Connect a wallet (anyone can collect).');
      if (w.chainId !== CHAIN_ID) await w.switchChain(CHAIN_ID);
      const { request } = await client.simulateContract({ account: w.address, address: LAUNCHPAD!, abi: launchpadAbi, functionName: 'collect', args: [row.token] });
      const h = await w.walletClient.writeContract(request as never);
      await client.waitForTransactionReceipt({ hash: h });
      setN(x => x + 1);
      onDone();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const feeTo = row.feeVault !== zeroHash ? `bunker ${short(row.feeVault, 4)}` : short(row.feeTo);
  return (
    <div className="panel">
      <div className="panel-h">Trading fees <span className="dim small">1% pool fee · 50% creator · 50% BUNKER</span></div>
      <div className="panel-b col" style={{ gap: 8 }}>
        <div className="lkv"><span>Uncollected</span><span className="num">{f ? `${eth(f.eth, 5)} ETH${f.tokens > 0n ? ` + ${tokens(f.tokens)}` : ''}` : '…'}</span></div>
        <div className="lkv"><span>≈ USD</span><span className="num">{f ? usd(Number(formatEther(f.eth)) * usdRate, 2) : '—'}</span></div>
        <div className="lkv"><span>Creator half goes to</span><span className="mono dim2">{feeTo}</span></div>
        <button className="btn block" disabled={busy || !f || (f.eth === 0n && f.tokens === 0n)} onClick={collect}>{busy ? 'Collecting…' : 'Collect & split (anyone can)'}</button>
        {msg && <p className="err">{msg}</p>}
      </div>
    </div>
  );
}

function CreatorControls({ row, onDone }: { row: CoinRow; onDone: () => void }) {
  const k = useKeys();
  const w = useWallet();
  const [dest, setDest] = useState<'wallet' | 'vault'>('wallet');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  if (!k.identity || k.identity.id.toLowerCase() !== row.identity.toLowerCase()) return null;
  const go = async () => {
    setMsg(null);
    setBusy(true);
    try {
      if (!w.address || !w.walletClient) throw new Error('Connect any wallet to submit (it only pays gas).');
      if (w.chainId !== CHAIN_ID) await w.switchChain(CHAIN_ID);
      const feeTo = dest === 'wallet' ? (isAddress(to) ? getAddress(to) : null) : zeroAddress;
      if (!feeTo) throw new Error('Enter a valid address.');
      const feeVault = dest === 'vault' ? k.vaultId! : zeroHash;
      const leaf = await k.reserveLeaf();
      const d = feeDigest({ chainId: CHAIN_ID, launchpad: LAUNCHPAD!, token: row.token, identity: k.identity!.id, leaf, feeTo, feeVault });
      const onchain = await client.readContract({ address: LAUNCHPAD!, abi: launchpadAbi, functionName: 'feeDigest', args: [row.token, k.identity!.id, leaf, feeTo, feeVault] });
      if (onchain !== d) throw new Error('Message mismatch with the contract. Nothing was signed.');
      const sig = await k.signWith(leaf, d);
      const s = { seed: k.identity!.seedHex, root: k.identity!.rootHex, leaf, wots: sig.wots, auth: sig.auth };
      const { request } = await client.simulateContract({ account: w.address, address: LAUNCHPAD!, abi: launchpadAbi, functionName: 'setFeeTo', args: [row.token, feeTo, feeVault, s as never] });
      const h = await w.walletClient.writeContract(request as never);
      await client.waitForTransactionReceipt({ hash: h });
      setMsg({ ok: true, t: 'Fee recipient changed.' });
      k.refreshLeaves().catch(() => {});
      onDone();
    } catch (e) {
      setMsg({ ok: false, t: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel">
      <div className="panel-h">You created this coin</div>
      <div className="panel-b col" style={{ gap: 10 }}>
        <p className="dim2 small">Move your fee share. Signed with a fresh one-time key from your bunker phrase, so it works even if every ECDSA key is broken.</p>
        <div className="seg" style={{ alignSelf: 'start' }}>
          <button className={dest === 'wallet' ? 'on' : ''} onClick={() => setDest('wallet')}>Wallet</button>
          <button className={dest === 'vault' ? 'on' : ''} onClick={() => setDest('vault')}>My bunker</button>
        </div>
        {dest === 'wallet' && <input className="field mono" placeholder="0x… new fee wallet" value={to} onChange={e => setTo(e.target.value.trim())} />}
        <button className="btn" disabled={busy} onClick={go}>{busy ? 'Signing…' : 'Sign & change'}</button>
        {msg && <p className={msg.ok ? 'ok' : 'err'}>{msg.t}</p>}
      </div>
    </div>
  );
}
