# Security

- The contracts in `contracts/src` are deployed and verified on Ethereum mainnet (addresses in the README).
- They have not been audited by a third party. Tests: `contracts/test` (unit, fuzz, mainnet-fork) and `launch/test`.
- Neither contract has an upgrade path. BunkerVault has no owner. BunkerToken's owner can only call `launch()` (done)
  and `removeLimits()` (done) or renounce.

If you find a vulnerability, please contact [@BunkerCoinEth](https://x.com/BunkerCoinEth) by DM before disclosing it publicly.
