import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatUnits, getAddress, isAddress, parseUnits, zeroAddress, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import * as wots from '../lib/wots.js';
import { vaultAbi, erc20Abi } from './abi';
import { CHAINS, client } from '../chains';
import { useWallet } from '../wallet';
import { TOKEN_ADDRESS, VAULT_ADDRESS, VAULT_BLOCK } from '../config';
import { WotsBars } from '../components/Home';

// ------------------------------------------------------------------ config (dev overrides for fork tests)
const devParam = (name: string): Hex | null => {
  if (!import.meta.env.DEV) return null;
  const v = new URLSearchParams(location.search).get(name);
  return v && isAddress(v) ? getAddress(v) : null;
};
const VAULT: Hex | null = devParam('vault') ?? VAULT_ADDRESS;
const TOKEN: Hex | null = devParam('token') ?? TOKEN_ADDRESS;
const VAULT_FROM: bigint = (import.meta.env.DEV && new URLSearchParams(location.search).get('vaultblock')) ? BigInt(new URLSearchParams(location.search).get('vaultblock')!) : VAULT_BLOCK;
const eth = () => client(1);

interface Asset {
  token: Hex;
  symbol: string;
  decimals: number;
}
const ETH_ASSET: Asset = { token: zeroAddress, symbol: 'ETH', decimals: 18 };

function knownAssets(): Asset[] {
  const list: Asset[] = [ETH_ASSET];
  if (TOKEN) list.push({ token: TOKEN, symbol: 'BUNKER', decimals: 18 });
  for (const t of CHAINS.find(c => c.id === 1)?.tokens ?? []) {
    if (!list.some(a => a.token.toLowerCase() === t.address.toLowerCase()))
      list.push({ token: t.address, symbol: t.symbol, decimals: t.decimals });
  }
  return list;
}

const fmt = (v: bigint, decimals: number) => {
  const s = formatUnits(v, decimals);
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, 6).replace(/0+$/, '');
  return (i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '')) || '0';
};
const short = (h: string, n = 6) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);
const errText = (e: unknown) => {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return /rejected|denied/i.test(m) ? 'You rejected it in the wallet.' : m.split('\n')[0];
};

// ------------------------------------------------------------------ pending signatures (one key = one message)
interface Pending {
  nonce: number;
  digest: Hex;
  nextKey: Hex;
  sig: Hex[];
  transfers: { token: Hex; to: Hex; amount: string }[];
  hash?: Hex;
}
const pendingKey = (id: Hex, nonce: number) => `bunker:sig:${VAULT}:${id}:${nonce}`.toLowerCase();
function loadPending(id: Hex, nonce: number): Pending | null {
  try {
    const raw = localStorage.getItem(pendingKey(id, nonce));
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}
function savePending(id: Hex, p: Pending) {
  try {
    localStorage.setItem(pendingKey(id, p.nonce), JSON.stringify(p));
  } catch {
    /* storage blocked: the signature still goes out, it just can't be re-broadcast from here */
  }
}
function clearPending(id: Hex, nonce: number) {
  try {
    localStorage.removeItem(pendingKey(id, nonce));
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ panel
export default function Vault() {
  const [master, setMaster] = useState<Uint8Array | null>(null);
  return (
    <div className="vault">
      <div className="vault-intro">
        <p className="vault-lede">
          Funds in the BunkerVault move only with a <b>one-time hash signature</b> made from your 24-word bunker phrase.
          No ECDSA key can move them, not yours and not ours. Every withdrawal burns its key and the vault rotates to
          the next one.
        </p>
        <ul className="vault-facts">
          <li><span>Signature</span>Winternitz (WOTS, w=16) over keccak256, 67 chains</li>
          <li><span>Keys</span>one per withdrawal, burned on-chain after use</li>
          <li><span>Submitter</span>any wallet; it only pays gas and cannot change recipients or amounts</li>
          <li><span>Admin</span>none. No owner, no upgrade, no fee</li>
        </ul>
      </div>
      {!VAULT ? (
        <>
          <div className="vault-card vault-off">
            <b>Vault goes live with the $BUNKER launch.</b> The contract is written, tested and rehearsed on a mainnet
            fork; the address appears here at deploy.
          </div>
          <div className="vault-how">
            <ol className="how-steps">
              <li><span><b>Make a bunker phrase.</b> 24 words generated in this browser. It is not your wallet's seed phrase and never leaves the page.</span></li>
              <li><span><b>Deposit.</b> Send ETH or tokens in from any wallet, even an exposed one. From then on that wallet has no say over them.</span></li>
              <li><span><b>Withdraw.</b> Your browser signs with the current one-time key. Any wallet can submit it and only pays gas. The key is burned and the next one takes over.</span></li>
            </ol>
            <WotsBars />
          </div>
        </>
      ) : (
        <>
          <VaultStats vault={VAULT} />
          {master ? (
            <Account master={master} vault={VAULT} onLock={() => setMaster(null)} />
          ) : (
            <>
              <LastBunker vault={VAULT} />
              <PhraseGate onOpen={setMaster} />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ public stats (no phrase needed)
const LAST_ID = 'bunker:last-id';
const rememberId = (id: Hex) => { try { localStorage.setItem(LAST_ID, id); } catch { /* storage blocked */ } };
const lastId = (): Hex | null => { try { return (localStorage.getItem(LAST_ID) as Hex) || null; } catch { return null; } };
const depositedEvent = vaultAbi.find(x => x.type === 'event' && x.name === 'Deposited') as never;
const executedEvent = vaultAbi.find(x => x.type === 'event' && x.name === 'Executed') as never;
const ago = (s: number) => (s < 90 ? `${Math.max(1, Math.round(s))}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`);

interface DepositRow { id: Hex; token: Hex; amount: bigint; tx: Hex; block: bigint; ts?: number }

function VaultStats({ vault }: { vault: Hex }) {
  const [s, setS] = useState<{ eth: bigint; bunker: bigint; deposits: DepositRow[]; bunkers: number; withdrawals: number } | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const c = eth();
        const [ethBal, bunkerBal, dep, exe] = await Promise.all([
          c.getBalance({ address: vault }),
          TOKEN ? c.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }) : Promise.resolve(0n),
          c.getLogs({ address: vault, event: depositedEvent, fromBlock: VAULT_FROM || 0n, toBlock: 'latest' }),
          c.getLogs({ address: vault, event: executedEvent, fromBlock: VAULT_FROM || 0n, toBlock: 'latest' }),
        ]);
        const rows: DepositRow[] = (dep as unknown as { args: { id: Hex; token: Hex; amount: bigint }; transactionHash: Hex; blockNumber: bigint }[])
          .map(l => ({ id: l.args.id, token: l.args.token, amount: l.args.amount, tx: l.transactionHash, block: l.blockNumber }))
          .reverse();
        const recent = rows.slice(0, 6);
        await Promise.all(recent.map(async r => { try { r.ts = Number((await c.getBlock({ blockNumber: r.block })).timestamp); } catch { /* time optional */ } }));
        if (!dead) { setS({ eth: ethBal, bunker: bunkerBal, deposits: rows, bunkers: new Set(rows.map(r => r.id)).size, withdrawals: exe.length }); setErr(false); }
      } catch {
        if (!dead) setErr(true);
      }
    };
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 20_000);
    return () => { dead = true; clearInterval(t); };
  }, [vault]);
  const sym = (t: Hex) => (t === zeroAddress ? 'ETH' : TOKEN && t.toLowerCase() === TOKEN.toLowerCase() ? 'BUNKER' : short(t, 4));
  const now = Date.now() / 1000;
  return (
    <div className="vault-card vault-stats">
      <div className="vs-head">
        <div><span className="stat-k">ETH in the vault</span><span className="stat-v">{s ? fmt(s.eth, 18) : '—'}</span></div>
        <div><span className="stat-k">BUNKER in the vault</span><span className="stat-v">{s ? fmt(s.bunker, 18) : '—'}</span></div>
        <div><span className="stat-k">bunkers</span><span className="stat-v">{s ? s.bunkers : '—'}</span></div>
        <div><span className="stat-k">deposits · withdrawals</span><span className="stat-v">{s ? `${s.deposits.length} · ${s.withdrawals}` : '—'}</span></div>
        <a className="vs-contract mono dim2" href={`https://etherscan.io/address/${vault}`} target="_blank" rel="noreferrer">contract {short(vault, 4)} ↗</a>
      </div>
      {err && <p className="dim small">Could not read the vault right now.</p>}
      {s && s.deposits.length > 0 && (
        <table className="tbl vs-feed">
          <tbody>
            {s.deposits.slice(0, 6).map(r => (
              <tr key={r.tx + r.id + r.token}>
                <td className="green mono">+ {fmt(r.amount, knownAssets().find(a => a.token.toLowerCase() === r.token.toLowerCase())?.decimals ?? 18)} {sym(r.token)}</td>
                <td className="mono dim2">bunker {short(r.id, 4)}</td>
                <td className="dim small">{r.ts ? ago(now - r.ts) : `block ${r.block}`}</td>
                <td className="num"><a className="mono dim2" href={`https://etherscan.io/tx/${r.tx}`} target="_blank" rel="noreferrer">tx ↗</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {s && s.deposits.length === 0 && <p className="dim small">No deposits yet.</p>}
    </div>
  );
}

/** After a reload the bunker is locked (the phrase is never stored), but its public ID is remembered here. */
function LastBunker({ vault }: { vault: Hex }) {
  const id = lastId();
  const [bal, setBal] = useState<{ eth: bigint; bunker: bigint } | null>(null);
  useEffect(() => {
    if (!id) return;
    let dead = false;
    const c = eth();
    Promise.all([
      c.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [id, zeroAddress] }),
      TOKEN ? c.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [id, TOKEN] }) : Promise.resolve(0n),
    ]).then(([e, b]) => { if (!dead) setBal({ eth: e, bunker: b }); }).catch(() => {});
    return () => { dead = true; };
  }, [id, vault]);
  if (!id) return null;
  return (
    <div className="vault-card vault-last">
      <div className="vault-card-h">Your bunker <code className="mono dim2">{short(id, 6)}</code></div>
      <div className="mono">{bal ? `${fmt(bal.eth, 18)} ETH${bal.bunker > 0n ? ` · ${fmt(bal.bunker, 18)} BUNKER` : ''}` : '…'}</div>
      <p className="dim small">Locked. Open it with your 24-word phrase to withdraw.</p>
    </div>
  );
}

// ------------------------------------------------------------------ phrase gate
function PhraseGate({ onOpen }: { onOpen: (m: Uint8Array) => void }) {
  const [mode, setMode] = useState<'start' | 'create' | 'open'>('start');
  const [phrase, setPhrase] = useState('');
  const [typed, setTyped] = useState(['', '']);
  const [saved, setSaved] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const quiz = useMemo(() => {
    const a = Math.floor(Math.random() * 12);
    return [a, 12 + Math.floor(Math.random() * 12)];
  }, [phrase]);
  const words = phrase ? phrase.split(' ') : [];
  const quizOk = words.length === 24 && quiz.every((q, i) => typed[i].trim().toLowerCase() === words[q]);

  if (mode === 'start')
    return (
      <div className="vault-card vault-gate">
        <button className="btn primary" onClick={() => { setPhrase(wots.newPhrase()); setMode('create'); }}>
          Create a bunker
        </button>
        <button className="btn" onClick={() => setMode('open')}>Open my bunker</button>
        <p className="dim">The phrase is made in this browser and never leaves it. It is NOT your wallet's seed phrase.</p>
      </div>
    );

  if (mode === 'create')
    return (
      <div className="vault-card">
        <div className="vault-card-h">Your bunker phrase</div>
        <p className="warn-text">
          Write these 24 words on paper. Whoever has them controls the bunker; lose them and nobody can recover the
          funds. Don't screenshot, don't paste into chats.
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
          <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} /> I wrote all 24 words down offline
        </label>
        <div className="row-gap">
          <button className="btn primary" disabled={!quizOk || !saved} onClick={() => onOpen(wots.masterOf(phrase))}>
            Open my bunker
          </button>
          <button className="btn" onClick={() => { setMode('start'); setPhrase(''); setTyped(['', '']); setSaved(false); }}>
            Back
          </button>
        </div>
      </div>
    );

  return (
    <div className="vault-card">
      <div className="vault-card-h">Open bunker</div>
      <textarea
        className="field mono phrase-input"
        rows={3}
        placeholder="24-word bunker phrase"
        value={input}
        autoComplete="off"
        spellCheck={false}
        onChange={e => { setInput(e.target.value); setError(''); }}
      />
      {error && <p className="err">{error}</p>}
      <div className="row-gap">
        <button
          className="btn primary"
          onClick={() => {
            if (!wots.isPhrase(input)) return setError('That is not a valid 24-word bunker phrase.');
            onOpen(wots.masterOf(input));
            setInput('');
          }}
        >
          Open
        </button>
        <button className="btn" onClick={() => { setMode('start'); setInput(''); }}>Back</button>
      </div>
      <p className="dim">Kept in memory only. Reloading the page locks the bunker again.</p>
    </div>
  );
}

// ------------------------------------------------------------------ account
interface AcctState {
  exists: boolean;
  key: Hex;
  nonce: number;
}

function Account({ master, vault, onLock }: { master: Uint8Array; vault: Hex; onLock: () => void }) {
  const wallet = useWallet();
  const id = useMemo(() => wots.accountId(master), [master]);
  useEffect(() => rememberId(id), [id]);
  const [acct, setAcct] = useState<AcctState | null>(null);
  const [assets, setAssets] = useState<Asset[]>(knownAssets);
  const [bal, setBal] = useState<Record<string, bigint>>({});
  const [loadErr, setLoadErr] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const c = eth();
        const readBal = (list: Asset[]) => Promise.all(list.map(a =>
          c.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [id, a.token] }).catch(() => 0n)));
        // account + balances of the known tokens first: one round of parallel reads
        const known = knownAssets();
        const [[key, nonce], values] = await Promise.all([
          c.readContract({ address: vault, abi: vaultAbi, functionName: 'accounts', args: [id] }),
          readBal(known),
        ]);
        if (dead) return;
        setAcct({ exists: BigInt(key) !== 0n, key, nonce: Number(nonce) });
        setAssets(known);
        setBal(Object.fromEntries(known.map((a, i) => [a.token, values[i]])));
        setLoadErr('');
        // then any other token ever deposited here (best effort; skipped until the deploy block is configured)
        if (VAULT_FROM === 0n) return;
        try {
          const logs = await c.getLogs({
            address: vault,
            event: vaultAbi.find(x => x.type === 'event' && x.name === 'Deposited') as never,
            args: { id } as never,
            fromBlock: VAULT_FROM,
            toBlock: 'latest',
          });
          const extra = [...new Set(logs.map(l => getAddress((l as unknown as { args: { token: Hex } }).args.token)))]
            .filter(t => !known.some(a => a.token.toLowerCase() === t.toLowerCase()));
          if (!extra.length || dead) return;
          const meta = await Promise.all(extra.map(async token => {
            try {
              const [symbol, decimals] = await Promise.all([
                c.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
                c.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
              ]);
              return { token, symbol, decimals } as Asset;
            } catch {
              return { token, symbol: short(token, 4), decimals: 18 } as Asset;
            }
          }));
          const extraVals = await readBal(meta);
          if (dead) return;
          setAssets([...known, ...meta]);
          setBal(b => ({ ...b, ...Object.fromEntries(meta.map((a, i) => [a.token, extraVals[i]])) }));
        } catch {
          /* fine: known tokens are already shown */
        }
      } catch (e) {
        if (!dead) setLoadErr(errText(e));
      }
    })();
    return () => { dead = true; };
  }, [vault, id, tick]);

  const keyOk = !acct || !acct.exists || acct.key === wots.keyHash(master, acct.nonce);
  const held = useMemo(() => assets.filter(a => (bal[a.token] ?? 0n) > 0n), [assets, bal]);

  return (
    <>
      <div className="vault-card vault-head">
        <div className="kv"><span>Bunker ID</span><code className="mono" title={id}>{short(id, 8)}</code>
          <button className="btn sm" onClick={() => navigator.clipboard?.writeText(id).catch(() => {})}>copy</button></div>
        <div className="kv"><span>Status</span>{!acct ? <i className="spin" /> : !acct.exists
          ? <span className="chip warn">empty: deposit to open it</span>
          : keyOk ? <span className="chip hidden">live · key #{acct.nonce}</span>
          : <span className="chip exposed">phrase does not match on-chain key</span>}</div>
        <div className="kv"><span>Vault</span><a className="mono" href={`https://etherscan.io/address/${vault}`} target="_blank" rel="noreferrer">{short(vault, 4)}</a></div>
        <button className="btn sm vault-lock" onClick={onLock}>Lock</button>
      </div>
      {loadErr && <p className="err">Could not read the vault: {loadErr}</p>}

      <div className="vault-card">
        <div className="vault-card-h">Holdings</div>
        {held.length === 0 ? <p className="dim">Nothing in this bunker yet.</p> : (
          <table className="tbl">
            <tbody>
              {held.map(a => (
                <tr key={a.token}><td>{a.symbol}</td><td className="num mono">{fmt(bal[a.token], a.decimals)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Deposit vault={vault} id={id} assets={assets} wallet={wallet} onDone={refresh} />
      {acct?.exists && keyOk && (
        <Withdraw vault={vault} id={id} master={master} acct={acct} held={held} bal={bal} wallet={wallet} onDone={refresh} />
      )}
      <Claims vault={vault} assets={assets} wallet={wallet} />
    </>
  );
}

type Wallet = ReturnType<typeof useWallet>;

async function onEthereum(wallet: Wallet) {
  if (!wallet.address) await wallet.connect();
  if (wallet.chainId !== 1) await wallet.switchChain(1);
}

async function write(wallet: Wallet, req: { address: Hex; abi: unknown; functionName: string; args?: unknown[]; value?: bigint }) {
  if (!wallet.walletClient || !wallet.address) throw new Error('Connect a wallet first.');
  const hash = await wallet.walletClient.writeContract({ ...(req as object), account: wallet.address, chain: mainnet } as never);
  const r = await eth().waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  return hash;
}

// ------------------------------------------------------------------ deposit
function Deposit({ vault, id, assets, wallet, onDone }: { vault: Hex; id: Hex; assets: Asset[]; wallet: Wallet; onDone: () => void }) {
  const [token, setToken] = useState<Hex>(zeroAddress);
  const [amount, setAmount] = useState('');
  const [walletBal, setWalletBal] = useState<bigint | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const asset = assets.find(a => a.token === token) ?? ETH_ASSET;

  useEffect(() => {
    if (!wallet.address) return setWalletBal(null);
    let dead = false;
    const c = eth();
    (token === zeroAddress
      ? c.getBalance({ address: wallet.address })
      : c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet.address] })
    ).then(v => { if (!dead) setWalletBal(v); }).catch(() => { if (!dead) setWalletBal(null); });
    return () => { dead = true; };
  }, [wallet.address, token, busy]);

  const go = async () => {
    setMsg('');
    try {
      const value = parseUnits(amount || '0', asset.decimals);
      if (value <= 0n) throw new Error('Enter an amount.');
      await onEthereum(wallet);
      if (token === zeroAddress) {
        setBusy('Depositing ETH…');
        await write(wallet, { address: vault, abi: vaultAbi, functionName: 'depositETH', args: [id], value });
      } else {
        const allowed = await eth().readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [wallet.address!, vault] });
        if (allowed < value) {
          setBusy(`Approving ${asset.symbol}…`);
          await write(wallet, { address: token, abi: erc20Abi, functionName: 'approve', args: [vault, value] });
        }
        setBusy(`Depositing ${asset.symbol}…`);
        await write(wallet, { address: vault, abi: vaultAbi, functionName: 'deposit', args: [id, token, value] });
      }
      setMsg(`Deposited ${amount} ${asset.symbol}.`);
      setAmount('');
      onDone();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy('');
    }
  };

  const max = () => {
    if (walletBal == null) return;
    const gasBuffer = token === zeroAddress ? parseUnits('0.002', 18) : 0n;
    const v = walletBal > gasBuffer ? walletBal - gasBuffer : 0n;
    setAmount(formatUnits(v, asset.decimals));
  };

  return (
    <div className="vault-card">
      <div className="vault-card-h">Deposit <span className="dim">from the connected wallet, on Ethereum</span></div>
      <div className="form-row">
        <select className="field" value={token} onChange={e => { setToken(e.target.value as Hex); setAmount(''); }}>
          {assets.map(a => <option key={a.token} value={a.token}>{a.symbol}</option>)}
        </select>
        <input className="field mono" inputMode="decimal" placeholder="0.0" value={amount} onChange={e => setAmount(e.target.value.trim())} />
        <button className="btn sm" onClick={max} disabled={walletBal == null}>max</button>
      </div>
      <div className="dim small">
        {wallet.address ? <>wallet: {walletBal == null ? '…' : fmt(walletBal, asset.decimals)} {asset.symbol}{token === zeroAddress && ' · max keeps 0.002 ETH for gas'}</> : 'connect a wallet to deposit'}
      </div>
      <button className="btn primary" disabled={!!busy} onClick={wallet.address ? go : () => wallet.connect().catch(e => setMsg(errText(e)))}>
        {busy || (wallet.address ? 'Deposit to bunker' : 'Connect wallet')}
      </button>
      {msg && <p className="small">{msg}</p>}
      <p className="dim small">Rebasing tokens (stETH) are not supported: deposit wstETH. The depositing wallet signs with ECDSA as usual; after this, that wallet has no say over the funds.</p>
    </div>
  );
}

// ------------------------------------------------------------------ withdraw
function Withdraw({ vault, id, master, acct, held, bal, wallet, onDone }: {
  vault: Hex; id: Hex; master: Uint8Array; acct: AcctState; held: Asset[]; bal: Record<string, bigint>; wallet: Wallet; onDone: () => void;
}) {
  const [to, setTo] = useState('');
  const [pick, setPick] = useState<Record<string, { on: boolean; amount: string }>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [pending, setPending] = useState<Pending | null>(() => loadPending(id, acct.nonce));

  useEffect(() => {
    setPick(Object.fromEntries(held.map(a => [a.token, { on: true, amount: formatUnits(bal[a.token], a.decimals) }])));
  }, [held, bal]);
  useEffect(() => setPending(loadPending(id, acct.nonce)), [id, acct.nonce]);

  const submit = async (p: Pending) => {
    await onEthereum(wallet);
    setBusy(`Sending with key #${p.nonce}…`);
    if (!wallet.walletClient || !wallet.address) throw new Error('Connect a wallet first.');
    const hash = await wallet.walletClient.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'execute',
      args: [id, p.transfers.map(t => ({ token: t.token, to: t.to, amount: BigInt(t.amount) })), zeroAddress, 0n, p.nextKey, p.sig as never],
      account: wallet.address,
      chain: mainnet,
    });
    savePending(id, { ...p, hash });
    setPending({ ...p, hash });
    const r = await eth().waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
    clearPending(id, p.nonce);
    setPending(null);
    return hash;
  };

  const go = async () => {
    setMsg('');
    try {
      if (!isAddress(to)) throw new Error('Enter a valid destination address.');
      const dest = getAddress(to);
      if (dest.toLowerCase() === vault.toLowerCase()) throw new Error('The destination can not be the vault itself.');
      const transfers = held
        .filter(a => pick[a.token]?.on)
        .map(a => ({ token: a.token, to: dest, amount: parseUnits(pick[a.token].amount || '0', a.decimals), a }));
      if (!transfers.length) throw new Error('Pick at least one asset.');
      for (const t of transfers) {
        if (t.amount <= 0n) throw new Error(`Enter an amount for ${t.a.symbol}.`);
        if (t.amount > (bal[t.token] ?? 0n)) throw new Error(`Not enough ${t.a.symbol} in the bunker.`);
      }
      setBusy('Checking the vault…');
      const c = eth();
      const [key, nonceBig] = await c.readContract({ address: vault, abi: vaultAbi, functionName: 'accounts', args: [id] });
      const nonce = Number(nonceBig);
      if (key !== wots.keyHash(master, nonce)) throw new Error('On-chain key does not match this phrase. Refresh and retry.');
      const nextKey = wots.keyHash(master, nonce + 1);
      if (await c.readContract({ address: vault, abi: vaultAbi, functionName: 'spentKey', args: [nextKey] }))
        throw new Error('Next key is already burned. This should never happen; stop and ask for help.');
      const list = transfers.map(t => ({ token: t.token, to: t.to, amount: t.amount }));
      const digest = wots.digestOf({ chainId: 1, vault, id, nonce, transfers: list, relayer: zeroAddress, fee: 0n, nextKey });
      const onchain = await c.readContract({ address: vault, abi: vaultAbi, functionName: 'digest', args: [id, list, zeroAddress, 0n, nextKey] });
      if (onchain !== digest) throw new Error('Message mismatch with the contract. Nothing was signed.');

      const prior = loadPending(id, nonce);
      if (prior && prior.digest !== digest)
        throw new Error(`Key #${nonce} already signed a different withdrawal. Re-broadcast that one (below) — a key must never sign two messages.`);
      const sig = prior?.sig ?? wots.sign(master, nonce, digest);
      if (wots.recover(digest, sig) !== key) throw new Error('Signature self-check failed. Nothing was sent.');
      const p: Pending = { nonce, digest, nextKey, sig, transfers: list.map(t => ({ ...t, amount: t.amount.toString() })) };
      savePending(id, p);
      setPending(p);
      const hash = await submit(p);
      setMsg(`Done. Key #${nonce} burned, bunker rotated to key #${nonce + 1}. Tx ${short(hash, 6)}`);
      onDone();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy('');
    }
  };

  const rebroadcast = async () => {
    if (!pending) return;
    setMsg('');
    try {
      const [, nonceBig] = await eth().readContract({ address: vault, abi: vaultAbi, functionName: 'accounts', args: [id] });
      if (Number(nonceBig) > pending.nonce) {
        clearPending(id, pending.nonce);
        setPending(null);
        setMsg(`Key #${pending.nonce} already landed on-chain.`);
        onDone();
        return;
      }
      const hash = await submit(pending);
      setMsg(`Done. Tx ${short(hash, 6)}`);
      onDone();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="vault-card">
      <div className="vault-card-h">Withdraw <span className="dim">signed with key #{acct.nonce}, then rotates</span></div>
      {pending && (
        <div className="vault-pending">
          <b>Signed, not confirmed yet:</b> key #{pending.nonce} →{' '}
          {pending.transfers.length} transfer{pending.transfers.length > 1 ? 's' : ''} to {short(pending.transfers[0].to, 4)}
          {pending.hash && <> · <a href={`https://etherscan.io/tx/${pending.hash}`} target="_blank" rel="noreferrer">tx</a></>}
          <button className="btn sm" disabled={!!busy} onClick={rebroadcast}>Re-broadcast / check</button>
        </div>
      )}
      <input className="field mono" placeholder="destination address (fresh, never signed)" value={to} onChange={e => setTo(e.target.value.trim())} />
      <table className="tbl">
        <tbody>
          {held.map(a => (
            <tr key={a.token}>
              <td><label className="check"><input type="checkbox" checked={!!pick[a.token]?.on}
                onChange={e => setPick(p => ({ ...p, [a.token]: { ...p[a.token], on: e.target.checked } }))} /> {a.symbol}</label></td>
              <td><input className="field field-sm mono num" inputMode="decimal" value={pick[a.token]?.amount ?? ''}
                onChange={e => setPick(p => ({ ...p, [a.token]: { ...p[a.token], amount: e.target.value.trim() } }))} /></td>
              <td className="dim small num">of {fmt(bal[a.token], a.decimals)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn primary" disabled={!!busy || !held.length || !!pending} onClick={wallet.address ? go : () => wallet.connect().catch(e => setMsg(errText(e)))}>
        {busy || (wallet.address ? `Sign with key #${acct.nonce} & send` : 'Connect a wallet to submit')}
      </button>
      {msg && <p className="small">{msg}</p>}
      <p className="dim small">
        The signature is made in this browser. The connected wallet only submits it and pays gas (any wallet works, a
        throwaway is fine). If it doesn't confirm, re-broadcast the same signature: never sign a different withdrawal
        with the same key, here or on another device.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ claims (sends that failed inside a withdrawal)
function Claims({ vault, assets, wallet }: { vault: Hex; assets: Asset[]; wallet: Wallet }) {
  const [owed, setOwed] = useState<{ a: Asset; v: bigint }[]>([]);
  const [msg, setMsg] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!wallet.address) return setOwed([]);
    let dead = false;
    Promise.all(assets.map(a => eth().readContract({ address: vault, abi: vaultAbi, functionName: 'claimable', args: [wallet.address!, a.token] })
      .then(v => ({ a, v })).catch(() => ({ a, v: 0n }))))
      .then(r => { if (!dead) setOwed(r.filter(x => x.v > 0n)); });
    return () => { dead = true; };
  }, [wallet.address, assets, vault, tick]);
  if (!owed.length) return null;
  return (
    <div className="vault-card">
      <div className="vault-card-h">Claimable by your wallet</div>
      {owed.map(({ a, v }) => (
        <div key={a.token} className="form-row">
          <span className="mono">{fmt(v, a.decimals)} {a.symbol}</span>
          <button className="btn sm" onClick={async () => {
            try { await onEthereum(wallet); await write(wallet, { address: vault, abi: vaultAbi, functionName: 'claim', args: [wallet.address!, a.token] }); setTick(t => t + 1); }
            catch (e) { setMsg(errText(e)); }
          }}>claim</button>
        </div>
      ))}
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}
