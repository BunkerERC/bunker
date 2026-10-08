import { erc20Abi, getAddress, isAddress, parseAbi } from 'viem';
import { CHAINS, chainById, client, MULTICALL3, type PriceKey, type TokenInfo } from '../chains';
import type { Prices } from '../prices';
import { toNum } from './format';

export interface Asset {
  key: string;
  kind: 'native' | 'erc20' | 'erc721';
  chainId: number;
  token?: `0x${string}`;
  symbol: string;
  name?: string;
  decimals: number;
  raw: bigint;
  amount: number;
  priceKey?: PriceKey;
  /** USD/unit from the indexer (Blockscout exchange_rate) */
  rate?: number;
  logo?: string;
  /** curated token, custom-added token, or indexer-priced with good reputation */
  known: boolean;
  tokenId?: bigint;
  source: 'rpc' | 'indexer' | 'custom';
}

export function assetPrice(a: Asset, prices: Prices): number | undefined {
  if (a.kind === 'erc721') return undefined;
  if (a.priceKey) return prices[a.priceKey];
  return a.rate;
}
export function assetUsd(a: Asset, prices: Prices): number | undefined {
  const p = assetPrice(a, prices);
  return p === undefined ? undefined : p * a.amount;
}
/** Sum of priced assets; unpriced ones are skipped (never guessed). */
export function sumUsd(assets: Asset[], prices: Prices): number {
  let s = 0;
  for (const a of assets) s += assetUsd(a, prices) ?? 0;
  return s;
}

const MC_ABI = parseAbi(['function getEthBalance(address) view returns (uint256)']);

/* ---------- custom tokens (per chain, per browser) ---------- */

const CT_KEY = (id: number) => `bunker.tokens.${id}`;
export function customTokens(chainId: number): TokenInfo[] {
  try {
    const raw = localStorage.getItem(CT_KEY(chainId));
    const arr = raw ? (JSON.parse(raw) as TokenInfo[]) : [];
    return arr.filter((t) => isAddress(t.address) && Number.isInteger(t.decimals));
  } catch {
    return [];
  }
}
export async function addCustomToken(chainId: number, addr: string): Promise<TokenInfo> {
  if (!isAddress(addr, { strict: false })) throw new Error('Not a token address.');
  const address = getAddress(addr);
  const c = chainById(chainId);
  if (c.tokens.some((t) => t.address.toLowerCase() === address.toLowerCase())) throw new Error('Already in the list.');
  const pc = client(chainId);
  const [sym, dec] = await pc.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: [
      { address, abi: erc20Abi, functionName: 'symbol' },
      { address, abi: erc20Abi, functionName: 'decimals' },
    ],
  });
  if (dec.status !== 'success') throw new Error(`No ERC-20 at that address on ${c.name}.`);
  const tk: TokenInfo = {
    address,
    symbol: sym.status === 'success' ? String(sym.result).slice(0, 16) : 'TOKEN',
    decimals: Number(dec.result),
  };
  const list = customTokens(chainId).filter((t) => t.address !== address);
  list.push(tk);
  try {
    localStorage.setItem(CT_KEY(chainId), JSON.stringify(list));
  } catch {
    /* session only */
  }
  return tk;
}

/* ---------- EVM: nonce + code + curated balances (one round trip per chain) ---------- */

export interface EvmRead {
  nonce: number;
  code: `0x${string}`;
  assets: Asset[];
}

export async function readEvmChain(address: `0x${string}`, chainId: number): Promise<EvmRead> {
  const c = chainById(chainId);
  const pc = client(chainId);
  const custom = customTokens(chainId);
  const tokens: (TokenInfo & { custom?: boolean })[] = [...c.tokens, ...custom.map((t) => ({ ...t, custom: true }))];
  const [nonce, code, mc] = await Promise.all([
    pc.getTransactionCount({ address, blockTag: 'pending' }),
    pc.getCode({ address }).then((x) => x ?? '0x'),
    pc.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: [
        { address: MULTICALL3, abi: MC_ABI, functionName: 'getEthBalance', args: [address] },
        ...tokens.map((t) => ({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }) as const),
      ] as unknown as { address: `0x${string}`; abi: typeof erc20Abi; functionName: 'balanceOf'; args: [`0x${string}`] }[],
    }),
  ]);
  const assets: Asset[] = [];
  const nat = mc[0];
  if (nat.status !== 'success') throw new Error('balance read failed');
  const natRaw = nat.result as bigint;
  assets.push({
    key: `${chainId}:native`,
    kind: 'native',
    chainId,
    symbol: c.nativeSymbol,
    decimals: 18,
    raw: natRaw,
    amount: toNum(natRaw, 18),
    priceKey: c.nativePrice,
    logo: c.logo,
    known: true,
    source: 'rpc',
  });
  tokens.forEach((t, i) => {
    const r = mc[i + 1];
    if (r.status !== 'success') return;
    const raw = r.result as bigint;
    if (raw === 0n) return;
    assets.push({
      key: `${chainId}:${t.address.toLowerCase()}`,
      kind: 'erc20',
      chainId,
      token: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      raw,
      amount: toNum(raw, t.decimals),
      priceKey: t.price,
      logo: t.logo,
      known: true,
      source: t.custom ? 'custom' : 'rpc',
    });
  });
  return { nonce, code: code as `0x${string}`, assets };
}

/* ---------- Blockscout indexer top-up (Ethereum / Optimism only) ---------- */

interface BsToken {
  address_hash: string;
  decimals: string | null;
  exchange_rate: string | null;
  icon_url: string | null;
  name: string | null;
  reputation?: string | null;
  symbol: string | null;
  type: string;
}

async function bsFetch<T>(url: string, ms: number): Promise<T | null> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`indexer ${r.status}`);
  return (await r.json()) as T;
}

const SAFE_ICON = /^https:\/\/(assets|coin-images)\.coingecko\.com\//;

/** ERC-20s the curated list doesn't cover. Sorted by fiat value by Blockscout; first page only (50). */
export async function readIndexerTokens(address: string, chainId: number): Promise<Asset[]> {
  const c = chainById(chainId);
  if (!c.blockscout) return [];
  const j = await bsFetch<{ items: { token: BsToken; value: string }[] }>(
    `${c.blockscout}/api/v2/addresses/${address}/tokens?type=ERC-20`,
    30_000,
  );
  if (!j) return [];
  const curated = new Set([...c.tokens, ...customTokens(chainId)].map((t) => t.address.toLowerCase()));
  const out: Asset[] = [];
  for (const it of j.items ?? []) {
    const tk = it.token;
    if (!tk?.address_hash || curated.has(tk.address_hash.toLowerCase())) continue;
    const decimals = Number(tk.decimals ?? 0);
    let raw: bigint;
    try {
      raw = BigInt(it.value);
    } catch {
      continue;
    }
    if (raw === 0n) continue;
    const rate = tk.exchange_rate ? Number(tk.exchange_rate) : undefined;
    const good = tk.reputation === undefined || tk.reputation === null || tk.reputation === 'ok';
    out.push({
      key: `${chainId}:${tk.address_hash.toLowerCase()}`,
      kind: 'erc20',
      chainId,
      token: getAddress(tk.address_hash),
      symbol: (tk.symbol || '???').slice(0, 14),
      name: tk.name ?? undefined,
      decimals,
      raw,
      amount: toNum(raw, decimals),
      rate: good && rate && Number.isFinite(rate) ? rate : undefined,
      logo: good && tk.icon_url && SAFE_ICON.test(tk.icon_url) ? tk.icon_url : undefined,
      known: good && rate !== undefined,
      source: 'indexer',
    });
  }
  return out;
}

interface BsNft {
  id: string;
  image_url?: string | null;
  token: BsToken;
}

/** ERC-721s via Blockscout (Ethereum), first page. */
export async function readIndexerNfts(address: string, chainId: number): Promise<Asset[]> {
  const c = chainById(chainId);
  if (!c.blockscout) return [];
  const j = await bsFetch<{ items: BsNft[] }>(`${c.blockscout}/api/v2/addresses/${address}/nft?type=ERC-721`, 30_000);
  if (!j) return [];
  return (j.items ?? [])
    .filter((n) => n.token?.address_hash && n.id)
    .map((n) => ({
      key: `${chainId}:nft:${n.token.address_hash.toLowerCase()}:${n.id}`,
      kind: 'erc721' as const,
      chainId,
      token: getAddress(n.token.address_hash),
      symbol: (n.token.symbol || n.token.name || 'NFT').slice(0, 14),
      name: n.token.name ?? undefined,
      decimals: 0,
      raw: 1n,
      amount: 1,
      tokenId: BigInt(n.id),
      known: false,
      source: 'indexer' as const,
    }));
}

/* ---------- Safe owners ---------- */

const SAFE_ABI = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
]);

export async function readSafe(
  address: `0x${string}`,
  chainId: number,
): Promise<{ owners: `0x${string}`[]; threshold: number; safeNonce: number } | null> {
  const [o, t, n] = await client(chainId).multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: [
      { address, abi: SAFE_ABI, functionName: 'getOwners' },
      { address, abi: SAFE_ABI, functionName: 'getThreshold' },
      { address, abi: SAFE_ABI, functionName: 'nonce' },
    ],
  });
  if (o.status !== 'success' || t.status !== 'success') return null;
  const owners = (o.result as readonly `0x${string}`[]).slice(0, 20);
  if (!owners.length) return null;
  return { owners: [...owners], threshold: Number(t.result), safeNonce: n.status === 'success' ? Number(n.result) : 0 };
}

/** Quick nonce/code sweep of an address over every chain (used for owners and destinations). */
export async function readNonceCode(
  address: `0x${string}`,
  chainId: number,
): Promise<{ nonce: number; code: `0x${string}` }> {
  const pc = client(chainId);
  const [nonce, code] = await Promise.all([
    pc.getTransactionCount({ address, blockTag: 'pending' }),
    pc.getCode({ address }).then((x) => (x ?? '0x') as `0x${string}`),
  ]);
  return { nonce, code };
}

export const EVM_CHAIN_IDS = CHAINS.map((c) => c.id);

/* ---------- Bitcoin (mempool.space) ---------- */

export interface BtcRead {
  sats: bigint;
  spentTxo: number;
  mempoolSpentTxo: number;
  txCount: number;
}

export async function readBtc(address: string): Promise<BtcRead> {
  const r = await fetch(`https://mempool.space/api/address/${address}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`mempool.space ${r.status}`);
  const j = (await r.json()) as {
    chain_stats: { funded_txo_sum: number; spent_txo_sum: number; spent_txo_count: number; tx_count: number };
    mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; spent_txo_count: number; tx_count: number };
  };
  const cs = j.chain_stats;
  const ms = j.mempool_stats;
  const sats = BigInt(cs.funded_txo_sum - cs.spent_txo_sum + ms.funded_txo_sum - ms.spent_txo_sum);
  return { sats, spentTxo: cs.spent_txo_count, mempoolSpentTxo: ms.spent_txo_count, txCount: cs.tx_count + ms.tx_count };
}

/* ---------- Solana (publicnode, CORS verified) ---------- */

export const SOL_RPC = 'https://solana-rpc.publicnode.com';

export interface SolRead {
  lamports: bigint;
  tokens: { mint: string; symbol: string; amount: number; logo?: string; known: boolean }[];
}

async function solRpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(SOL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result as T;
}

// SPL token balances need an indexed (paid) RPC on every free endpoint tested 2026-10-08, so only SOL is read.
// The verdict does not depend on them: a Solana address is its public key.
export async function readSol(address: string): Promise<SolRead> {
  const bal = await solRpc<{ value: number }>('getBalance', [address]);
  return { lamports: BigInt(bal.value), tokens: [] };
}
