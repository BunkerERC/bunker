/** $BUNKER token on Ethereum mainnet. null until launch. */
export const TOKEN_ADDRESS: `0x${string}` | null = "0xBDC4cE7c4718d20498e7D549751FF336690eb6D7";

/** BunkerVault (hash-signature vault) on Ethereum mainnet. null until deploy. */
export const VAULT_ADDRESS: `0x${string}` | null = "0x39C71b635409b1f98dc632e08d3B29515ddb2727";

/** block the vault was deployed in (log scans start here). */
export const VAULT_BLOCK = 26144037n;

export const DRAKE_TWEET = 'https://x.com/drakefjustin/status/2107837081313505768';

/** Official X account. */
export const X_URL = 'https://x.com/BunkerCoinEth';
export const X_HANDLE = '@BunkerCoinEth';

/** Public source repo (null until published). */
export const GITHUB_URL: string | null = "https://github.com/BunkerERC/bunker";

/** BunkerTripwire (ECDSA canary + escape hatch into the vault) on Ethereum mainnet. null until deploy. */
export const TRIPWIRE_ADDRESS: `0x${string}` | null = "0x20085f519465288A5f4ed8917EB6e73429B2EE39";

/** BunkerLaunchpad (post-quantum signed coin launches, 50/50 fees) on Ethereum mainnet. null until deploy. */
export const LAUNCHPAD_ADDRESS: `0x${string}` | null = "0xe5871db88A72e4B18Fe37175C4774718aB356000";
/** block the launchpad was deployed in (log scans start here). */
export const LAUNCHPAD_BLOCK = 26154517n;
