# BUNKER

Bunker mode for your coins. On 7 October 2026 Justin Drake [asked holders](https://x.com/drakefjustin/status/2107837081313505768)
to calmly move funds to addresses that have never signed, because a break of ECDSA may come sooner than expected. BUNKER is
the toolkit for that move, plus the $BUNKER coin.

- **Scan**: which of your addresses already revealed their public key (7 EVM chains, Bitcoin, Solana)
- **Move**: sweep a wallet into a fresh address that has never signed
- **Vault**: hold ETH and tokens behind hash-based one-time signatures (Winternitz over keccak256); no ECDSA key can move them

Site: **https://bunkereth.xyz** · Docs: **https://bunkereth.xyz/#docs** · X: **[@BunkerCoinEth](https://x.com/BunkerCoinEth)**

## Contracts (Ethereum mainnet, verified on Etherscan and Sourcify)

| | address |
|---|---|
| $BUNKER | [`0xBDC4cE7c4718d20498e7D549751FF336690eb6D7`](https://etherscan.io/address/0xBDC4cE7c4718d20498e7D549751FF336690eb6D7#code) |
| BunkerVault | [`0x39C71b635409b1f98dc632e08d3B29515ddb2727`](https://etherscan.io/address/0x39C71b635409b1f98dc632e08d3B29515ddb2727#code) |
| Uniswap v4 pool id | `0x04d2cd739c30250554ceb5dad968b34e98e5932d3463e87f934c4d3a9484312b` |
| LP position | [#444506](https://etherscan.io/nft/0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e/444506), owned by the token contract |

`0x25B79CFdEF953D0a9Ee746b79B9f2A2F0bf18382` is an identical vault deployed by accident during launch; it is not used.

### $BUNKER
Fixed 1,000,000,000 supply, no mint, no transfer tax. The token minted its supply to itself and `launch()` created the
ETH pool on Uniswap v4 (1% tier) with the whole supply as one single-sided position **owned by the token contract**.
No function removes liquidity or moves the position; `collectFees()` only claims trading fees. A 2% max wallet ran at
launch and was switched off for good (`removeLimits()`, block 26,144,084). No `permit()`: an off-chain signature would
reveal the signer's public key.

### BunkerVault
Accounts are controlled by Winternitz one-time signatures (w = 16, 67 keccak256 chains, chain step
`keccak256(x ‖ uint8(chain) ‖ uint8(step))`). Every `execute` checks a signature by the account's current key over
`(chainid, vault, id, nonce, relayer, fee, nextKey, transfers)`, burns that key forever and rotates to `nextKey`.
Anyone can submit a signed withdrawal; recipients and amounts are fixed by the signature. Each payout gets a fixed gas
budget, so a low-gas front-run reverts instead of starving a payout. No owner, no upgrade, no fee. Full spec in the
[docs](https://bunkereth.xyz/#docs).

## Layout

```
contracts/   Foundry: BunkerToken.sol, BunkerVault.sol and their tests
site/        Vite + React + viem front end (scan, move, vault, docs)
             site/src/lib/wots.js is the browser signer used by the vault page
launch/      bunker-launch.mjs (deploy / launch / collect / status) and end-to-end tests
```

## Running the tests

```sh
npm install && (cd site && npm install)
cd contracts && forge install foundry-rs/forge-std --no-git && forge test           # vault + mock-token unit and fuzz tests
forge test --match-contract BunkerTokenFork --fork-url <mainnet rpc>             # token launch, LP lock, max wallet on real Uniswap v4
cd .. && node launch/test/wots-e2e.mjs                                           # browser signer vs the contract on a local anvil
node launch/test/site-e2e.mjs                                                    # whole site in headless Chromium on a mainnet fork
```

The fork tests need [Foundry](https://getfoundry.sh) (`anvil`) and a mainnet RPC; `site-e2e.mjs` also needs
`npx playwright install chromium`.

## Security

The contracts have **not** had an external audit. They are covered by unit and fuzz tests and by full mainnet-fork
rehearsals. Use the vault with amounts you can afford to lose. Losing a bunker phrase loses the funds behind it; there is
no admin who can recover anything. See [SECURITY.md](SECURITY.md).

Not financial advice.

## License

MIT
