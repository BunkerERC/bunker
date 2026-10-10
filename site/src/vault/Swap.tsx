import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits, getAddress, isAddress, parseUnits, zeroAddress, type Hex } from 'viem';
import * as wots from '../lib/wots.js';
import * as bs from '../lib/bunkerswap.js';
import { vaultAbi, erc20Abi } from './abi';
import { client } from '../chains';
import { usePrices } from '../prices';
import { isSwap, loadPending, savePending, clearPending, type Pending, type PendingSwap } from './pending';
import { relayFee, relayInfo, type RelayInfo } from './relay';
import { keyUsed, readKey, sendWithRelayer, sendWithWallet, swapOutcome, type Wallet } from './actions';

export interface Asset { token: Hex; symbol: string; decimals: number }
export interface SwapConfig { swap: Hex; boxCode: Hex; feeBps: bigint }

const eth = () => client(1);
const ETH = zeroAddress as Hex;
const DEADLINE_S = 600;
const fmt = (v: bigint, decimals: number, dp = 6) => {
  const s = formatUnits(v, decimals);
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, i.length > 3 ? Math.min(dp, 2) : dp).replace(/0+$/, '');
  return (i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '')) || '0';
};
const short = (h: string, n = 4) => `${h.slice(0, n + 2)}…${h.slice(-n)}`;
const errText = (e: unknown) => {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  if (/rejected|denied/i.test(m)) return 'You rejected it in the wallet.';
  if (/NotSubmitter/.test(m)) return 'This swap was signed for another submitter. Once its 10 minutes are up, any wallet can take the funds back.';
  if (/TooLittle/.test(m)) return 'The price moved past your limit. Try again, or take the funds back once the 10 minutes are up.';
  return m.split('\n')[0];
};

/** BunkerSwap's fixed settings, read once. null = not configured, or built for another vault. */
export function useSwapConfig(swap: Hex | null, vault: Hex): SwapConfig | null {
  const [cfg, setCfg] = useState<SwapConfig | null>(null);
  useEffect(() => {
    setCfg(null);
    if (!swap) return;
    let dead = false;
    const read = (functionName: string) => eth().readContract({ address: swap, abi: bs.swapAbi, functionName });
    Promise.all([read('VAULT'), read('BOX'), read('FEE_BPS')]).then(([v, box, fee]) => {
      if (!dead && String(v).toLowerCase() === vault.toLowerCase()) setCfg({ swap, boxCode: box as Hex, feeBps: fee as bigint });
    }).catch(() => {});
    return () => { dead = true; };
  }, [swap, vault]);
  return cfg;
}

export function SendMode({ mode, setMode, relay, why }: { mode: 'relayer' | 'wallet'; setMode: (m: 'relayer' | 'wallet') => void; relay: RelayInfo | null; why?: string }) {
  if (!relay) return null;
  return (
    <div className="send-mode">
      <div className="seg">
        <button type="button" className={mode === 'relayer' ? 'on' : ''} disabled={!!why} onClick={() => setMode('relayer')}>Gasless</button>
        <button type="button" className={mode === 'wallet' ? 'on' : ''} onClick={() => setMode('wallet')}>My wallet pays gas</button>
      </div>
      <span className="dim small">{why ?? (mode === 'relayer' ? 'No wallet needed. A relayer sends it and is paid from the bunker.' : 'Any wallet works. It only pays gas.')}</span>
    </div>
  );
}

export default function Swap({ vault, cfg, id, master, nonce, assets, held, bal, wallet, relay, launchpad, bunkerToken, startBuy, pending, setPending, onDone }: {
  vault: Hex; cfg: SwapConfig; id: Hex; master: Uint8Array; nonce: number; assets: Asset[]; held: Asset[]; bal: Record<string, bigint>;
  wallet: Wallet; relay: RelayInfo | null; launchpad: Hex | null; bunkerToken: Hex | null; startBuy?: Hex | null;
  pending: Pending | null; setPending: (p: Pending | null) => void; onDone: () => void;
}) {
  const prices = usePrices();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [token, setToken] = useState<Hex | ''>('');
  const [custom, setCustom] = useState('');
  const [extra, setExtra] = useState<Asset[]>([]);
  const [amount, setAmount] = useState('');
  const [slip, setSlip] = useState(200);
  const [modePick, setModePick] = useState<'relayer' | 'wallet' | null>(null);
  const [quote, setQuote] = useState<{ q: bs.Quote | null; forKey: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const relayOk = !!relay && !relay.paused && relay.vault.toLowerCase() === vault.toLowerCase() && relay.swap.toLowerCase() === cfg.swap.toLowerCase();
  const mode: 'relayer' | 'wallet' = !relayOk ? 'wallet' : modePick ?? (wallet.address ? 'wallet' : 'relayer');

  // what can be bought: $BUNKER, launchpad coins, the big tokens, anything pasted
  const [coins, setCoins] = useState<Asset[]>([]);
  useEffect(() => {
    if (!launchpad) return;
    let dead = false;
    (async () => {
      try {
        const c = eth();
        const abi = [
          { type: 'function', name: 'coinsCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
          { type: 'function', name: 'coinsSlice', stateMutability: 'view', inputs: [{ name: 'from', type: 'uint256' }, { name: 'count', type: 'uint256' }], outputs: [{ type: 'address[]' }] },
        ] as const;
        const n = await c.readContract({ address: launchpad, abi, functionName: 'coinsCount' });
        if (n === 0n) return;
        const from = n > 40n ? n - 40n : 0n;
        const list = await c.readContract({ address: launchpad, abi, functionName: 'coinsSlice', args: [from, n - from] });
        const syms = await c.multicall({ contracts: list.map(t => ({ address: t, abi: erc20Abi, functionName: 'symbol' as const })), allowFailure: true });
        if (!dead) setCoins(list.map((t, i) => ({ token: getAddress(t), symbol: syms[i].status === 'success' ? String(syms[i].result) : short(t), decimals: 18 })).reverse());
      } catch { /* the list is a convenience; pasting an address always works */ }
    })();
    return () => { dead = true; };
  }, [launchpad]);

  const buyable = useMemo(() => {
    const out: Asset[] = [];
    const add = (a: Asset) => { if (a.token !== ETH && !out.some(x => x.token.toLowerCase() === a.token.toLowerCase())) out.push(a); };
    if (bunkerToken) add({ token: bunkerToken, symbol: 'BUNKER', decimals: 18 });
    coins.forEach(add);
    assets.filter(a => !['WETH', 'stETH'].includes(a.symbol)).forEach(add);
    extra.forEach(add);
    return out;
  }, [assets, coins, extra, bunkerToken]);
  const sellable = useMemo(() => held.filter(a => a.token !== ETH), [held]);
  const list = side === 'buy' ? buyable : sellable;
  const asset = list.find(a => a.token === token) ?? null;

  // a coin page can send people here: #vault?buy=0x…
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !startBuy) return;
    started.current = true;
    setSide('buy');
    void addToken(startBuy);
  }, [startBuy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (token && list.some(a => a.token === token)) return;
    setToken(list[0]?.token ?? '');
  }, [list, token]);

  async function addToken(raw: string) {
    setMsg('');
    if (!isAddress(raw)) return setMsg('That is not a token address.');
    const t = getAddress(raw);
    try {
      const [symbol, decimals] = await Promise.all([
        eth().readContract({ address: t, abi: erc20Abi, functionName: 'symbol' }),
        eth().readContract({ address: t, abi: erc20Abi, functionName: 'decimals' }),
      ]);
      setExtra(x => (x.some(a => a.token === t) ? x : [...x, { token: t, symbol, decimals }]));
      setToken(t);
      setCustom('');
    } catch {
      setMsg('Could not read that token.');
    }
  }

  // ---- amounts
  const inAsset: Asset = side === 'buy' ? { token: ETH, symbol: 'ETH', decimals: 18 } : asset ?? { token: ETH, symbol: '', decimals: 18 };
  const have = bal[inAsset.token] ?? 0n;
  let amountIn = 0n;
  try { amountIn = parseUnits(amount || '0', inAsset.decimals); } catch { amountIn = 0n; }
  const tip = mode === 'relayer' && relay ? relayFee(relay, side === 'buy' ? relay.gas.buy : relay.gas.sell) : 0n;
  const buy = side === 'buy' ? bs.buySplit(amountIn, tip, cfg.feeBps) : null;
  const quoteIn = side === 'buy' ? (buy && buy.spend > 0n ? buy.spend : 0n) : amountIn;
  const quoteKey = `${side}:${token}:${quoteIn}`;

  useEffect(() => {
    if (!asset || quoteIn <= 0n) return setQuote(null);
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const all = await bs.quoteAll(eth(), { tokenIn: side === 'buy' ? ETH : asset.token, tokenOut: side === 'buy' ? asset.token : ETH, amountIn: quoteIn, launchpad });
        if (!dead) setQuote({ q: all[0] ?? null, forKey: quoteKey });
      } catch {
        if (!dead) setQuote({ q: null, forKey: quoteKey });
      }
    }, 350);
    return () => { dead = true; clearTimeout(t); };
  }, [quoteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = quote && quote.forKey === quoteKey ? quote.q : null;
  const quoting = !!asset && quoteIn > 0n && (!quote || quote.forKey !== quoteKey);
  const sell = side === 'sell' && q ? bs.sellSplit(q.amountOut, tip, cfg.feeBps) : null;
  const sellMin = side === 'sell' && q ? bs.sellSplit(bs.withSlippage(q.amountOut, slip), tip, cfg.feeBps).net : 0n;
  const outEst = side === 'buy' ? q?.amountOut ?? 0n : sell?.net ?? 0n;
  const outMin = side === 'buy' ? (q ? bs.withSlippage(q.amountOut, slip) : 0n) : sellMin;
  const fee = side === 'buy' ? buy?.fee ?? 0n : sell?.fee ?? 0n;
  const outAsset: Asset | null = side === 'buy' ? asset : { token: ETH, symbol: 'ETH', decimals: 18 };
  const usd = (wei: bigint) => (prices.eth ? ` ($${(Number(formatUnits(wei, 18)) * prices.eth).toFixed(2)})` : '');

  const problem = !asset ? (side === 'sell' ? 'Nothing to sell yet: this bunker holds no tokens.' : 'Pick a token.')
    : amountIn <= 0n ? ''
    : amountIn > have ? `The bunker holds ${fmt(have, inAsset.decimals)} ${inAsset.symbol}.`
    : side === 'buy' && (!buy || buy.spend <= 0n) ? 'That amount does not cover the fee.'
    : quoting ? ''
    : !q ? `No Uniswap pool found for ${asset.symbol} against ETH.`
    : outMin <= 0n ? 'That amount does not cover the fee.'
    : '';

  // ---- pending swap of this key
  const mine = pending && isSwap(pending) ? pending : null;
  useEffect(() => {
    if (!mine) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [mine]);
  const expired = mine ? now > Number(mine.order.deadline) : false;

  const finish = async (p: PendingSwap, hash: Hex | undefined) => {
    clearPending(vault, id, p.nonce);
    setPending(null);
    const res = hash ? await swapOutcome(hash) : null;
    setMsg(res && !res.swapped
      ? `The order had expired, so nothing was swapped: the funds are back in the bunker. Key #${p.nonce} is burned.`
      : `Done. ${p.note}. Key #${p.nonce} burned, bunker rotated to key #${p.nonce + 1}.`);
    setAmount('');
    onDone();
  };

  const submit = async (p: PendingSwap, via: 'relayer' | 'wallet') => {
    const onHash = (hash: Hex) => { const withHash = { ...p, hash }; savePending(vault, id, withHash); setPending(withHash); };
    setBusy(via === 'relayer' ? 'Relayer is sending it…' : `Sending with key #${p.nonce}…`);
    const hash = via === 'relayer' ? await sendWithRelayer(vault, id, p, onHash) : await sendWithWallet(wallet, vault, cfg.swap, id, p, onHash);
    await finish(p, hash ?? p.hash);
  };

  const go = async () => {
    setMsg('');
    try {
      if (!asset || !q) throw new Error('No quote yet.');
      if (problem) throw new Error(problem);
      if (mode === 'wallet' && !wallet.address) await wallet.connect();
      setBusy('Checking the vault…');
      const c = eth();
      const k = await readKey(vault, id, master);
      if (loadPending(vault, id, k.nonce)) throw new Error(`Key #${k.nonce} has already signed something that has not landed. Finish that first: a key must never sign two messages.`);

      // fresh terms: relayer price, quote, block time
      let submitter: Hex;
      let tipNow = 0n;
      if (mode === 'relayer') {
        const info = await relayInfo();
        if (info.paused) throw new Error(info.paused);
        if (info.swap.toLowerCase() !== cfg.swap.toLowerCase()) throw new Error('The relayer is set up for another contract. Use a wallet.');
        tipNow = relayFee(info, side === 'buy' ? info.gas.buy : info.gas.sell);
        submitter = getAddress(info.relayer);
      } else {
        if (!wallet.address) throw new Error('Connect a wallet first.');
        submitter = wallet.address;
      }
      const tokenIn = side === 'buy' ? ETH : asset.token;
      const tokenOut = side === 'buy' ? asset.token : ETH;
      const split = side === 'buy' ? bs.buySplit(amountIn, tipNow, cfg.feeBps) : null;
      const swapIn = split ? split.spend : amountIn;
      if (swapIn <= 0n) throw new Error('That amount does not cover the fee.');
      const best = (await bs.quoteAll(c, { tokenIn, tokenOut, amountIn: swapIn, launchpad }))[0];
      if (!best) throw new Error(`No Uniswap pool found for ${asset.symbol} against ETH.`);
      const minOut = side === 'buy' ? bs.withSlippage(best.amountOut, slip) : bs.sellSplit(bs.withSlippage(best.amountOut, slip), tipNow, cfg.feeBps).net;
      if (minOut <= 0n) throw new Error('That amount does not cover the fee.');
      const route = bs.routeOf(best);
      const blockTime = Number((await c.getBlock()).timestamp);
      const order = {
        id, nonce: String(k.nonce), tokenIn, tokenOut, amountIn: amountIn.toString(), minOut: minOut.toString(), tip: tipNow.toString(),
        submitter, deadline: String(blockTime + DEADLINE_S), route: bs.routeHash(route),
      };

      // the order is tied to the signature through the box address: check ours against the contract's
      const box = bs.boxOf(cfg.swap, cfg.boxCode, order);
      const onchainBox = await c.readContract({ address: cfg.swap, abi: bs.swapAbi, functionName: 'boxOf', args: [bs.orderArgs(order)] });
      if (onchainBox !== box) throw new Error('Order mismatch with the contract. Nothing was signed.');
      const transfers = [{ token: tokenIn, to: box, amount: amountIn }];
      const digest = wots.digestOf({ chainId: 1, vault, id, nonce: k.nonce, transfers, relayer: cfg.swap, fee: 0n, nextKey: k.nextKey });
      const onchain = await c.readContract({ address: vault, abi: vaultAbi, functionName: 'digest', args: [id, transfers, cfg.swap, 0n, k.nextKey] });
      if (onchain !== digest) throw new Error('Message mismatch with the contract. Nothing was signed.');

      const sig = wots.sign(master, k.nonce, digest);
      if (wots.recover(digest, sig) !== k.key) throw new Error('Signature self-check failed. Nothing was sent.');
      const est = side === 'buy' ? best.amountOut : bs.sellSplit(best.amountOut, tipNow, cfg.feeBps).net;
      const note = side === 'buy'
        ? `${fmt(amountIn, 18)} ETH for about ${fmt(est, asset.decimals)} ${asset.symbol}`
        : `${fmt(amountIn, asset.decimals)} ${asset.symbol} for about ${fmt(est, 18)} ETH`;
      const p: PendingSwap = { kind: 'swap', nonce: k.nonce, digest, nextKey: k.nextKey, sig, order, route, note };
      savePending(vault, id, p);
      setPending(p);
      await submit(p, mode);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy('');
    }
  };

  const again = async (via: 'relayer' | 'wallet') => {
    if (!mine) return;
    setMsg('');
    try {
      if (await keyUsed(vault, id, mine.nonce)) return await finish(mine, mine.hash);
      await submit(mine, via);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy('');
    }
  };

  const max = () => setAmount(formatUnits(have, inAsset.decimals));
  const locked = !!pending;

  return (
    <div className="vault-card swap-card">
      <div className="vault-card-h">Swap <span className="dim">inside the bunker, signed with key #{nonce}</span></div>
      {mine && (
        <div className="vault-pending">
          <b>Signed swap, not confirmed yet:</b> {mine.note}
          {mine.hash && <> · <a href={`https://etherscan.io/tx/${mine.hash}`} target="_blank" rel="noreferrer">tx</a></>}
          <span className="dim small">{expired ? 'Its 10 minutes are up: sending it now only takes the funds back and frees the key.' : `Good for ${Math.max(0, Number(mine.order.deadline) - now)}s more. After that the same signature takes the funds back.`}</span>
          <div className="row-gap">
            {relayOk && <button className="btn sm" disabled={!!busy} onClick={() => again('relayer')}>{expired ? 'Take it back (gasless)' : 'Try again (gasless)'}</button>}
            <button className="btn sm" disabled={!!busy} onClick={() => again('wallet')}>{expired ? 'Take it back with my wallet' : 'Try again with my wallet'}</button>
          </div>
        </div>
      )}
      {pending && !mine && <p className="dim small">Key #{pending.nonce} has already signed a send that has not landed yet. Finish that one first.</p>}

      <div className="seg buysell">
        <button type="button" className={side === 'buy' ? 'on b' : ''} onClick={() => { setSide('buy'); setAmount(''); }}>Buy</button>
        <button type="button" className={side === 'sell' ? 'on s' : ''} onClick={() => { setSide('sell'); setAmount(''); }}>Sell</button>
      </div>

      <div className="form-row">
        <select className="field" aria-label="token" value={token} onChange={e => { setToken(e.target.value as Hex); setAmount(''); }}>
          {list.length === 0 && <option value="">no tokens</option>}
          {list.map(a => <option key={a.token} value={a.token}>{a.symbol}</option>)}
        </select>
        <input className="field mono" inputMode="decimal" aria-label="amount" placeholder={side === 'buy' ? 'ETH to spend' : `${asset?.symbol ?? 'tokens'} to sell`} value={amount} onChange={e => setAmount(e.target.value.trim())} />
        <button className="btn sm" type="button" onClick={max} disabled={have === 0n}>max</button>
      </div>
      <div className="dim small">
        in the bunker: {fmt(have, inAsset.decimals)} {inAsset.symbol}
        {asset && side === 'buy' && <> · {fmt(bal[asset.token] ?? 0n, asset.decimals)} {asset.symbol}</>}
      </div>
      {side === 'buy' && (
        <div className="form-row">
          <input className="field mono" aria-label="token address" placeholder="or paste any token address (0x…)" value={custom} onChange={e => setCustom(e.target.value.trim())} />
          <button className="btn sm" type="button" disabled={!custom} onClick={() => addToken(custom)}>add</button>
        </div>
      )}

      {asset && amountIn > 0n && (
        <dl className="swap-q">
          <div><dt>You get</dt><dd className="mono">{quoting ? <i className="spin" /> : q && outAsset ? <>≈ {fmt(outEst, outAsset.decimals)} {outAsset.symbol}{side === 'sell' && usd(outEst)}</> : '—'}</dd></div>
          <div><dt>At least</dt><dd className="mono">{q && outAsset && outMin > 0n ? `${fmt(outMin, outAsset.decimals)} ${outAsset.symbol}` : '—'}
            <select className="field field-sm slip" aria-label="slippage" value={slip} onChange={e => setSlip(Number(e.target.value))}>
              {[50, 100, 200, 500, 1000].map(b => <option key={b} value={b}>{b / 100}% slippage</option>)}
            </select></dd></div>
          <div><dt>Swap fee {Number(cfg.feeBps) / 100}%</dt><dd className="mono">{fee > 0n ? `${fmt(fee, 18, 8)} ETH${usd(fee)}` : '—'}</dd></div>
          {mode === 'relayer' && <div><dt>Relayer</dt><dd className="mono">{fmt(tip, 18, 8)} ETH{usd(tip)}</dd></div>}
          <div><dt>Pool</dt><dd>{q ? q.label : '—'}</dd></div>
        </dl>
      )}
      {problem && <p className="err">{problem}</p>}

      <SendMode mode={mode} setMode={setModePick} relay={relayOk ? relay : null} />
      <button className="btn primary" disabled={!!busy || locked || !asset || amountIn <= 0n || !!problem || quoting || !q} onClick={go}>
        {busy || (mode === 'wallet' && !wallet.address ? 'Connect a wallet to submit' : `Sign with key #${nonce} & swap`)}
      </button>
      {msg && <p className="small">{msg}</p>}
      <p className="dim small">
        The funds go from the vault to Uniswap and straight back into this bunker in one transaction. They never sit in
        a wallet. The key signs the exact pool, the least you accept and a 10 minute limit. If the price runs away, the
        same signature takes the funds back after those 10 minutes.
      </p>
    </div>
  );
}
