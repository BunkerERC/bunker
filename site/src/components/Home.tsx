import { useEffect, useMemo, useState } from 'react';
import { getAddress, keccak256, toBytes, type Hex } from 'viem';
import { client } from '../chains';
import { DRAKE_TWEET, GITHUB_URL, TOKEN_ADDRESS, VAULT_ADDRESS, X_HANDLE, X_URL } from '../config';
import { parseAddressList } from '../lib/exposure';
import { fmtAmt, fmtUsd, short } from '../lib/format';
import * as wots from '../lib/wots.js';
import { usePrices } from '../prices';
import { useWallet } from '../wallet';
import { MAX_ADDR, ScanResults } from './Scan';
import { Chip, CopyBtn } from './ui';

const EXAMPLES: { label: string; addr: string }[] = [
  { label: 'vitalik.eth', addr: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
  { label: 'Binance 7', addr: '0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8' },
  { label: 'Robinhood 1', addr: '0x40B38765696e3d5d8d9d834D8AaD4bB6e418E489' },
  { label: 'a Taproot address', addr: 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297' },
];

export function Home({ list, onScan }: { list: string[]; onScan: (l: string[]) => void }) {
  return (
    <>
      <section className={`hero${list.length ? ' has-results' : ''}`} id="scan">
        <div className="hero-main">
          <h1 className="display hero-h">Has your wallet already shown its key?</h1>
          <p className="hero-p">
            An address is a hash of a public key. The key stays hidden until the address signs something, then it sits
            on-chain for good. If ECDSA breaks, those keys go first. Paste any address to see where you stand.
          </p>
          <ScanBar onScan={onScan} current={list} />
        </div>
        <Lifecycle />
      </section>
      <div className="wrap-results">
        <ScanResults list={list} />
      </div>
      <Board onScan={onScan} />
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
          placeholder="0x…, bc1…, or a Solana address. Several? Separate with commas."
          spellCheck={false}
          autoComplete="off"
          aria-label="Addresses to scan"
        />
        <button className="btn primary scan-go" type="submit">Scan</button>
      </form>
      <div className="scan-try">
        <span className="dim">try</span>
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

// ------------------------------------------------------------------ lifecycle diagram
function Lifecycle() {
  return (
    <aside className="life" aria-label="How a key gets exposed">
      <div className="life-step">
        <div className="life-dot ok" />
        <div className="life-body">
          <div className="life-h">Fresh address <Chip status="hidden" /></div>
          <code className="life-code">address = keccak256(pubkey)[12:]</code>
          <p>Only a 20-byte hash is public. Nothing to attack.</p>
        </div>
      </div>
      <div className="life-step">
        <div className="life-dot bad" />
        <div className="life-body">
          <div className="life-h">First signature <Chip status="exposed" /></div>
          <code className="life-code">ecrecover(msg, r, s, v) → pubkey</code>
          <p>Every transaction, permit or login signature lets anyone rebuild the 64-byte public key.</p>
        </div>
      </div>
      <div className="life-step">
        <div className="life-dot warn" />
        <div className="life-body">
          <div className="life-h">If ECDSA breaks</div>
          <code className="life-code">pubkey → private key</code>
          <p>Fast key recovery turns every exposed address into an open one. Hidden keys still need a hash preimage.</p>
        </div>
      </div>
      <div className="life-step">
        <div className="life-dot ok" />
        <div className="life-body">
          <div className="life-h">Bunker mode</div>
          <p>Move to a fresh address and sign nothing with it. Signed once? Move the rest to the next one.</p>
          <a className="life-src" href={DRAKE_TWEET} target="_blank" rel="noreferrer">Justin Drake's call, Oct 7 ↗</a>
        </div>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ live board: biggest plain keys on Ethereum
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

function labelOf(a: BsAddr): string | undefined {
  const names = (a.metadata?.tags ?? []).filter(t => t.tagType === 'name').map(t => t.name);
  return names[0] ?? a.ens_domain_name ?? undefined;
}
const rowExposed = (r: BoardRow) => (r.nonce ?? 0) > 0 || !!r.code?.toLowerCase().startsWith('0xef0100');

function Board({ onScan }: { onScan: (l: string[]) => void }) {
  const prices = usePrices();
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

  const stats = useMemo(() => {
    if (!rows) return null;
    const done = rows.filter(r => r.nonce !== undefined);
    const exposed = done.filter(rowExposed);
    const eth = exposed.reduce((s, r) => s + r.eth, 0);
    return { done: done.length, total: rows.length, exposed: exposed.length, eth };
  }, [rows]);

  return (
    <section className="sec board" id="board">
      <div className="sec-head">
        <h2 className="display sec-h">The biggest keys on Ethereum are already public</h2>
        <p className="sec-p">
          The {BOARD_SIZE} largest ETH holders that are plain keys, not contracts. Live from the chain; labels from
          Blockscout. Click any row to scan it.
        </p>
      </div>
      <div className="board-stats">
        <div>
          <span className="stat-k">exposed</span>
          <span className="stat-v red">{stats && stats.done ? `${stats.exposed} / ${stats.done}` : '—'}</span>
        </div>
        <div>
          <span className="stat-k">ETH on exposed keys</span>
          <span className="stat-v">{stats && stats.done ? fmtAmt(stats.eth) : '—'}</span>
        </div>
        <div>
          <span className="stat-k">at today's price</span>
          <span className="stat-v">{stats && stats.done && prices.eth ? fmtUsd(stats.eth * prices.eth) : '—'}</span>
        </div>
      </div>
      <div className="panel">
        {err ? (
          <div className="panel-body dim">
            Blockscout didn't answer. <button className="linkish" onClick={() => setN(x => x + 1)}>retry</button>
          </div>
        ) : (
          <table className="tbl board-tbl">
            <thead>
              <tr>
                <th className="b-rank">#</th>
                <th>holder</th>
                <th className="b-addr">address</th>
                <th className="right">ETH</th>
                <th className="right b-usd">USD</th>
                <th className="right b-sig">signatures</th>
                <th className="b-key">key</th>
              </tr>
            </thead>
            <tbody>
              {!rows
                ? Array.from({ length: 8 }, (_, i) => (
                  <tr key={i} className="skel-row">
                    <td colSpan={7}><span className="skel" style={{ width: `${88 - i * 6}%` }} /></td>
                  </tr>
                ))
                : rows.map((r, i) => (
                  <tr
                    key={r.hash}
                    className="r click"
                    style={{ animationDelay: `${i * 25}ms` }}
                    onClick={() => { onScan([r.hash]); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  >
                    <td className="b-rank dim mono">{i + 1}</td>
                    <td className="b-label">{r.label ?? <span className="dim">unlabeled</span>}</td>
                    <td className="b-addr mono dim2">{short(r.hash, 5)}</td>
                    <td className="num">{fmtAmt(r.eth)}</td>
                    <td className="num b-usd dim2">{prices.eth ? fmtUsd(r.eth * prices.eth) : '—'}</td>
                    <td className="num b-sig dim2">{r.nonce === undefined ? (r.failed ? '?' : <span className="skel sm" />) : r.nonce.toLocaleString()}</td>
                    <td className="b-key">
                      {r.nonce === undefined
                        ? (r.failed ? <Chip status="warn" label="⚠︎ retry" /> : <Chip status="pending" />)
                        : rowExposed(r) ? <Chip status="exposed" /> : <Chip status="hidden" label="✓ never signed" />}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="fine">
        Bitcoin holders: Project Eleven's{' '}
        <a href="https://bitcoin-risq-list.projecteleven.com" target="_blank" rel="noreferrer">risq list</a>{' '}
        tracks exposed BTC. Exposure is a fact about the chain, not a claim that anyone's funds are in danger today.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------ tools
function Tools() {
  return (
    <section className="sec tools">
      <div className="tool">
        <div className="tool-copy">
          <span className="tool-tag">tool 01</span>
          <h3 className="display tool-h">Move: sweep into a fresh address</h3>
          <p>
            Connect the wallet you want to retire, paste a new address from the same seed that has never signed, and
            move everything chain by chain. Tokens first, ETH last minus gas. One confirmation when your wallet
            batches, otherwise one per asset.
          </p>
          <ul className="tool-list">
            <li>Checks the destination never signed on all 7 chains</li>
            <li>Ethereum, Base, Arbitrum, Optimism, Polygon, BNB, Robinhood Chain</li>
            <li>Plain transfers signed in your wallet. No contract, no custody</li>
          </ul>
          <a className="btn primary" href="#move">Open Move</a>
        </div>
        <div className="tool-demo" aria-hidden="true">
          <div className="demo-head"><span className="dim">example · Ethereum</span><span className="mono">sweep log</span></div>
          <div className="demo-line"><span className="green">✓</span> USDC 18,240.55 → bunker<span className="dim mono">0x8f2c…a91e</span></div>
          <div className="demo-line"><span className="green">✓</span> WBTC 0.4112 → bunker<span className="dim mono">0x1b07…44d0</span></div>
          <div className="demo-line"><span className="green">✓</span> ETH 6.2391 (all but gas) → bunker<span className="dim mono">0xe4f3…44c3</span></div>
          <div className="demo-foot">source keeps <span className="mono">0.00004 ETH</span> of dust. Bunker: <span className="green">never signed</span></div>
        </div>
      </div>
      <div className="tool tool-flip">
        <div className="tool-copy">
          <span className="tool-tag">tool 02</span>
          <h3 className="display tool-h">Vault: no ECDSA can move it</h3>
          <p>
            BunkerVault holds ETH and tokens for accounts controlled by Winternitz one-time signatures over keccak256,
            the hash-based crypto Drake points to as the exit. You keep a 24-word bunker phrase; each withdrawal burns
            its key on-chain and rotates to the next.
          </p>
          <ul className="tool-list">
            <li>Any wallet can submit a withdrawal; it can't change recipients or amounts</li>
            <li>No owner, no upgrade, no fee</li>
            <li>About 200k-280k gas per withdrawal</li>
          </ul>
          <a className="btn primary" href="#vault">{VAULT_ADDRESS ? 'Open Vault' : 'See the vault'}</a>
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
    <section className="sec coin" id="coin">
      <div className="coin-grid">
        <div>
          <h2 className="display sec-h">$BUNKER</h2>
          <p className="sec-p">The coin of bunker mode. On Ethereum, paired with ETH on Uniswap v4.</p>
          {t ? (
            <div className="coin-ca">
              <code className="mono ca">{t}</code>
              <CopyBtn text={t} />
              <div className="coin-links">
                <a className="btn primary" href={`https://app.uniswap.org/swap?chain=mainnet&outputCurrency=${t}`} target="_blank" rel="noreferrer">Buy on Uniswap</a>
                <a className="btn" href={`https://dexscreener.com/ethereum/${t}`} target="_blank" rel="noreferrer">Chart</a>
                <a className="btn" href={`https://etherscan.io/token/${t}`} target="_blank" rel="noreferrer">Etherscan</a>
                <a className="btn" href={X_URL} target="_blank" rel="noreferrer">{X_HANDLE}</a>
                {GITHUB_URL && <a className="btn" href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>}
              </div>
            </div>
          ) : (
            <div className="coin-soon">
              <span className="soon-dot" /> Launching on Ethereum. The contract address appears here at launch; anything
              posted before that is not us.
            </div>
          )}
        </div>
        <dl className="facts">
          <div><dt>supply</dt><dd className="mono">1,000,000,000 fixed</dd></div>
          <div><dt>max wallet</dt><dd>2% at launch, switched off for good at block 26,144,084. It can never come back</dd></div>
          <div><dt>admin</dt><dd>No mint, tax, pause or blacklist. The deployer's only remaining powers: none that touch balances or liquidity</dd></div>
          <div><dt>permit()</dt><dd>Left out on purpose: $BUNKER never asks you for an off-chain signature</dd></div>
          <div><dt>liquidity</dt><dd>All 1,000,000,000 went into the Uniswap v4 ETH pool (1% tier) and the position is held by the token contract itself. No function can remove it: locked forever</dd></div>
          <div><dt>vault</dt><dd>{VAULT_ADDRESS
            ? <a className="mono" href={`https://etherscan.io/address/${VAULT_ADDRESS}`} target="_blank" rel="noreferrer">{short(VAULT_ADDRESS, 6)}</a>
            : 'BunkerVault deploys with the coin'}</dd></div>
        </dl>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ questions
const QA: [string, string][] = [
  ['Why does a transaction expose my key?', 'The network checks who signed by rebuilding the public key from the signature. Once you have signed anything, anyone can do the same.'],
  ['Is this an emergency?', 'No. Nobody has shown an ECDSA break. Moving to a fresh address is cheap insurance, and a calm migration beats a rushed one.'],
  ['Can I keep my seed phrase?', 'Yes. A new account index from the same seed is a new key pair. What matters is that the new address never signs.'],
  ['Do logins and permits count?', 'Yes. Sign-in messages, Permit/Permit2 approvals, gasless swaps and NFT listings are signatures too. A bunker signs nothing.'],
  ['Why is Solana always exposed?', 'A Solana address is the ed25519 public key itself. There is no hash in front of it to hide behind.'],
  ['How is the vault different?', 'It never trusts ECDSA. Withdrawals are approved by hash-based one-time signatures, and every key is burned after one use.'],
];

function Faq() {
  return (
    <section className="sec faq">
      <h2 className="display sec-h">Questions</h2>
      <div className="qa">
        {QA.map(([q, a]) => (
          <div key={q} className="qa-item">
            <h4>{q}</h4>
            <p>{a}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
