import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createWalletClient, custom, getAddress, numberToHex, type EIP1193Provider, type WalletClient } from 'viem';
import { CHAIN_BY_ID } from './chains';

interface Eip6963Info {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
export interface DiscoveredWallet {
  info: Eip6963Info;
  provider: EIP1193Provider;
}

export interface WalletState {
  address?: `0x${string}`;
  chainId?: number;
  connect(): Promise<void>;
  disconnect(): void;
  switchChain(id: number): Promise<void>;
  walletClient?: WalletClient;
  provider?: EIP1193Provider;
  /** extra UI state */
  walletName?: string;
  connecting: boolean;
  error?: string;
}

const Ctx = createContext<WalletState | null>(null);
const LS_KEY = 'bunker.wallet';

const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage blocked: fine */
  }
};

function errMsg(e: unknown): string {
  const any = e as { shortMessage?: string; message?: string; code?: number };
  if (any?.code === 4001) return 'Request rejected in wallet.';
  if (any?.code === -32002) return 'Wallet already has a pending request — open it.';
  return any?.shortMessage || any?.message || String(e);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [provider, setProvider] = useState<EIP1193Provider>();
  const [walletName, setWalletName] = useState<string>();
  const [address, setAddress] = useState<`0x${string}`>();
  const [chainId, setChainId] = useState<number>();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string>();
  const [picker, setPicker] = useState(false);
  const pickResolve = useRef<((w: DiscoveredWallet | null) => void) | null>(null);
  const walletsRef = useRef<DiscoveredWallet[]>([]);

  // EIP-6963 discovery
  useEffect(() => {
    const onAnnounce = (ev: Event) => {
      const d = (ev as CustomEvent<DiscoveredWallet>).detail;
      if (!d?.info?.uuid || !d.provider) return;
      if (walletsRef.current.some((w) => w.info.uuid === d.info.uuid || w.info.rdns === d.info.rdns)) return;
      walletsRef.current = [...walletsRef.current, d];
      setWallets(walletsRef.current);
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
  }, []);

  const attach = useCallback(async (p: EIP1193Provider, name: string, rdns: string | null, accounts: string[]) => {
    if (!accounts.length) return false;
    const cid = await p.request({ method: 'eth_chainId' });
    setProvider(p);
    setWalletName(name);
    setAddress(getAddress(accounts[0]));
    setChainId(Number(cid));
    lsSet(LS_KEY, rdns ?? 'injected');
    return true;
  }, []);

  // silent reconnect to the last wallet (eth_accounts never pops a prompt)
  const triedAuto = useRef(false);
  useEffect(() => {
    if (triedAuto.current) return;
    const last = lsGet(LS_KEY);
    if (!last) return;
    const t = setTimeout(async () => {
      triedAuto.current = true;
      const w = walletsRef.current.find((x) => x.info.rdns === last);
      const p = w?.provider ?? (last === 'injected' ? (window as { ethereum?: EIP1193Provider }).ethereum : undefined);
      if (!p) return;
      try {
        const accts = (await p.request({ method: 'eth_accounts' })) as string[];
        await attach(p, w?.info.name ?? 'Browser wallet', w?.info.rdns ?? 'injected', accts);
      } catch {
        /* ignore */
      }
    }, 120);
    return () => clearTimeout(t);
  }, [wallets, attach]);

  // provider events
  useEffect(() => {
    if (!provider?.on) return;
    const onAccounts = (a: string[]) => {
      if (!a?.length) {
        setAddress(undefined);
        lsSet(LS_KEY, null);
      } else setAddress(getAddress(a[0]));
    };
    const onChain = (c: string) => setChainId(Number(c));
    provider.on('accountsChanged', onAccounts as never);
    provider.on('chainChanged', onChain as never);
    return () => {
      provider.removeListener?.('accountsChanged', onAccounts as never);
      provider.removeListener?.('chainChanged', onChain as never);
    };
  }, [provider]);

  const connectTo = useCallback(
    async (p: EIP1193Provider, name: string, rdns: string | null) => {
      setConnecting(true);
      setError(undefined);
      try {
        const accts = (await p.request({ method: 'eth_requestAccounts' })) as string[];
        if (!(await attach(p, name, rdns, accts))) setError('Wallet returned no account.');
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setConnecting(false);
      }
    },
    [attach],
  );

  const connect = useCallback(async () => {
    setError(undefined);
    const list = walletsRef.current;
    if (list.length > 1) {
      const chosen = await new Promise<DiscoveredWallet | null>((res) => {
        pickResolve.current = res;
        setPicker(true);
      });
      if (chosen) await connectTo(chosen.provider, chosen.info.name, chosen.info.rdns);
      return;
    }
    if (list.length === 1) return connectTo(list[0].provider, list[0].info.name, list[0].info.rdns);
    const injected = (window as { ethereum?: EIP1193Provider }).ethereum;
    if (injected) return connectTo(injected, 'Browser wallet', null);
    setError('No wallet found. Install MetaMask or Rabby, then reload.');
  }, [connectTo]);

  const pick = (w: DiscoveredWallet | null) => {
    setPicker(false);
    pickResolve.current?.(w);
    pickResolve.current = null;
  };

  const disconnect = useCallback(() => {
    provider
      ?.request({ method: 'wallet_revokePermissions' as never, params: [{ eth_accounts: {} }] as never })
      .catch(() => {});
    setAddress(undefined);
    setProvider(undefined);
    setWalletName(undefined);
    lsSet(LS_KEY, null);
  }, [provider]);

  const switchChain = useCallback(
    async (id: number) => {
      if (!provider) throw new Error('Connect a wallet first.');
      const hex = numberToHex(id);
      const current = Number(await provider.request({ method: 'eth_chainId' }));
      if (current === id) {
        setChainId(id);
        return;
      }
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
      } catch (e) {
        const code = (e as { code?: number; data?: { originalError?: { code?: number } } })?.code;
        const inner = (e as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code;
        if (code !== 4902 && inner !== 4902) throw e;
        const c = CHAIN_BY_ID.get(id);
        if (!c) throw e;
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hex,
              chainName: c.name,
              nativeCurrency: c.viem.nativeCurrency,
              rpcUrls: [c.rpcs[0]],
              blockExplorerUrls: [c.explorer],
            },
          ],
        });
      }
      const after = Number(await provider.request({ method: 'eth_chainId' }));
      setChainId(after);
      if (after !== id) throw new Error(`Wallet is still on chain ${after}; switch to ${CHAIN_BY_ID.get(id)?.name ?? id} manually.`);
    },
    [provider],
  );

  const walletClient = useMemo(() => {
    if (!provider || !address) return undefined;
    const chain = chainId ? CHAIN_BY_ID.get(chainId)?.viem : undefined;
    return createWalletClient({ account: address, chain, transport: custom(provider) });
  }, [provider, address, chainId]);

  const value: WalletState = {
    address,
    chainId,
    connect,
    disconnect,
    switchChain,
    walletClient,
    provider,
    walletName,
    connecting,
    error,
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      {picker && (
        <div className="modal-back" onClick={() => pick(null)}>
          <div className="modal" role="dialog" aria-label="Choose a wallet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Choose wallet</span>
              <button className="x" onClick={() => pick(null)} aria-label="Close">
                ×
              </button>
            </div>
            {wallets.map((w) => (
              <button key={w.info.uuid} className="wallet-opt" onClick={() => pick(w)}>
                {w.info.icon ? <img src={w.info.icon} alt="" width={20} height={20} /> : <span className="tile" />}
                <span>{w.info.name}</span>
                <span className="mono dim">{w.info.rdns}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet outside WalletProvider');
  return v;
}

export { errMsg as walletErrorMessage };
