import {
  createPublicClient,
  custom,
  fallback,
  http,
  type Chain,
  type PublicClient,
  type Transport,
} from 'viem';
import { arbitrum, base, bsc, mainnet, optimism, polygon, robinhood } from 'viem/chains';

/** What a USD price for a token is derived from. 'usd' = stablecoin pegged to $1. */
export type PriceKey = 'usd' | 'eth' | 'btc' | 'bnb' | 'pol';

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  price?: PriceKey;
  /** path under /public, only when a real logo was downloaded */
  logo?: string;
}

export interface ChainInfo {
  id: number;
  key: string;
  name: string;
  short: string;
  logo: string;
  rpcs: string[];
  explorer: string;
  nativeSymbol: string;
  nativePrice: PriceKey;
  /** Blockscout instance whose /api/v2 answers browsers (CORS, no challenge) */
  blockscout?: string;
  tokens: TokenInfo[];
  /** OP-stack: L1 data fee is charged on top of gas (GasPriceOracle 0x…0F) */
  opStack?: boolean;
  /** Arbitrum Nitro / Orbit: eth_estimateGas already includes the L1 component */
  nitro?: boolean;
  /** max concurrent requests; no JSON-RPC batching when set */
  maxConcurrent?: number;
  /** floor for maxPriorityFeePerGas in wei (some RPCs answer 0) */
  minTip?: bigint;
  viem: Chain;
}

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const OP_GAS_ORACLE = '0x420000000000000000000000000000000000000F' as const;

const t = (address: `0x${string}`, symbol: string, decimals: number, price?: PriceKey): TokenInfo => ({
  address,
  symbol,
  decimals,
  price,
});

// Every address below was checked on-chain (symbol() + decimals()) on 2026-10-08.
export const CHAINS: ChainInfo[] = [
  {
    id: 1,
    key: 'ethereum',
    name: 'Ethereum',
    short: 'ETH',
    logo: '/chains/ethereum.png',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
    explorer: 'https://etherscan.io',
    nativeSymbol: 'ETH',
    nativePrice: 'eth',
    blockscout: 'https://eth.blockscout.com',
    minTip: 50_000_000n, // 0.05 gwei
    viem: mainnet,
    tokens: [
      t('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 6, 'usd'),
      t('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 6, 'usd'),
      t('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH', 18, 'eth'),
      t('0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI', 18, 'usd'),
      t('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC', 8, 'btc'),
      t('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC', 8, 'btc'),
      t('0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', 'stETH', 18, 'eth'),
    ],
  },
  {
    id: 8453,
    key: 'base',
    name: 'Base',
    short: 'BASE',
    logo: '/chains/base.png',
    rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    explorer: 'https://basescan.org',
    nativeSymbol: 'ETH',
    nativePrice: 'eth',
    opStack: true,
    viem: base,
    tokens: [
      t('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 6, 'usd'),
      t('0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', 'USDbC', 6, 'usd'),
      t('0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 'USDT', 6, 'usd'),
      t('0x4200000000000000000000000000000000000006', 'WETH', 18, 'eth'),
      t('0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 'DAI', 18, 'usd'),
      t('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC', 8, 'btc'),
    ],
  },
  {
    id: 42161,
    key: 'arbitrum',
    name: 'Arbitrum',
    short: 'ARB',
    logo: '/chains/arbitrum.png',
    rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    explorer: 'https://arbiscan.io',
    nativeSymbol: 'ETH',
    nativePrice: 'eth',
    nitro: true,
    viem: arbitrum,
    tokens: [
      t('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC', 6, 'usd'),
      t('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 'USDC.e', 6, 'usd'),
      t('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USDT0', 6, 'usd'),
      t('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'WETH', 18, 'eth'),
      t('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI', 18, 'usd'),
      t('0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 'WBTC', 8, 'btc'),
      t('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'cbBTC', 8, 'btc'),
      t('0x912CE59144191C1204E64559FE8253a0e49E6548', 'ARB', 18),
    ],
  },
  {
    id: 10,
    key: 'optimism',
    name: 'Optimism',
    short: 'OP',
    logo: '/chains/optimism.png',
    rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
    explorer: 'https://optimistic.etherscan.io',
    nativeSymbol: 'ETH',
    nativePrice: 'eth',
    blockscout: 'https://explorer.optimism.io',
    opStack: true,
    viem: optimism,
    tokens: [
      t('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'USDC', 6, 'usd'),
      t('0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 'USDC.e', 6, 'usd'),
      t('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 'USDT', 6, 'usd'),
      t('0x4200000000000000000000000000000000000006', 'WETH', 18, 'eth'),
      t('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI', 18, 'usd'),
      t('0x68f180fcCe6836688e9084f035309E29Bf0A2095', 'WBTC', 8, 'btc'),
      t('0x4200000000000000000000000000000000000042', 'OP', 18),
    ],
  },
  {
    id: 137,
    key: 'polygon',
    name: 'Polygon',
    short: 'POL',
    logo: '/chains/polygon.png',
    rpcs: ['https://polygon.drpc.org', 'https://polygon-bor-rpc.publicnode.com'],
    explorer: 'https://polygonscan.com',
    nativeSymbol: 'POL',
    nativePrice: 'pol',
    minTip: 30_000_000_000n, // Polygon enforces a ~25-30 gwei tip floor
    viem: polygon,
    tokens: [
      t('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USDC', 6, 'usd'),
      t('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 'USDC.e', 6, 'usd'),
      t('0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'USDT0', 6, 'usd'),
      t('0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 'WETH', 18, 'eth'),
      t('0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', 'DAI', 18, 'usd'),
      t('0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', 'WBTC', 8, 'btc'),
      t('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 'WPOL', 18, 'pol'),
    ],
  },
  {
    id: 56,
    key: 'smartchain',
    name: 'BNB Chain',
    short: 'BNB',
    logo: '/chains/smartchain.png',
    rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
    explorer: 'https://bscscan.com',
    nativeSymbol: 'BNB',
    nativePrice: 'bnb',
    minTip: 50_000_000n, // 0.05 gwei validator floor
    viem: bsc,
    tokens: [
      t('0x55d398326f99059fF775485246999027B3197955', 'USDT', 18, 'usd'),
      t('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USDC', 18, 'usd'),
      t('0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', 'FDUSD', 18, 'usd'),
      t('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 'WBNB', 18, 'bnb'),
      t('0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 'ETH', 18, 'eth'),
      t('0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 'BTCB', 18, 'btc'),
      t('0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', 'DAI', 18, 'usd'),
    ],
  },
  {
    id: 4663,
    key: 'robinhood',
    name: 'Robinhood Chain',
    short: 'RH',
    logo: '/chains/robinhood.svg',
    rpcs: ['https://rpc.mainnet.chain.robinhood.com', 'https://rpc.ordofi.network'],
    explorer: 'https://robinhoodchain.blockscout.com',
    nativeSymbol: 'ETH',
    nativePrice: 'eth',
    nitro: true,
    maxConcurrent: 3,
    viem: robinhood,
    tokens: [
      t('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'USDG', 6, 'usd'),
      t('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', 'WETH', 18, 'eth'),
      t('0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4', 'cbBTC', 8, 'btc'),
    ],
  },
];

/* ---------- DEV-only fork override: ?fork1=http://127.0.0.1:8645 ---------- */

export const FORKS: Record<number, string> = {};
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const q = new URLSearchParams(window.location.search);
  for (const c of CHAINS) {
    const url = q.get(`fork${c.id}`);
    if (url && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url)) {
      FORKS[c.id] = url;
      c.rpcs = [url];
      c.blockscout = undefined; // the indexer knows mainnet, not the fork
    }
  }
}

/* Real logos only: Trust Wallet assets per chain (public/tokens/<chain>-<addr>.png),
   CoinGecko images for cbBTC/USDG, the canonical WETH/WBTC marks for bridged copies. */
const LOGO_OVERRIDE: Record<string, string> = {
  'robinhood-0x5fc5360d0400a0fd4f2af552add042d716f1d168': '/tokens/usdg.png',
  'robinhood-0x0bd7d308f8e1639fab988df18a8011f41eacad73': '/tokens/ethereum-0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.png',
  'optimism-0x68f180fcce6836688e9084f035309e29bf0a2095': '/tokens/ethereum-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.png',
};
for (const c of CHAINS) {
  for (const tk of c.tokens) {
    const id = `${c.key}-${tk.address.toLowerCase()}`;
    tk.logo = tk.symbol === 'cbBTC' ? '/tokens/cbbtc.webp' : LOGO_OVERRIDE[id] ?? `/tokens/${id}.png`;
  }
}

export const CHAIN_BY_ID = new Map(CHAINS.map((c) => [c.id, c]));
export function chainById(id: number): ChainInfo {
  const c = CHAIN_BY_ID.get(id);
  if (!c) throw new Error(`unsupported chain ${id}`);
  return c;
}

export const txUrl = (chainId: number, hash: string) => `${chainById(chainId).explorer}/tx/${hash}`;
export const addrUrl = (chainId: number, a: string) => `${chainById(chainId).explorer}/address/${a}`;

/* ---------- transports ---------- */

function semaphore(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plain single-request JSON-RPC over fetch, behind a shared semaphore.
 * For Robinhood Chain: it rate-limits around 4 concurrent requests and answers
 * JSON-RPC batches with a malformed 429, so: never batch, ≤3 in flight, back off on 429.
 */
function limitedHttp(url: string, run: ReturnType<typeof semaphore>): Transport {
  let id = 0;
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        return run(async () => {
          for (let attempt = 0; ; attempt++) {
            let res: Response;
            try {
              res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }),
                signal: AbortSignal.timeout(12_000),
              });
            } catch (e) {
              if (attempt < 2) {
                await sleep(250 * 2 ** attempt);
                continue;
              }
              throw e;
            }
            if ((res.status === 429 || res.status >= 500) && attempt < 4) {
              await sleep(300 * 2 ** attempt);
              continue;
            }
            const text = await res.text();
            let json: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
            try {
              json = JSON.parse(text);
            } catch {
              if (attempt < 4) {
                await sleep(300 * 2 ** attempt);
                continue;
              }
              throw new Error(`RPC ${res.status}: unreadable response`);
            }
            if (json.error) {
              if (json.error.code === 429 && attempt < 4) {
                await sleep(300 * 2 ** attempt);
                continue;
              }
              throw Object.assign(new Error(json.error.message), { code: json.error.code, data: json.error.data });
            }
            return json.result;
          }
        });
      },
    },
    { retryCount: 0 },
  );
}

const clients = new Map<number, PublicClient>();

/** DEV ONLY: ?fork1=http://127.0.0.1:8645 points chain 1 reads at a local anvil fork (fork tests). */
function devFork(chainId: number): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return new URLSearchParams(location.search).get(`fork${chainId}`);
  } catch {
    return null;
  }
}

/** Cached viem public client for a supported chain. */
export function client(chainId: number): PublicClient {
  const hit = clients.get(chainId);
  if (hit) return hit;
  const c = chainById(chainId);
  let transport: Transport;
  const fork = devFork(chainId);
  if (fork) {
    transport = http(fork, { timeout: 30_000 });
  } else if (c.maxConcurrent) {
    const run = semaphore(c.maxConcurrent);
    const ts = c.rpcs.map((u) => limitedHttp(u, run));
    transport = ts.length > 1 ? fallback(ts, { retryCount: 0 }) : ts[0];
  } else {
    const ts = c.rpcs.map((u) => http(u, { batch: { batchSize: 30, wait: 8 }, timeout: 12_000, retryCount: 1 }));
    transport = ts.length > 1 ? fallback(ts, { retryCount: 0 }) : ts[0];
  }
  const pc = createPublicClient({
    chain: c.viem,
    transport,
    pollingInterval: c.id === 1 ? 2_000 : 1_000,
  }) as PublicClient;
  clients.set(chainId, pc);
  return pc;
}
