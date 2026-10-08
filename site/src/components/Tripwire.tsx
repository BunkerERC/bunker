import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatEther, formatUnits, getAddress, isAddress, maxUint256, parseEther, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { CHAINS, client } from '../chains';
import { TOKEN_ADDRESS, TRIPWIRE_ADDRESS, VAULT_ADDRESS } from '../config';
import { fmtUsd } from '../lib/format';
import { usePrices } from '../prices';
import { erc20Abi, tripwireAbi, vaultAbi } from '../vault/abi';
import { useWallet } from '../wallet';
import { CopyBtn } from './ui';

// dev overrides for fork tests: ?tripwire=0x..&vault=0x..
const devParam = (name: string): Hex | null => {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(location.search).get(name);
  return v && isAddress(v) ? getAddress(v) : null;
};
const TW: Hex | null = devParam('tripwire') ?? TRIPWIRE_ADDRESS;
const VAULT: Hex | null = devParam('vault') ?? VAULT_ADDRESS;
const TOKEN: Hex | null = devParam('token') ?? TOKEN_ADDRESS;
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const eth = () => client(1);
const short = (h: string, n = 4) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);
const errText = (e: unknown) => {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return /rejected|denied/i.test(m) ? 'You rejected it in the wallet.' : m.split('\n')[0];
};
const fmt = (v: bigint, d: number) => {
  const [i, f = ''] = formatUnits(v, d).split('.');
  const frac = f.slice(0, 4).replace(/0+$/, '');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '');
};
const lastBunker = (): string => { try { return localStorage.getItem('bunker:last-id') ?? ''; } catch { return ''; } };

interface Tok { address: Hex; symbol: string; decimals: number }
const KNOWN: Tok[] = [
  ...(TOKEN ? [{ address: TOKEN, symbol: 'BUNKER', decimals: 18 }] : []),
  ...(CHAINS.find(c => c.id === 1)?.tokens ?? [])
    .filter(t => t.symbol !== 'stETH') // rebasing: the vault takes wstETH, not stETH
    .map(t => ({ address: t.address as Hex, symbol: t.symbol, decimals: t.decimals })),
];

interface TwState {
  canary: Hex;
  x: bigint;
  y: bigint;
  counter: bigint;
  seed: string;
  bounty: bigint;
  members: bigint;
  trippedAt: bigint;
  tripped: boolean;
  claimedBy: Hex;
}

function useTripwire(): [TwState | null, () => void] {
  const [s, setS] = useState<TwState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!TW) return;
    let dead = false;
    const load = async () => {
      try {
        const c = eth();
        const r = (functionName: string) => c.readContract({ address: TW, abi: tripwireAbi, functionName: functionName as never });
        const [canary, x, y, counter, seed, bounty, members, trippedAt, tripped, claimedBy] = await Promise.all([
          r('canary'), r('canaryX'), r('canaryY'), r('canaryCounter'), r('CANARY_SEED'),
          c.getBalance({ address: TW }), r('memberCount'), r('trippedAt'), r('isTripped'), r('claimedBy'),
        ]);
        if (!dead) setS({ canary, x, y, counter, seed, bounty, members, trippedAt, tripped, claimedBy } as TwState);
      } catch { /* keep the last good read */ }
    };
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 15_000);
    return () => { dead = true; clearInterval(t); };
  }, [tick]);
  return [s, useCallback(() => setTick(t => t + 1), [])];
}

type Wallet = ReturnType<typeof useWallet>;
async function onEthereum(w: Wallet) {
  if (!w.address) await w.connect();
  if (w.chainId !== 1) await w.switchChain(1);
}
async function write(w: Wallet, req: { address: Hex; abi: unknown; functionName: string; args?: unknown[]; value?: bigint }) {
  if (!w.walletClient || !w.address) throw new Error('Connect a wallet first.');
  const hash = await w.walletClient.writeContract({ ...(req as object), account: w.address, chain: mainnet } as never);
  const r = await eth().waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  return hash;
}

// ------------------------------------------------------------------ page
export function Tripwire() {
  const [s, reload] = useTripwire();
  return (
    <section className="sec tw" id="tripwire">
      <div className="sec-head">
        <div className="hx-kicker">Add-on · no token · no fee</div>
        <h1 className="display sec-h tw-h">Tripwire</h1>
        <p className="sec-p">
          A bounty on ECDSA, wired to an escape hatch. The moment the canary key signs anything, every armed wallet
          evacuates into its bunker.
        </p>
      </div>
      {!TW ? (
        <div className="vault-card vault-off">
          <b>Tripwire goes live shortly.</b> The contract is written and tested on a mainnet fork against the real vault;
          the address appears here at deploy.
        </div>
      ) : (
        <div className="tw-grid">
          <Status s={s} />
          {s?.tripped && <Tripped s={s} onDone={reload} />}
          <Arm tripped={!!s?.tripped} onDone={reload} />
        </div>
      )}
      <How />
    </section>
  );
}

// ------------------------------------------------------------------ status + bounty
function Status({ s }: { s: TwState | null }) {
  const prices = usePrices();
  const pubKey = s ? `04${s.x.toString(16).padStart(64, '0')}${s.y.toString(16).padStart(64, '0')}` : '';
  return (
    <div className="vault-card tw-status">
      <div className="tw-stats">
        <div className="stat">
          <span className="stat-l">state</span>
          {s ? (
            <span className={`tw-state ${s.tripped ? 'tripped' : 'armed'}`}><i />{s.tripped ? 'TRIPPED' : 'ARMED'}</span>
          ) : <span className="stat-n">—</span>}
        </div>
        <div className="stat">
          <span className="stat-l">bounty</span>
          <span className="stat-n acc">{s ? `${fmt(s.bounty, 18)} ETH` : '—'}</span>
          <span className="stat-l mono">{s && prices.eth ? fmtUsd(Number(formatEther(s.bounty)) * prices.eth) : ''}</span>
        </div>
        <div className="stat">
          <span className="stat-l">armed wallets</span>
          <span className="stat-n">{s ? s.members.toString() : '—'}</span>
        </div>
        <div className="stat">
          <span className="stat-l">canary</span>
          <span className="stat-n tw-canary">
            {s ? <a className="mono" href={`https://etherscan.io/address/${s.canary}`} target="_blank" rel="noreferrer">{short(s.canary)} ↗</a> : '—'}
          </span>
        </div>
      </div>
      {s && (
        <div className="tw-key">
          <span className="dim">Public key, nothing up the sleeve: x = keccak256("{s.seed}" ‖ {s.counter.toString()}), the first value on the curve, even y. Nobody holds its private key.</span>
          <span className="tw-key-v mono">0x{short(pubKey, 10)} <CopyBtn text={'0x' + pubKey} /></span>
        </div>
      )}
      {s && !s.tripped && <Fund />}
    </div>
  );
}

function Fund() {
  const w = useWallet();
  const [amt, setAmt] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  let value = 0n;
  try { value = amt ? parseEther(amt) : 0n; } catch { value = -1n; }
  const go = async () => {
    setBusy(true); setMsg('');
    try {
      await onEthereum(w);
      const hash = await write(w, { address: TW!, abi: tripwireAbi, functionName: 'fund', value });
      setMsg(`Added ${amt} ETH to the bounty. Tx ${short(hash, 6)}`); setAmt('');
    } catch (e) { setMsg(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="tw-fund">
      <div className="form-row">
        <input className="field" inputMode="decimal" placeholder="ETH" value={amt} onChange={e => setAmt(e.target.value.trim())} aria-label="ETH to add to the bounty" />
        {w.address
          ? <button className="btn" disabled={busy || value <= 0n} onClick={go}>{busy ? 'Sending…' : 'Add to bounty'}</button>
          : <button className="btn" onClick={() => w.connect()}>Connect wallet</button>}
      </div>
      <p className="dim small">One way. Bounty ETH only ever leaves through a signature from the canary key.</p>
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ tripped: anyone can evacuate everyone
function Tripped({ s, onDone }: { s: TwState; onDone: () => void }) {
  const w = useWallet();
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const when = s.trippedAt ? new Date(Number(s.trippedAt) * 1000).toUTCString() : 'just now (not recorded yet)';
  const everyone = async () => {
    setMsg('');
    try {
      await onEthereum(w);
      const n = Number(s.members);
      for (let start = 0; start < n; start += 15) {
        setBusy(`Escaping wallets ${start + 1}-${Math.min(n, start + 15)} of ${n}…`);
        const batch = await eth().readContract({ address: TW!, abi: tripwireAbi, functionName: 'members', args: [BigInt(start), 15n] });
        await write(w, { address: TW!, abi: tripwireAbi, functionName: 'escapeMany', args: [batch] });
      }
      setMsg(`Done: ${n} armed wallets swept into their bunkers.`);
      onDone();
    } catch (e) { setMsg(errText(e)); } finally { setBusy(''); }
  };
  return (
    <div className="vault-card tw-alarm" role="alert">
      <div className="tw-alarm-h">The canary signed. ECDSA is not safe.</div>
      <p>Tripped {when}{s.claimedBy !== '0x0000000000000000000000000000000000000000' ? `, bounty claimed by ${short(s.claimedBy, 6)}` : ''}. Every armed wallet can now be swept into its bunker by anyone. Do it now.</p>
      <div className="row-gap">
        {w.address
          ? <button className="btn primary" disabled={!!busy} onClick={everyone}>{busy || 'Escape everyone'}</button>
          : <button className="btn primary" onClick={() => w.connect()}>Connect any wallet to escape everyone</button>}
      </div>
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ arm a wallet
interface Row extends Tok { balance: bigint; allowance: bigint; on: boolean }

function Arm({ tripped, onDone }: { tripped: boolean; onDone: () => void }) {
  const w = useWallet();
  const [bunker, setBunker] = useState(lastBunker);
  const [bunkerOpen, setBunkerOpen] = useState<boolean | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [reg, setReg] = useState<{ bunker: Hex; tokens: Hex[] } | null>(null);
  const [nonce, setNonce] = useState<number | null>(null);
  const [anyway, setAnyway] = useState(false);
  const [custom, setCustom] = useState('');
  const [extra, setExtra] = useState<Tok[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);
  const tokens = useMemo(() => [...KNOWN, ...extra], [extra]);
  const validId = /^0x[0-9a-fA-F]{64}$/.test(bunker.trim());

  // is the bunker open in the vault?
  useEffect(() => {
    setBunkerOpen(null);
    if (!validId || !VAULT) return;
    let dead = false;
    eth().readContract({ address: VAULT, abi: vaultAbi, functionName: 'accounts', args: [bunker.trim() as Hex] })
      .then(([key]) => { if (!dead) setBunkerOpen(BigInt(key) !== 0n); })
      .catch(() => {});
    return () => { dead = true; };
  }, [bunker, validId]);

  // wallet balances, approvals, current registration
  useEffect(() => {
    if (!w.address || !TW) { setRows([]); setReg(null); setNonce(null); return; }
    let dead = false;
    const a = w.address;
    (async () => {
      const c = eth();
      const reads = await c.multicall({
        contracts: tokens.flatMap(t => [
          { address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [a] },
          { address: t.address, abi: erc20Abi, functionName: 'allowance', args: [a, TW] },
        ]),
      });
      const [b, list, n] = await Promise.all([
        c.readContract({ address: TW, abi: tripwireAbi, functionName: 'bunkerOf', args: [a] }),
        c.readContract({ address: TW, abi: tripwireAbi, functionName: 'tokensOf', args: [a] }),
        c.getTransactionCount({ address: a }),
      ]);
      if (dead) return;
      const armed = new Set(list.map(x => x.toLowerCase()));
      setRows(prev => tokens.map((t, i) => {
        const balance = (reads[2 * i].result as bigint | undefined) ?? 0n;
        const allowance = (reads[2 * i + 1].result as bigint | undefined) ?? 0n;
        const was = prev.find(p => p.address === t.address);
        return { ...t, balance, allowance, on: was ? was.on : armed.has(t.address.toLowerCase()) || balance > 0n };
      }));
      setReg(BigInt(b) !== 0n ? { bunker: b, tokens: [...list] } : null);
      setNonce(n);
      if (BigInt(b) !== 0n && !bunker) setBunker(b);
    })().catch(() => {});
    return () => { dead = true; };
  }, [w.address, tokens, tick]);

  const addCustom = async () => {
    const v = custom.trim();
    if (!isAddress(v)) { setMsg('Not a token address.'); return; }
    try {
      const [symbol, decimals] = await Promise.all([
        eth().readContract({ address: getAddress(v), abi: erc20Abi, functionName: 'symbol' }),
        eth().readContract({ address: getAddress(v), abi: erc20Abi, functionName: 'decimals' }),
      ]);
      if (!tokens.some(t => t.address.toLowerCase() === v.toLowerCase())) setExtra(x => [...x, { address: getAddress(v), symbol, decimals }]);
      setCustom(''); setMsg('');
    } catch { setMsg('That address does not answer like an ERC-20 token.'); }
  };

  const chosen = rows.filter(r => r.on);
  const neverSigned = nonce === 0;
  const canArm = !!w.address && validId && bunkerOpen === true && chosen.length > 0 && chosen.length <= 32 && (!neverSigned || anyway) && !busy;

  const arm = async () => {
    setMsg('');
    try {
      await onEthereum(w);
      for (const r of chosen) {
        if (r.allowance >= maxUint256 / 2n) continue;
        if (r.allowance > 0n && r.address.toLowerCase() === USDT.toLowerCase()) {
          setBusy(`Resetting ${r.symbol} approval…`);
          await write(w, { address: r.address, abi: erc20Abi, functionName: 'approve', args: [TW!, 0n] });
        }
        setBusy(`Approve ${r.symbol} (${chosen.indexOf(r) + 1}/${chosen.length})…`);
        await write(w, { address: r.address, abi: erc20Abi, functionName: 'approve', args: [TW!, maxUint256] });
      }
      setBusy('Registering your bunker…');
      await write(w, { address: TW!, abi: tripwireAbi, functionName: 'register', args: [bunker.trim() as Hex, chosen.map(r => r.address)] });
      setMsg(`Armed. If the canary ever signs, ${chosen.map(r => r.symbol).join(', ')} escape into bunker ${short(bunker.trim(), 6)}.`);
      setTick(t => t + 1); onDone();
    } catch (e) { setMsg(errText(e)); } finally { setBusy(''); }
  };

  const disarm = async () => {
    setMsg('');
    try {
      await onEthereum(w);
      setBusy('Leaving the tripwire…');
      await write(w, { address: TW!, abi: tripwireAbi, functionName: 'leave' });
      for (const r of rows.filter(x => x.allowance > 0n)) {
        setBusy(`Revoking ${r.symbol} approval…`);
        await write(w, { address: r.address, abi: erc20Abi, functionName: 'approve', args: [TW!, 0n] });
      }
      setMsg('Disarmed and approvals revoked.');
      setTick(t => t + 1); onDone();
    } catch (e) { setMsg(errText(e)); } finally { setBusy(''); }
  };

  const escapeMine = async () => {
    setMsg('');
    try {
      await onEthereum(w);
      setBusy('Escaping…');
      const hash = await write(w, { address: TW!, abi: tripwireAbi, functionName: 'escape', args: [w.address!] });
      setMsg(`Swept into your bunker. Tx ${short(hash, 6)}`);
      setTick(t => t + 1); onDone();
    } catch (e) { setMsg(errText(e)); } finally { setBusy(''); }
  };

  return (
    <div className="vault-card tw-arm">
      <div className="vault-card-h">Arm a wallet <span className="dim">one approval per token, then one registration</span></div>
      {!w.address ? (
        <>
          <p className="dim2">Connect the wallet you want covered. Its approved tokens will move into your bunker if, and only if, the canary signs.</p>
          <button className="btn primary" onClick={() => w.connect()}>Connect wallet</button>
        </>
      ) : (
        <>
          {reg && (
            <div className="tw-armed">
              <span className="tw-state armed"><i />ARMED</span>
              <span className="mono small">{reg.tokens.length} token{reg.tokens.length === 1 ? '' : 's'} → bunker {short(reg.bunker, 6)}</span>
            </div>
          )}
          {neverSigned && (
            <div className="tw-warn">
              <b>This wallet has never signed.</b> Its public key is still hidden, so it is already in bunker mode. Arming
              it means signing transactions, which publishes the key. Leave it alone unless you know why you want this.
              <label className="check"><input type="checkbox" checked={anyway} onChange={e => setAnyway(e.target.checked)} /> arm it anyway</label>
            </div>
          )}
          <label className="tw-field">
            <span className="stat-l">your bunker ID (from the Vault page)</span>
            <input className="field mono" placeholder="0x… 64 hex characters" value={bunker} onChange={e => setBunker(e.target.value)} spellCheck={false} />
            {validId && bunkerOpen === false && <span className="err">This bunker is not open yet. Make any deposit to it on the <a href="#vault">Vault</a> page first.</span>}
            {validId && bunkerOpen === true && <span className="green small">Bunker found in the vault.</span>}
            {!bunker && <span className="dim small">No bunker yet? <a href="#vault">Make one on the Vault page</a>: 24 words, made in your browser.</span>}
          </label>
          <div className="tw-tokens">
            {rows.map(r => (
              <label key={r.address} className="asset-row">
                <span className="tw-tok"><input type="checkbox" checked={r.on} onChange={e => setRows(rs => rs.map(x => x.address === r.address ? { ...x, on: e.target.checked } : x))} />{r.symbol}</span>
                <span className="amt">{fmt(r.balance, r.decimals)}</span>
                <span className={`small ${r.allowance >= maxUint256 / 2n ? 'green' : 'dim'}`}>{r.allowance >= maxUint256 / 2n ? 'approved' : r.allowance > 0n ? 'partial' : '—'}</span>
              </label>
            ))}
            <div className="addtok">
              <input className="field mono" placeholder="add another token: 0x…" value={custom} onChange={e => setCustom(e.target.value)} spellCheck={false} />
              <button className="btn sm" onClick={addCustom}>Add</button>
            </div>
          </div>
          <p className="dim small">ETH itself can not be pulled with an approval. Wrap it to WETH to cover it, or keep it in your bunker.</p>
          <div className="row-gap">
            {tripped ? (
              <button className="btn primary" disabled={!!busy || !reg} onClick={escapeMine}>{busy || 'Escape my wallet now'}</button>
            ) : (
              <button className="btn primary" disabled={!canArm} onClick={arm}>{busy || (reg ? `Update: ${chosen.length} tokens` : `Arm ${chosen.length} token${chosen.length === 1 ? '' : 's'}`)}</button>
            )}
            {reg && !tripped && <button className="btn ghost" disabled={!!busy} onClick={disarm}>Disarm + revoke</button>}
          </div>
          {msg && <p className="small">{msg}</p>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ how it works
function How() {
  return (
    <div className="tw-how">
      <div className="tw-step">
        <span className="tw-n">01</span>
        <h3>The canary</h3>
        <p>An Ethereum address whose public key comes from a hash, so nobody has its private key. A pot of ETH sits on it as a bounty. Only someone who can break ECDSA can sign for it and take it.</p>
      </div>
      <div className="tw-step">
        <span className="tw-n">02</span>
        <h3>The wire</h3>
        <p>The contract trips, once and forever, when the canary signs: a bounty claim, or an EIP-7702 delegation on the canary. That is public, on-chain proof that secp256k1 has fallen.</p>
      </div>
      <div className="tw-step">
        <span className="tw-n">03</span>
        <h3>The escape</h3>
        <p>Armed wallets have approved their tokens to the tripwire. After the trip anyone, including our keeper bot, can sweep them into each owner's bunker, where only hash-based keys can move them.</p>
      </div>
      <p className="tw-fine dim small">
        Honest limits: an attacker can skip the canary and go straight for big wallets, so this is an alarm and a bounty,
        not a guarantee. Tokens can only ever go to the bunker the owner registered; before the trip nothing can move at
        all. No owner, no admin, no upgrade, no fee. The contract has not had an external audit.
      </p>
    </div>
  );
}
