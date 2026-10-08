import { useEffect, useMemo, useState } from 'react';
import { getAddress, keccak256, toBytes, type Hex } from 'viem';
import { client } from '../chains';
import { DRAKE_TWEET, GITHUB_URL, TOKEN_ADDRESS, VAULT_ADDRESS, X_URL } from '../config';
import { parseAddressList } from '../lib/exposure';
import { fmtAmt, fmtUsd, short } from '../lib/format';
import * as wots from '../lib/wots.js';
import { usePrices } from '../prices';
import { useWallet } from '../wallet';
import { MAX_ADDR, ScanResults } from './Scan';
import { CopyBtn } from './ui';

const EXAMPLES: { label: string; addr: string }[] = [
  { label: 'vitalik.eth', addr: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
  { label: 'Binance 7', addr: '0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8' },
  { label: 'Robinhood 1', addr: '0x40B38765696e3d5d8d9d834D8AaD4bB6e418E489' },
  { label: 'a Taproot address', addr: 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297' },
];

export function Home({ list, onScan }: { list: string[]; onScan: (l: string[]) => void }) {
  const board = useBoard();
  return (
    <>
      <section className={`hx${list.length ? ' hx-results' : ''}`} id="scan">
        <div className="hx-img" aria-hidden="true" />
        <div className="wrap hx-in">
          <div className="hx-kicker">Enter bunker mode.</div>
          <h1 className="hx-h">Your key is<br />already out.</h1>
          <p className="hx-p">
            Every wallet that ever signed has its public key on-chain. If ECDSA breaks, those go first.{' '}
            <a href={DRAKE_TWEET} target="_blank" rel="noreferrer">Why now ↗</a>
          </p>
          <ScanBar onScan={onScan} current={list} />
        </div>
      </section>
      {list.length > 0 && (
        <div className="wrap hx-res">
          <ScanResults list={list} />
        </div>
      )}
      <Stats board={board} />
      <Board board={board} onScan={onScan} />
      <Tools />
      <Coin />
      <Faq />
    </>
  );
}

// ------------------------------------------------------------------ scan bar
function ScanBar({ onScan, current }: { onScan: (l: string[]) => void; current: string[] }) {
  const w = useWallet();
  const [text, setText] = useState(current.join(', '));
  useEffect(() => setText(current.join(', ')), [current.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (t = text) => {
    const l = parseAddressList(t).slice(0, MAX_ADDR);
    if (l.length) onScan(l);
  };
  return (
    <div className="scanbar">
      <form className="scanbar-row" onSubmit={e => { e.preventDefault(); go(); }}>
        <input
          className="scan-input"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Paste a wallet: 0x…, bc1…, or Solana"
          spellCheck={false}
          autoComplete="off"
          aria-label="Addresses to scan"
        />
        <button className="btn primary scan-go" type="submit">Scan</button>
      </form>
      <div className="scan-try">
        <span>try</span>
        {w.address && (
          <button className="linkish" onClick={() => { setText(w.address!); go(w.address!); }}>my wallet</button>
        )}
        {EXAMPLES.map(x => (
          <button key={x.label} className="linkish" onClick={() => { setText(x.addr); go(x.addr); }}>{x.label}</button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ live board data (shared by the stats strip and the table)
interface BoardRow {
  hash: Hex;
  label?: string;
  eth: number;
  nonce?: number;
  code?: string;
  failed?: boolean;
}
interface BsAddr {
  hash: string;
  is_contract: boolean;
  coin_balance: string | null;
  ens_domain_name?: string | null;
  metadata?: { tags?: { tagType: string; name: string }[] } | null;
}
const BOARD_SIZE = 20;
const labelOf = (a: BsAddr) => (a.metadata?.tags ?? []).filter(t => t.tagType === 'name').map(t => t.name)[0] ?? a.ens_domain_name ?? undefined;
const rowExposed = (r: BoardRow) => (r.nonce ?? 0) > 0 || !!r.code?.toLowerCase().startsWith('0xef0100');

interface BoardState {
  rows: BoardRow[] | null;
  err: boolean;
  retry: () => void;
}

function useBoard(): BoardState {
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [err, setErr] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    let dead = false;
    setErr(false);
    (async () => {
      try {
        const r = await fetch('https://eth.blockscout.com/api/v2/addresses', { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as { items: BsAddr[] };
        const base: BoardRow[] = j.items
          .filter(a => !a.is_contract && a.coin_balance)
          .slice(0, BOARD_SIZE)
          .map(a => ({ hash: getAddress(a.hash), label: labelOf(a), eth: Number(BigInt(a.coin_balance!) / 10n ** 14n) / 1e4 }));
        if (dead) return;
        setRows(base);
        const pc = client(1);
        await Promise.all(base.map(async (row, i) => {
          try {
            const [nonce, code] = await Promise.all([pc.getTransactionCount({ address: row.hash }), pc.getCode({ address: row.hash })]);
            if (!dead) setRows(prev => prev && prev.map((x, j) => (j === i ? { ...x, nonce, code: code ?? '0x' } : x)));
          } catch {
            if (!dead) setRows(prev => prev && prev.map((x, j) => (j === i ? { ...x, failed: true } : x)));
          }
        }));
      } catch {
        if (!dead) setErr(true);
      }
    })();
    return () => { dead = true; };
  }, [n]);
  return { rows, err, retry: () => setN(x => x + 1) };
}

// ------------------------------------------------------------------ stats strip
function Stats({ board }: { board: BoardState }) {
  const prices = usePrices();
  const s = useMemo(() => {
    const done = (board.rows ?? []).filter(r => r.nonce !== undefined);
    const exposed = done.filter(rowExposed);
    return { done: done.length, total: board.rows?.length ?? 0, exposed: exposed.length, eth: exposed.reduce((t, r) => t + r.eth, 0) };
  }, [board.rows]);
  const ready = s.done > 0;
  return (
    <section className="stats" aria-label="Live numbers">
      <div className="wrap stats-in">
        <div className="stat">
          <span className="stat-n red">{ready ? `${s.exposed}/${s.total}` : '—'}</span>
          <span className="stat-l">biggest ETH wallets already exposed their key</span>
        </div>
        <div className="stat">
          <span className="stat-n">{ready ? fmtAmt(s.eth) : '—'}</span>
          <span className="stat-l">ETH sitting on those public keys</span>
        </div>
        <div className="stat">
          <span className="stat-n">{ready && prices.eth ? fmtUsd(s.eth * prices.eth) : '—'}</span>
          <span className="stat-l">at today's price</span>
        </div>
        <div className="stat">
          <span className="stat-n acc">0</span>
          <span className="stat-l">ECDSA keys that can open the vault</span>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ board table
function Board({ board, onScan }: { board: BoardState; onScan: (l: string[]) => void }) {
  const prices = usePrices();
  const { rows, err, retry } = board;
  return (
    <section className="wrap blk board" id="board">
      <div className="blk-head">
        <h2 className="h2">The whales already signed.</h2>
        <p className="lede">
          The {BOARD_SIZE} largest ETH holders that are plain keys, live from the chain. Labels from Blockscout. Tap a row to scan it.
        </p>
      </div>
      {err ? (
        <p className="dim">Blockscout didn't answer. <button className="linkish" onClick={retry}>retry</button></p>
      ) : (
        <table className="wtbl">
          <thead>
            <tr>
              <th className="w-rank">#</th>
              <th>holder</th>
              <th className="w-addr">address</th>
              <th className="right">ETH</th>
              <th className="right w-usd">USD</th>
              <th className="right w-sig">signed</th>
              <th className="w-key">key</th>
            </tr>
          </thead>
          <tbody>
            {!rows
              ? Array.from({ length: 8 }, (_, i) => (
                <tr key={i} className="skel-row"><td colSpan={7}><span className="skel" style={{ width: `${86 - i * 6}%` }} /></td></tr>
              ))
              : rows.map((r, i) => {
                const known = r.nonce !== undefined;
                const exposed = known && rowExposed(r);
                return (
                  <tr key={r.hash} className="r click" onClick={() => { onScan([r.hash]); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                    <td className="w-rank mono">{String(i + 1).padStart(2, '0')}</td>
                    <td className="w-label">{r.label ?? <span className="dim">unlabeled</span>}</td>
                    <td className="w-addr mono">{short(r.hash, 5)}</td>
                    <td className="num">{fmtAmt(r.eth)}</td>
                    <td className="num w-usd dim2">{prices.eth ? fmtUsd(r.eth * prices.eth) : '—'}</td>
                    <td className="num w-sig dim2">{known ? r.nonce!.toLocaleString() : r.failed ? '?' : <span className="skel sm" />}</td>
                    <td className="w-key">
                      {!known
                        ? <span className="state dim">{r.failed ? 'retry' : 'reading'}</span>
                        : exposed ? <span className="state bad"><i />exposed</span> : <span className="state ok"><i />never signed</span>}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}
      <p className="fine">
        Bitcoin: Project Eleven's <a href="https://bitcoin-risq-list.projecteleven.com" target="_blank" rel="noreferrer">risq list</a> tracks exposed BTC.
        Exposure is a fact about the chain, not a claim that anyone's funds are in danger today.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ tools
function Tools() {
  return (
    <section className="wrap blk tools2">
      <div className="blk-head">
        <h2 className="h2">Four ways in.</h2>
      </div>
      <a className="tl" href="#scan" onClick={e => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
        <span className="tl-w">Scan</span>
        <span className="tl-d">See which of your addresses already leaked their public key. Seven EVM chains, Bitcoin and Solana. Read-only.</span>
        <span className="tl-a" aria-hidden="true">↗</span>
      </a>
      <a className="tl" href="#move">
        <span className="tl-w">Move</span>
        <span className="tl-d">Sweep a wallet into a fresh address that has never signed. Tokens first, ETH last. One click per chain.</span>
        <span className="tl-a" aria-hidden="true">↗</span>
      </a>
      <a className="tl" href="#vault">
        <span className="tl-w">Vault</span>
        <span className="tl-d">Park ETH and tokens behind hash-based one-time signatures. No ECDSA key can move them. Every key burns after one use.</span>
        <span className="tl-a" aria-hidden="true">↗</span>
      </a>
      <a className="tl" href="#tripwire">
        <span className="tl-w">Tripwire</span>
        <span className="tl-d">A bounty on ECDSA wired to an escape hatch. The moment the canary key signs, every armed wallet evacuates into its bunker.</span>
        <span className="tl-a" aria-hidden="true">↗</span>
      </a>
      <div className="vx">
        <div className="vx-copy">
          <div className="hx-kicker">BunkerVault</div>
          <h3 className="h2 vx-h">No ECDSA can move it.</h3>
          <p className="lede">
            Withdrawals are signed with Winternitz one-time keys over keccak256: the hash-only cryptography Drake points to as
            the exit. Each signature commits to the next key, and the used key is burned on-chain. No owner. No upgrade. No fee.
          </p>
          <div className="row-gap">
            <a className="btn primary" href="#vault">{VAULT_ADDRESS ? 'Open the vault' : 'See the vault'}</a>
            <a className="btn ghost" href="#docs">How it works</a>
          </div>
        </div>
        <WotsBars />
      </div>
    </section>
  );
}

export function WotsBars() {
  const [d, setD] = useState<Hex>(() => keccak256(toBytes('bunker mode')));
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) setD(keccak256(globalThis.crypto.getRandomValues(new Uint8Array(32))));
    }, 2800);
    return () => clearInterval(t);
  }, []);
  const digits = wots.digitsOf(d);
  return (
    <div className="tool-demo wots" aria-label="A Winternitz signature, one bar per hash chain">
      <div className="demo-head"><span className="dim">one withdrawal signature</span><span className="mono">67 hash chains</span></div>
      <div className="wots-bars">
        {digits.map((v, i) => (
          <span key={i} className={i >= 64 ? 'ck' : ''} style={{ transform: `scaleY(${(v + 1) / 16})` }} />
        ))}
      </div>
      <div className="demo-foot">
        Each bar is how far one chain is hashed for this message. The 3 yellow checksum chains stop anyone from
        hashing further to forge another one. <span className="mono dim">digest {short(d, 6)}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ coin
function Coin() {
  const t = TOKEN_ADDRESS;
  return (
    <section className="coin2" id="coin">
      <div className="wrap coin2-in">
        <div className="coin2-top">
          <h2 className="coin2-h">$BUNKER</h2>
          <div className="coin2-tags">
            <span>0% tax</span><span>1B fixed supply</span><span>LP locked in the contract</span><span>no admin keys</span><span>verified</span>
          </div>
        </div>
        {t ? (
          <>
            <div className="ca">
              <span className="ca-k">CA</span>
              <code className="ca-v">{t}</code>
              <CopyBtn text={t} />
            </div>
            <div className="row-gap">
              <a className="btn primary" href={`https://app.uniswap.org/swap?chain=mainnet&outputCurrency=${t}`} target="_blank" rel="noreferrer">Buy on Uniswap</a>
              <a className="btn" href={`https://dexscreener.com/ethereum/${t}`} target="_blank" rel="noreferrer">Chart</a>
              <a className="btn" href={`https://etherscan.io/token/${t}`} target="_blank" rel="noreferrer">Etherscan</a>
              <a className="btn" href={X_URL} target="_blank" rel="noreferrer">X</a>
              {GITHUB_URL && <a className="btn" href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>}
            </div>
          </>
        ) : (
          <p className="lede">Launching on Ethereum. The contract address appears here at launch.</p>
        )}
        <p className="fine">
          The token minted its whole supply into one Uniswap v4 position that the contract itself owns. There is no function
          that removes it. No permit(): $BUNKER never asks you for an off-chain signature.
        </p>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ questions
const QA: [string, string][] = [
  ['Why does a transaction expose my key?', 'The network checks who signed by rebuilding the public key from the signature. Once you have signed anything, anyone can do the same.'],
  ['Is this an emergency?', 'No. Nobody has shown an ECDSA break. Moving to a fresh address is cheap insurance, and a calm migration beats a rushed one.'],
  ['Can I keep my seed phrase?', 'Yes. A new account index from the same seed is a new key pair. What matters is that the new address never signs.'],
  ['Do logins and permits count?', 'Yes. Sign-in messages, permits, gasless swaps and NFT listings are signatures too. A bunker signs nothing.'],
];

function Faq() {
  return (
    <section className="wrap blk faq2">
      <div className="blk-head"><h2 className="h2">Questions.</h2></div>
      <div className="qa2">
        {QA.map(([q, a]) => (
          <div key={q} className="qa2-i">
            <h4>{q}</h4>
            <p>{a}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
