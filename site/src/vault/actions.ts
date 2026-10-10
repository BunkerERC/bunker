import { zeroAddress, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import * as wots from '../lib/wots.js';
import * as bs from '../lib/bunkerswap.js';
import { vaultAbi } from './abi';
import { client } from '../chains';
import type { useWallet } from '../wallet';
import { isSwap, type Pending } from './pending';
import { relaySend } from './relay';

export type Wallet = ReturnType<typeof useWallet>;
const eth = () => client(1);

export async function onEthereum(wallet: Wallet) {
  if (!wallet.address) await wallet.connect();
  if (wallet.chainId !== 1) await wallet.switchChain(1);
}

/** The bunker's current key, checked against the phrase, and the next one it will rotate to. */
export async function readKey(vault: Hex, id: Hex, master: Uint8Array) {
  const c = eth();
  const [key, nonceBig] = await c.readContract({ address: vault, abi: vaultAbi, functionName: 'accounts', args: [id] });
  const nonce = Number(nonceBig);
  if (key !== wots.keyHash(master, nonce)) throw new Error('On-chain key does not match this phrase. Refresh and retry.');
  const nextKey = wots.keyHash(master, nonce + 1);
  if (await c.readContract({ address: vault, abi: vaultAbi, functionName: 'spentKey', args: [nextKey] }))
    throw new Error('Next key is already burned. This should never happen; stop and ask for help.');
  return { key, nonce, nextKey };
}

/** The transaction that carries a signed message: the same one whoever submits it. */
export function txOf(vault: Hex, swap: Hex | null, id: Hex, p: Pending) {
  if (isSwap(p)) {
    if (!swap) throw new Error('Swaps are not available here.');
    return { address: swap, abi: bs.swapAbi, functionName: 'run', args: [bs.orderArgs(p.order), p.nextKey, p.sig, p.route.commands, p.route.inputs] };
  }
  return {
    address: vault, abi: vaultAbi, functionName: 'execute',
    args: [id, p.transfers.map(t => ({ token: t.token, to: t.to, amount: BigInt(t.amount) })), zeroAddress, BigInt(p.fee ?? '0'), p.nextKey, p.sig],
  };
}

/** Submits from the connected wallet (it only pays gas) and waits for the receipt. */
export async function sendWithWallet(wallet: Wallet, vault: Hex, swap: Hex | null, id: Hex, p: Pending, onHash: (h: Hex) => void): Promise<Hex> {
  await onEthereum(wallet);
  if (!wallet.walletClient || !wallet.address) throw new Error('Connect a wallet first.');
  const hash = await wallet.walletClient.writeContract({ ...txOf(vault, swap, id, p), account: wallet.address, chain: mainnet } as never);
  onHash(hash);
  const r = await eth().waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  return hash;
}

/** Hands the signed message to the relayer and waits until the vault shows the key as used. */
export async function sendWithRelayer(vault: Hex, id: Hex, p: Pending, onHash: (h: Hex) => void): Promise<Hex | undefined> {
  const body = isSwap(p)
    ? { kind: 'swap', order: p.order, nextKey: p.nextKey, sig: p.sig, commands: p.route.commands, inputs: p.route.inputs }
    : { kind: 'withdraw', id, nonce: String(p.nonce), fee: p.fee ?? '0', nextKey: p.nextKey, sig: p.sig, transfers: p.transfers };
  const res = await relaySend(body);
  if (res.hash) onHash(res.hash);
  if (!res.done && !(await waitLanded(vault, id, p.nonce)))
    throw new Error('The relayer sent it, but it has not confirmed yet. Check again in a moment.');
  return res.hash;
}

export async function keyUsed(vault: Hex, id: Hex, nonce: number) {
  const [, now] = await eth().readContract({ address: vault, abi: vaultAbi, functionName: 'accounts', args: [id] });
  return Number(now) > nonce;
}

export async function waitLanded(vault: Hex, id: Hex, nonce: number, ms = 150_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await keyUsed(vault, id, nonce).catch(() => false)) return true;
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

/** What a swap transaction did, read from its receipt: swapped, or handed back because the order had expired. */
export async function swapOutcome(hash: Hex): Promise<{ swapped: boolean; amount: bigint } | null> {
  try {
    const { parseEventLogs } = await import('viem');
    const r = await eth().getTransactionReceipt({ hash });
    const logs = parseEventLogs({ abi: bs.swapAbi, logs: r.logs }) as unknown as { eventName: string; args: { amountOut?: bigint; amount?: bigint } }[];
    const s = logs.find(l => l.eventName === 'Swapped');
    if (s) return { swapped: true, amount: s.args.amountOut ?? 0n };
    const b = logs.find(l => l.eventName === 'Returned');
    if (b) return { swapped: false, amount: b.args.amount ?? 0n };
  } catch {
    /* receipt not available yet: the balances tell the story */
  }
  return null;
}
