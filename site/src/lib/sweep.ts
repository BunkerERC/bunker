import { encodeFunctionData, erc20Abi, erc721Abi, numberToHex, parseAbi, type EIP1193Provider, type Hex } from 'viem';
import { CHAINS, chainById, client, OP_GAS_ORACLE } from '../chains';
import { detectAddress } from './exposure';
import { readNonceCode, type Asset } from './scan';

export type StepStatus = 'queued' | 'wallet' | 'pending' | 'done' | 'failed' | 'skipped';
export interface Step {
  id: string;
  label: string;
  status: StepStatus;
  hash?: Hex;
  note?: string;
}

/* ---------- destination check ---------- */

export interface DestCheck {
  ok: boolean;
  /** blocking reason, if any */
  error?: string;
  perChain: { chainId: number; nonce?: number; code?: Hex; error?: boolean }[];
  pending: boolean;
}

export function destFormat(dest: string, source?: string): string | null {
  const d = detectAddress(dest);
  if (!dest.trim()) return 'Paste the fresh address.';
  if (d.kind !== 'evm') return d.kind === 'invalid' ? `Invalid address (${d.why}).` : 'Destination must be an EVM address (0x…).';
  if (source && d.address.toLowerCase() === source.toLowerCase()) return 'That is the source wallet. Use a NEW address.';
  return null;
}

export async function checkDestination(
  dest: `0x${string}`,
  onChain: (r: DestCheck['perChain'][number]) => void,
): Promise<void> {
  await Promise.all(
    CHAINS.map(async (c) => {
      try {
        const r = await readNonceCode(dest, c.id);
        onChain({ chainId: c.id, ...r });
      } catch {
        onChain({ chainId: c.id, error: true });
      }
    }),
  );
}

export function destVerdict(perChain: DestCheck['perChain']): DestCheck {
  const pending = perChain.length < CHAINS.length;
  const name = (id: number) => chainById(id).name;
  const coded = perChain.filter((p) => p.code && p.code !== '0x');
  if (coded.length) {
    return { ok: false, pending, perChain, error: `Has code on ${coded.map((p) => name(p.chainId)).join(', ')}. A bunker must be a plain, unused EOA.` };
  }
  const signed = perChain.filter((p) => (p.nonce ?? 0) > 0);
  if (signed.length) {
    return {
      ok: false,
      pending,
      perChain,
      error: `Already signed on ${signed.map((p) => `${name(p.chainId)} (nonce ${p.nonce})`).join(', ')}. Its key is public: not a bunker.`,
    };
  }
  const failed = perChain.filter((p) => p.error);
  if (failed.length) {
    return { ok: false, pending, perChain, error: `Couldn't verify on ${failed.map((p) => name(p.chainId)).join(', ')}. Retry.` };
  }
  return { ok: !pending, pending, perChain };
}

/* ---------- gas math ---------- */

const GPO = parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)']);

export interface Fees {
  maxFee: bigint;
  tip: bigint;
  base: bigint;
}

export async function feeParams(chainId: number): Promise<Fees> {
  const c = chainById(chainId);
  const pc = client(chainId);
  const [block, rpcTip, gasPrice] = await Promise.all([
    pc.getBlock({ blockTag: 'latest' }),
    c.nitro ? Promise.resolve(0n) : pc.estimateMaxPriorityFeePerGas().catch(() => 0n),
    pc.getGasPrice().catch(() => 0n),
  ]);
  const base = block.baseFeePerGas ?? 0n;
  let tip = rpcTip;
  if (c.minTip && tip < c.minTip) tip = c.minTip;
  let maxFee = 2n * base + tip;
  if (maxFee < gasPrice) maxFee = gasPrice + tip; // legacy-style RPCs / zero-base chains
  return { maxFee, tip: tip > maxFee ? maxFee : tip, base };
}

/** OP-stack L1 data fee upper bound for an unsigned tx of `size` bytes (Fjord+ oracle). */
export async function l1Fee(chainId: number, size: number): Promise<bigint> {
  if (!chainById(chainId).opStack) return 0n;
  try {
    const v = await client(chainId).readContract({
      address: OP_GAS_ORACLE,
      abi: GPO,
      functionName: 'getL1FeeUpperBound',
      args: [BigInt(size)],
    });
    return (v * 3n) / 2n;
  } catch {
    return 10n ** 13n; // 0.00001 ETH: far above current L1 data fees on Base/OP
  }
}

export interface NativePlan {
  balance: bigint;
  value: bigint;
  gas: bigint;
  fees: Fees;
  l1: bigint;
  /** worst-case leftover on the source */
  dustMax: bigint;
}

/** Plain-transfer sweep: value = balance − gas×maxFee − L1 fee − 5% buffer. */
export async function planNativeSweep(chainId: number, from: `0x${string}`, to: `0x${string}`): Promise<NativePlan> {
  const c = chainById(chainId);
  const pc = client(chainId);
  const [balance, fees, est, l1] = await Promise.all([
    pc.getBalance({ address: from }),
    feeParams(chainId),
    pc.estimateGas({ account: from, to, value: 1n }),
    l1Fee(chainId, 160),
  ]);
  // Nitro (Arbitrum, Robinhood) folds the L1 cost into gas units, which drift with L1 price
  const gas = c.nitro ? (est * 13n) / 10n : est;
  const reserve = gas * fees.maxFee + l1;
  const buffer = reserve / 20n;
  const value = balance - reserve - buffer;
  return { balance, value: value > 0n ? value : 0n, gas, fees, l1, dustMax: value > 0n ? reserve + buffer : balance };
}

/* ---------- wallet helpers ---------- */

async function sendTx(provider: EIP1193Provider, tx: Record<string, string>): Promise<Hex> {
  return (await provider.request({ method: 'eth_sendTransaction', params: [tx as never] })) as Hex;
}

export async function atomicSupported(provider: EIP1193Provider, from: `0x${string}`, chainId: number): Promise<boolean> {
  try {
    const hex = numberToHex(chainId);
    const caps = (await provider.request({
      method: 'wallet_getCapabilities',
      params: [from, [hex]],
    } as never)) as Record<string, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }> | null;
    if (!caps) return false;
    const cap = caps[hex] ?? caps[String(chainId)] ?? caps['0x0'];
    if (!cap) return false;
    if (cap.atomic?.status === 'supported' || cap.atomic?.status === 'ready') return true;
    return cap.atomicBatch?.supported === true;
  } catch {
    return false;
  }
}

function isReject(e: unknown) {
  const code = (e as { code?: number })?.code;
  return code === 4001 || /reject|denied|cancel/i.test(String((e as Error)?.message ?? ''));
}
function errText(e: unknown): string {
  if (isReject(e)) return 'rejected in wallet';
  const m = (e as { shortMessage?: string; details?: string; message?: string }) ?? {};
  return (m.shortMessage || m.details || m.message || String(e)).split('\n')[0].slice(0, 160);
}

/* ---------- the sweep ---------- */

export interface SweepArgs {
  provider: EIP1193Provider;
  chainId: number;
  from: `0x${string}`;
  to: `0x${string}`;
  /** selected assets; native is moved last no matter where it sits */
  assets: Asset[];
  mode: 'auto' | 'sequential';
  onSteps(steps: Step[]): void;
}

export interface SweepResult {
  mode: 'batch' | 'sequential';
  ok: boolean;
  dustMax?: bigint;
}

function tokenCall(a: Asset, from: `0x${string}`, to: `0x${string}`, amount: bigint): { to: `0x${string}`; data: Hex } {
  if (a.kind === 'erc721') {
    return {
      to: a.token!,
      data: encodeFunctionData({ abi: erc721Abi, functionName: 'safeTransferFrom', args: [from, to, a.tokenId!] }),
    };
  }
  return { to: a.token!, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }) };
}

async function freshAmount(a: Asset, from: `0x${string}`): Promise<bigint> {
  const pc = client(a.chainId);
  if (a.kind === 'erc721') {
    const owner = await pc.readContract({ address: a.token!, abi: erc721Abi, functionName: 'ownerOf', args: [a.tokenId!] });
    return owner.toLowerCase() === from.toLowerCase() ? 1n : 0n;
  }
  return pc.readContract({ address: a.token!, abi: erc20Abi, functionName: 'balanceOf', args: [from] });
}

const label = (a: Asset) => (a.kind === 'erc721' ? `${a.symbol} #${a.tokenId}` : a.symbol);

export async function sweepChain(args: SweepArgs): Promise<SweepResult> {
  const { provider, chainId, from, to, onSteps } = args;
  const pc = client(chainId);
  const tokens = args.assets.filter((a) => a.kind !== 'native');
  const native = args.assets.find((a) => a.kind === 'native');
  const steps: Step[] = [
    ...tokens.map((a) => ({ id: a.key, label: `${label(a)} → bunker`, status: 'queued' as StepStatus })),
    ...(native ? [{ id: native.key, label: `${native.symbol} (all but gas) → bunker`, status: 'queued' as StepStatus }] : []),
  ];
  const push = () => onSteps(steps.map((s) => ({ ...s })));
  const set = (id: string, patch: Partial<Step>) => {
    const s = steps.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
    push();
  };
  push();

  // ---------- EIP-5792 atomic batch ----------
  if (args.mode === 'auto' && (await atomicSupported(provider, from, chainId))) {
    const calls: { to: `0x${string}`; data?: Hex; value?: Hex }[] = [];
    let gasSum = 30_000n; // delegation / authorization overhead
    for (const a of tokens) {
      const amt = await freshAmount(a, from).catch(() => 0n);
      if (amt === 0n) {
        set(a.key, { status: 'skipped', note: 'balance is 0' });
        continue;
      }
      const call = tokenCall(a, from, to, amt);
      gasSum += await pc.estimateGas({ account: from, ...call }).catch(() => 120_000n);
      calls.push(call);
    }
    let dustMax: bigint | undefined;
    if (native) {
      const [balance, fees, est] = await Promise.all([
        pc.getBalance({ address: from }),
        feeParams(chainId),
        pc.estimateGas({ account: from, to, value: 1n }),
      ]);
      gasSum += est;
      const l1 = await l1Fee(chainId, 200 + 120 * (calls.length + 1));
      const reserve = (gasSum * fees.maxFee * 3n) / 2n + l1;
      const value = balance - reserve;
      if (value > 0n) {
        calls.push({ to, value: numberToHex(value) });
        dustMax = reserve;
      } else {
        set(native.key, { status: 'skipped', note: 'balance below gas cost' });
      }
    }
    if (!calls.length) return { mode: 'batch', ok: true };
    const live = steps.filter((s) => s.status === 'queued');
    live.forEach((s) => (s.status = 'wallet'));
    push();
    let id: string;
    try {
      const res = (await provider.request({
        method: 'wallet_sendCalls',
        params: [{ version: '2.0.0', chainId: numberToHex(chainId), from, atomicRequired: true, calls }],
      } as never)) as string | { id: string };
      id = typeof res === 'string' ? res : res.id;
    } catch (e) {
      live.forEach((s) => Object.assign(s, { status: 'failed', note: errText(e) }));
      push();
      return { mode: 'batch', ok: false };
    }
    live.forEach((s) => (s.status = 'pending'));
    push();
    const t0 = Date.now();
    while (Date.now() - t0 < 15 * 60_000) {
      await new Promise((r) => setTimeout(r, 1500));
      let st: { status: number | string; receipts?: { transactionHash: Hex; status: Hex | string }[] };
      try {
        st = (await provider.request({ method: 'wallet_getCallsStatus', params: [id] } as never)) as typeof st;
      } catch {
        continue;
      }
      const s = st?.status;
      if (s === 100 || s === 'PENDING') continue;
      const hash = st.receipts?.[st.receipts.length - 1]?.transactionHash;
      const okReceipts = (st.receipts ?? []).every((r) => r.status === '0x1' || r.status === 'success');
      if ((s === 200 || s === 'CONFIRMED') && okReceipts) {
        live.forEach((x) => Object.assign(x, { status: 'done', hash }));
        push();
        return { mode: 'batch', ok: true, dustMax };
      }
      live.forEach((x) => Object.assign(x, { status: 'failed', hash, note: `batch failed (status ${s})` }));
      push();
      return { mode: 'batch', ok: false };
    }
    live.forEach((x) => Object.assign(x, { status: 'failed', note: 'timed out waiting for the wallet' }));
    push();
    return { mode: 'batch', ok: false };
  }

  // ---------- sequential: every token, then the native sweep ----------
  for (const a of tokens) {
    try {
      const amt = await freshAmount(a, from);
      if (amt === 0n) {
        set(a.key, { status: 'skipped', note: 'balance is 0' });
        continue;
      }
      set(a.key, { status: 'wallet' });
      const call = tokenCall(a, from, to, amt);
      const hash = await sendTx(provider, { from, to: call.to, data: call.data });
      set(a.key, { status: 'pending', hash });
      const rc = await pc.waitForTransactionReceipt({ hash, timeout: 15 * 60_000 });
      if (rc.status !== 'success') {
        set(a.key, { status: 'failed', note: 'reverted on-chain' });
        return { mode: 'sequential', ok: false };
      }
      set(a.key, { status: 'done' });
    } catch (e) {
      set(a.key, { status: 'failed', note: errText(e) });
      return { mode: 'sequential', ok: false };
    }
  }
  if (!native) return { mode: 'sequential', ok: true };
  try {
    const plan = await planNativeSweep(chainId, from, to);
    if (plan.value === 0n) {
      set(native.key, { status: 'skipped', note: 'balance below gas cost' });
      return { mode: 'sequential', ok: true, dustMax: plan.balance };
    }
    set(native.key, { status: 'wallet' });
    const hash = await sendTx(provider, {
      from,
      to,
      value: numberToHex(plan.value),
      gas: numberToHex(plan.gas),
      maxFeePerGas: numberToHex(plan.fees.maxFee),
      maxPriorityFeePerGas: numberToHex(plan.fees.tip),
    });
    set(native.key, { status: 'pending', hash });
    const rc = await pc.waitForTransactionReceipt({ hash, timeout: 15 * 60_000 });
    if (rc.status !== 'success') {
      set(native.key, { status: 'failed', note: 'reverted on-chain' });
      return { mode: 'sequential', ok: false };
    }
    set(native.key, { status: 'done' });
    return { mode: 'sequential', ok: true, dustMax: plan.dustMax };
  } catch (e) {
    set(native.key, { status: 'failed', note: errText(e) });
    return { mode: 'sequential', ok: false };
  }
}
