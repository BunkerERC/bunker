import { useEffect, useState } from 'react';
import { DRAKE_TWEET, GITHUB_URL, TOKEN_ADDRESS, TRIPWIRE_ADDRESS, VAULT_ADDRESS, X_HANDLE, X_URL } from '../config';

const SECTIONS: [string, string][] = [
  ['overview', 'Overview'],
  ['exposure', 'How keys get exposed'],
  ['scan', 'Scan'],
  ['move', 'Move'],
  ['vault', 'Vault: using it'],
  ['vault-spec', 'Vault: specification'],
  ['tripwire', 'Tripwire'],
  ['token', '$BUNKER token'],
  ['contracts', 'Contracts'],
  ['risks', 'Risks'],
];

const POOL_ID = '0x04d2cd739c30250554ceb5dad968b34e98e5932d3463e87f934c4d3a9484312b';
const es = (a: string) => `https://etherscan.io/address/${a}#code`;

export function Docs() {
  const [active, setActive] = useState('overview');
  useEffect(() => {
    const els = SECTIONS.map(([id]) => document.getElementById(`d-${id}`)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(entries => {
      const vis = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (vis) setActive(vis.target.id.slice(2));
    }, { rootMargin: '-80px 0px -60% 0px' });
    els.forEach(e => io.observe(e));
    return () => io.disconnect();
  }, []);
  const go = (id: string) => document.getElementById(`d-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="docs">
      <aside className="docs-nav" aria-label="Docs sections">
        {SECTIONS.map(([id, label]) => (
          <button key={id} className={`docs-link${active === id ? ' on' : ''}`} onClick={() => go(id)}>{label}</button>
        ))}
        <div className="docs-ext">
          <a href={X_URL} target="_blank" rel="noreferrer">{X_HANDLE} ↗</a>
          {GITHUB_URL && <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub ↗</a>}
        </div>
      </aside>

      <article className="docs-body">
        <h1 className="display sec-h">Docs</h1>
        <p className="sec-p">Everything BUNKER does, how it does it, and what it does not protect against.</p>

        <section id="d-overview">
          <h2>Overview</h2>
          <p>
            On October 7, 2026, Ethereum researcher Justin Drake{' '}
            <a href={DRAKE_TWEET} target="_blank" rel="noreferrer">called on holders</a> to calmly begin "bunker mode":
            move funds to addresses that have never signed anything, because a break of ECDSA (the signature scheme
            behind Ethereum and Bitcoin keys) may come sooner than expected. BUNKER is a set of tools for that move,
            plus the $BUNKER coin.
          </p>
          <ul>
            <li><b>Scan</b> tells you which of your addresses have already revealed their public key, on 7 EVM chains, Bitcoin and Solana.</li>
            <li><b>Move</b> sweeps a wallet into a fresh address that has never signed.</li>
            <li><b>Vault</b> holds ETH and tokens behind hash-based one-time signatures, so no ECDSA key can move them.</li>
          </ul>
          <p>Nothing here takes custody. Scan only reads. Move is plain transfers you sign in your own wallet. The vault has no owner or admin.</p>
        </section>

        <section id="d-exposure">
          <h2>How keys get exposed</h2>
          <p>
            An Ethereum address is the last 20 bytes of <code>keccak256(publicKey)</code>. Until the address signs
            something, only that hash is public, and getting a private key from a hash is not something ECDSA attacks
            help with. The first signature changes that: from any signature anyone can recompute the public key
            (<code>ecrecover</code>), and the network does exactly that to know who sent a transaction.
          </p>
          <ul>
            <li><b>Transactions</b>: any address with a nonce above 0, on any EVM chain, has a public key on-chain. The same key controls the address on every EVM chain.</li>
            <li><b>Off-chain signatures</b> also reveal it to whoever receives them: Permit and Permit2 approvals, gasless swaps (CoW, UniswapX, 1inch Fusion), NFT listings, Sign-In-With-Ethereum. These cannot be detected from the chain.</li>
            <li><b>EIP-7702</b>: a delegated EOA signed an authorization, so it is exposed.</li>
            <li><b>Bitcoin</b>: Taproot (bc1p…) outputs contain the public key itself. Legacy and SegWit addresses (1…, 3…, bc1q…) reveal it on their first spend, so whatever stays on a reused address is exposed.</li>
            <li><b>Solana</b>: the address is the ed25519 public key. There is no hash in front of it.</li>
          </ul>
          <p>
            An exposed key is not a problem today: nobody has shown a way to get a private key from a public key on
            secp256k1. Bunker mode is insurance against that changing, through better mathematics or a quantum computer.
          </p>
        </section>

        <section id="d-scan">
          <h2>Scan</h2>
          <p>
            Paste one or more addresses (up to 25, any mix of EVM, Bitcoin and Solana). For EVM addresses the scan reads
            the nonce and code on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Robinhood Chain, plus
            balances of native coins and major tokens. Safe multisigs are recognised and their owners scanned too.
            Bitcoin data comes from mempool.space; prices from Chainlink feeds on Ethereum.
          </p>
          <p>
            Results are <b>exposed</b> (a signature exists on-chain), <b>hidden</b> (nonce 0 everywhere and no code) or
            <b>check</b> (an RPC did not answer). "Hidden" only covers what the chain shows: an address that signed an
            off-chain message is exposed to whoever got that message. Scans are shareable with the link button.
          </p>
          <p>The <b>Board</b> on the home page runs the same check on the 20 largest ETH holders that are ordinary keys (labels from Blockscout).</p>
        </section>

        <section id="d-move">
          <h2>Move</h2>
          <ol>
            <li>Connect the wallet you want to empty.</li>
            <li>Create a new account in the same wallet (MetaMask: <i>Add account</i>; Rabby: <i>Create new address</i>; hardware: next account). Copy its address and never sign anything with it.</li>
            <li>Paste it as the destination. BUNKER refuses it unless it has nonce 0 and no code on all 7 chains.</li>
            <li>Per chain, tick the assets and press <i>Move to bunker</i>. Tokens go first, the native coin last.</li>
          </ol>
          <p>
            If your wallet supports EIP-5792 atomic batches, a chain moves in one confirmation; otherwise one transaction
            per asset. The native coin is sent as balance minus a gas reserve (with OP-stack L1 fees counted), so a few
            cents of dust stay behind. Unknown tokens are unticked by default; any token can be added by address.
          </p>
          <p>
            Move only handles balances in the wallet. LP positions, staked or lent funds must be withdrawn first. After
            moving: if you ever sign with the bunker address, its key is exposed too; move the rest to the next fresh
            address.
          </p>
        </section>

        <section id="d-vault">
          <h2>Vault: using it</h2>
          <ol>
            <li><b>Create a bunker</b>: the page generates 24 words in your browser. This is not your wallet's seed phrase. Write it on paper; it is the only thing that can withdraw.</li>
            <li><b>Deposit</b> ETH or ERC-20 tokens from any connected wallet. From that point the depositing wallet has no control over the funds.</li>
            <li><b>Withdraw</b>: open the bunker with the phrase, pick assets, amounts and a destination. Your browser signs with the current one-time key; the connected wallet only submits the transaction and pays gas. The key is burned and the bunker moves to the next key.</li>
          </ol>
          <ul>
            <li>The phrase is kept in memory only. Reloading the page locks the bunker; its public ID is remembered so its balance still shows.</li>
            <li><b>One key, one message.</b> If a signed withdrawal does not confirm, re-broadcast the same signature (the page keeps it). Never sign a different withdrawal with the same key from another device: two signatures from one Winternitz key can let others forge a third.</li>
            <li>Rebasing tokens (stETH) are not supported; use the wrapped version (wstETH). Fee-on-transfer tokens are credited with what actually arrives.</li>
            <li>If a recipient refuses a payment (for example a contract that rejects ETH), the amount is held as <i>claimable</i> for that recipient. Anyone can push it to them later with <code>claim(to, token)</code>.</li>
          </ul>
        </section>

        <section id="d-vault-spec">
          <h2>Vault: specification</h2>
          <p>BunkerVault is a single contract with no owner, no upgrade path and no fee. Accounts are controlled by Winternitz one-time signatures (WOTS) over keccak256.</p>
          <table className="tbl docs-tbl">
            <tbody>
              <tr><td>Parameters</td><td>w = 16; the 32-byte digest gives 64 base-16 digits, plus 3 checksum digits of <code>Σ(15 − digit)</code>: 67 hash chains</td></tr>
              <tr><td>Chain step</td><td><code>x' = keccak256(x ‖ uint8(chain) ‖ uint8(step))</code>; the public end of a chain is step 15</td></tr>
              <tr><td>Signature</td><td>67 × 32 bytes; element <i>i</i> is the secret advanced <code>digit_i</code> steps</td></tr>
              <tr><td>Public key</td><td><code>keccak256(end_0 ‖ … ‖ end_66)</code>; an account ID is the key hash of key index 0</td></tr>
              <tr><td>Signed message</td><td><code>keccak256(abi.encode(TAG, chainid, vault, id, nonce, relayer, fee, nextKey, keccak256(abi.encode(transfers))))</code>, TAG = <code>keccak256("BunkerVault.execute.v1")</code></td></tr>
              <tr><td>Key derivation (client)</td><td><code>master = keccak256("BUNKER/WOTS/v1" ‖ entropy)</code> of the 24-word phrase; <code>secret(k, i) = keccak256(master ‖ uint32(k) ‖ uint8(i))</code>, k = account nonce</td></tr>
              <tr><td>Rotation</td><td>every <code>execute</code> marks the current key spent forever and switches to the signed <code>nextKey</code>; a spent key can never be used again or opened as an account</td></tr>
              <tr><td>Submitter</td><td>anyone; <code>relayer</code> (if set) restricts who may submit, <code>fee</code> pays ETH to the submitter. Recipients and amounts are fixed by the signature</td></tr>
              <tr><td>Sends</td><td>each payout gets a fixed gas budget (ETH 100k, tokens 250k) and the call reverts if the submitter gave less, so a payout can not be starved into <i>claimable</i></td></tr>
              <tr><td>Gas</td><td>about 200k to 280k per withdrawal, signature check included</td></tr>
            </tbody>
          </table>
          <p>
            Why the checksum matters: after one signature is public, an attacker can advance any chain further, which
            only raises digits. A different message always lowers at least one digit (message or checksum), which
            would need a keccak256 preimage.
          </p>
          <p>
            Functions: <code>depositETH(id)</code>, <code>deposit(id, token, amount)</code>,{' '}
            <code>execute(id, transfers, relayer, fee, nextKey, sig)</code>, <code>claim(to, token)</code>; views{' '}
            <code>accounts(id)</code>, <code>balanceOf(id, token)</code>, <code>digest(…)</code>,{' '}
            <code>wotsPublicKey(digest, sig)</code>, <code>spentKey(key)</code>, <code>claimable(to, token)</code>.
          </p>
        </section>

        <section id="d-tripwire">
          <h2>Tripwire</h2>
          <p>
            An add-on to the vault: no token, no fee. <code>BunkerTripwire</code> is a public bounty for breaking ECDSA and an
            escape hatch that fires the moment anyone does.
          </p>
          <table className="tbl docs-tbl">
            <tbody>
              <tr><td>Canary</td><td>an Ethereum address whose secp256k1 public key is derived from a hash: x = keccak256("BUNKER/TRIPWIRE/CANARY/v1" ‖ uint256 counter) for the first counter on the curve, with the even y. The constructor computes it on-chain, so anyone can check that nobody chose it. Nobody holds its private key</td></tr>
              <tr><td>Bounty</td><td>ETH sent to the contract with <code>fund()</code>. <code>claim(to, v, r, s)</code> pays all of it to <code>to</code> against a canary signature of <code>keccak256(abi.encode(tag, chainid, contract, to))</code>. The contract hashes that message itself: with a freely chosen hash, a valid-looking signature for any public key can be built without its key, so a raw hash is never accepted. The signature names <code>to</code>, so copying it from the mempool pays nobody else</td></tr>
              <tr><td>Trip</td><td>once and forever, the first time the canary signs: a valid claim, or code at the canary address (an EIP-7702 delegation, which also needs its signature; <code>trip()</code> records it)</td></tr>
              <tr><td>Arming</td><td><code>register(bunker, tokens)</code> names a bunker that already exists in the vault and up to 32 tokens; you approve each token to the tripwire. <code>leave()</code> opts out</td></tr>
              <tr><td>Escape</td><td>after the trip, anyone may call <code>escape(owner)</code> or <code>escapeMany(owners)</code>. Each approved balance (the lower of balance and allowance) moves into the owner's bunker through <code>vault.deposit</code>. A token that fails is skipped and reported, never blocks the others. Before the trip nothing can move, and tokens can only ever go to the owner's registered bunker</td></tr>
              <tr><td>Keeper</td><td>our bot watches the canary every few seconds, trips the wire and sweeps every armed wallet in batches. Anyone can do the same from the Tripwire page</td></tr>
              <tr><td>Limits</td><td>ETH itself can not be pulled with an approval (wrap it to WETH). A serious attacker may skip the canary and go after big wallets first: this is an alarm and a bounty, not a guarantee. No owner, no admin, no upgrade, no fee. Not externally audited</td></tr>
            </tbody>
          </table>
        </section>

        <section id="d-token">
          <h2>$BUNKER token</h2>
          <table className="tbl docs-tbl">
            <tbody>
              <tr><td>Supply</td><td>1,000,000,000, fixed. No mint function</td></tr>
              <tr><td>Tax</td><td>none on transfers. The Uniswap pool charges its normal 1% swap fee</td></tr>
              <tr><td>Liquidity</td><td>the token minted all supply to itself; <code>launch()</code> created the ETH pool on Uniswap v4 (1% tier, tick spacing 200, opening market cap about $5,100) and added the whole supply as one single-sided position owned by the token contract. There is no function that removes liquidity or moves the position: it is locked forever</td></tr>
              <tr><td>LP fees</td><td><code>collectFees()</code> (callable by anyone) claims the position's fees to the fee recipient and leaves liquidity untouched</td></tr>
              <tr><td>Max wallet</td><td>2% while live; switched off for good with <code>removeLimits()</code> at block 26,144,084</td></tr>
              <tr><td>Owner powers</td><td>only <code>launch()</code> (done, once), <code>removeLimits()</code> (done, one-way) and <code>renounceOwnership()</code>. No pause, blacklist or balance control</td></tr>
              <tr><td>permit()</td><td>left out on purpose: an off-chain signature would reveal the signer's public key</td></tr>
            </tbody>
          </table>
        </section>

        <section id="d-contracts">
          <h2>Contracts</h2>
          <p>All verified on Etherscan and Sourcify (exact match). Source and tests are on GitHub{GITHUB_URL ? '' : ' (link coming)'}.</p>
          <table className="tbl docs-tbl mono-cells">
            <tbody>
              <tr><td>$BUNKER</td><td>{TOKEN_ADDRESS && <a href={es(TOKEN_ADDRESS)} target="_blank" rel="noreferrer">{TOKEN_ADDRESS}</a>}</td></tr>
              <tr><td>BunkerVault</td><td>{VAULT_ADDRESS && <a href={es(VAULT_ADDRESS)} target="_blank" rel="noreferrer">{VAULT_ADDRESS}</a>}</td></tr>
              {TRIPWIRE_ADDRESS && <tr><td>BunkerTripwire</td><td><a href={es(TRIPWIRE_ADDRESS)} target="_blank" rel="noreferrer">{TRIPWIRE_ADDRESS}</a></td></tr>}
              <tr><td>Pool ID (v4)</td><td><span className="break">{POOL_ID}</span></td></tr>
              <tr><td>LP position</td><td><a href="https://etherscan.io/nft/0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e/444506" target="_blank" rel="noreferrer">#444506</a>, owned by the token contract</td></tr>
              <tr><td>Unused copy</td><td><span className="break">0x25B79CFdEF953D0a9Ee746b79B9f2A2F0bf18382</span>: an identical vault deployed by accident during launch. It is not used by the site</td></tr>
            </tbody>
          </table>
        </section>

        <section id="d-risks">
          <h2>Risks</h2>
          <ul>
            <li><b>No external audit.</b> The contracts are covered by unit tests, fuzz tests and full mainnet-fork rehearsals, but nobody outside has audited them. Use the vault with amounts you can afford to lose.</li>
            <li><b>Losing the bunker phrase loses the funds.</b> Nobody can recover it; there is no admin.</li>
            <li><b>The threat is a forecast.</b> No public break of ECDSA exists. Bunker mode is a precaution, not a response to an attack.</li>
            <li><b>Public RPCs and indexers</b> can be slow or wrong; Scan shows "check" when a source does not answer.</li>
            <li>$BUNKER is a memecoin. Nothing here is financial advice.</li>
          </ul>
        </section>
      </article>
    </div>
  );
}
