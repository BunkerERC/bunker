import { getAddress, isAddress, type Hex } from 'viem';
import { LAUNCHPAD_ADDRESS, LAUNCHPAD_BLOCK, VAULT_ADDRESS } from '../config';

// dev-only overrides for fork tests: ?launchpad=0x..&lpblock=N&vault=0x..
const q = () => new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const devAddr = (name: string): Hex | null => {
  if (!import.meta.env.DEV) return null;
  const v = q().get(name);
  return v && isAddress(v) ? getAddress(v) : null;
};

export const LAUNCHPAD: Hex | null = devAddr('launchpad') ?? LAUNCHPAD_ADDRESS;
export const DEPLOY_BLOCK: bigint = import.meta.env.DEV && q().get('lpblock') ? BigInt(q().get('lpblock')!) : LAUNCHPAD_BLOCK;
export const VAULT: Hex | null = devAddr('vault') ?? VAULT_ADDRESS;
export const CHAIN_ID = 1;
export const EXPLORER = 'https://etherscan.io';

export const POOL_MANAGER: Hex = '0x000000000004444c5dc75cB358380D2e3dE08A90';
export const STATE_VIEW: Hex = '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227';
export const V4_QUOTER: Hex = '0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203';
export const ETH_USD_FEED: Hex = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
export const DEAD: Hex = '0x000000000000000000000000000000000000dEaD';

/** Pool shape shared by every coin (mirrors BunkerLaunchpad constants). */
export const SUPPLY = 1_000_000_000n * 10n ** 18n;
export const FEE = 10_000;
export const TICK_SPACING = 200;
export const TICK_LOWER = -887_200;
