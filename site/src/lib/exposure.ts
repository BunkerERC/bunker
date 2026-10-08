import { getAddress, isAddress, sha256 } from 'viem';

/* ============================================================
   Address detection (EVM / Bitcoin / Solana), with checksums
   ============================================================ */

export type BtcType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr';

export type Detected =
  | { kind: 'evm'; address: `0x${string}` }
  | { kind: 'btc'; address: string; btcType: BtcType }
  | { kind: 'sol'; address: string }
  | { kind: 'invalid'; address: string; why: string };

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Uint8Array | null {
  if (!s) return null;
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function base58CheckVersion(s: string): number | null {
  const raw = base58Decode(s);
  if (!raw || raw.length !== 25) return null;
  const payload = raw.slice(0, 21);
  const sum = sha256(sha256(payload, 'bytes'), 'bytes');
  for (let i = 0; i < 4; i++) if (sum[i] !== raw[21 + i]) return null;
  return payload[0];
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function convertBits(data: number[], from: number, to: number): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

/** BIP-173 / BIP-350 segwit decode. Returns witness version + program length, or null if invalid. */
export function decodeSegwit(addr: string): { version: number; program: number[] } | null {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const s = addr.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length || s.length > 90) return null;
  const hrp = s.slice(0, pos);
  if (hrp !== 'bc') return null;
  const data = [...s.slice(pos + 1)].map((c) => BECH32.indexOf(c));
  if (data.includes(-1)) return null;
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = polymod(expand.concat(data));
  const enc = pm === 1 ? 'bech32' : pm === 0x2bc830a3 ? 'bech32m' : null;
  if (!enc) return null;
  const version = data[0];
  const program = convertBits(data.slice(1, -6), 5, 8);
  if (!program || program.length < 2 || program.length > 40 || version > 16) return null;
  if (version === 0 && (enc !== 'bech32' || (program.length !== 20 && program.length !== 32))) return null;
  if (version !== 0 && enc !== 'bech32m') return null;
  return { version, program };
}

export function detectAddress(input: string): Detected {
  const a = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) {
    return isAddress(a) ? { kind: 'evm', address: getAddress(a) } : { kind: 'invalid', address: a, why: 'bad EIP-55 checksum' };
  }
  if (/^(bc1|BC1)/.test(a)) {
    const sw = decodeSegwit(a);
    if (!sw) return { kind: 'invalid', address: a, why: 'bad bech32 checksum' };
    const lower = a.toLowerCase();
    if (sw.version === 0 && sw.program.length === 20) return { kind: 'btc', address: lower, btcType: 'p2wpkh' };
    if (sw.version === 0 && sw.program.length === 32) return { kind: 'btc', address: lower, btcType: 'p2wsh' };
    if (sw.version === 1 && sw.program.length === 32) return { kind: 'btc', address: lower, btcType: 'p2tr' };
    return { kind: 'invalid', address: a, why: `unsupported segwit v${sw.version}` };
  }
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a)) {
    const v = base58CheckVersion(a);
    if (v === 0x00) return { kind: 'btc', address: a, btcType: 'p2pkh' };
    if (v === 0x05) return { kind: 'btc', address: a, btcType: 'p2sh' };
    // could still be a Solana key that happens to start with 1/3 — fall through
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) {
    const raw = base58Decode(a);
    if (raw && raw.length === 32) return { kind: 'sol', address: a };
  }
  return { kind: 'invalid', address: a, why: 'not an EVM, Bitcoin or Solana address' };
}

/** Split a pasted blob (newlines, commas, spaces) into unique addresses. */
export function parseAddressList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const s = raw.trim();
    if (!s) continue;
    const key = /^0x/i.test(s) || /^bc1/i.test(s) ? s.toLowerCase() : s;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/* ============================================================
   Exposure verdicts
   ============================================================ */

export type Status = 'exposed' | 'hidden' | 'warn' | 'pending';

export interface Verdict {
  status: Status;
  /** one-line reason shown in the row */
  reason: string;
  /** optional caveat shown on demand */
  caveat?: string;
}

export const OFFCHAIN_CAVEAT =
  'Off-chain signatures reveal the key too, to whoever received them: Permit/Permit2 approvals, gasless swaps (CoW, UniswapX, 1inch Fusion), NFT listings, Sign-In-With-Ethereum.';

export interface EvmChainFacts {
  chainName: string;
  /** undefined while loading */
  nonce?: number;
  code?: `0x${string}`;
  error?: boolean;
}

export interface SafeFacts {
  chainName: string;
  owners: `0x${string}`[];
  threshold: number;
  /** Safe's own execution counter: >0 means owner signatures sit in on-chain calldata */
  safeNonce: number;
  /** verdict per owner (same order), may be pending */
  ownerStatus: Status[];
}

const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' + ') : `${xs.slice(0, 2).join(', ')} +${xs.length - 2}`);

export const isDelegation = (code?: string) => !!code && code.toLowerCase().startsWith('0xef0100');
export const isContractCode = (code?: string) => !!code && code !== '0x' && !isDelegation(code);

/**
 * EVM rule: one signature anywhere reveals the public key, and the same key controls the
 * address on every EVM chain. So nonce > 0 on ANY chain → exposed everywhere.
 */
export function classifyEvm(chains: EvmChainFacts[], safe?: SafeFacts): Verdict {
  const done = chains.filter((c) => c.nonce !== undefined || c.code !== undefined);
  const pending = chains.filter((c) => c.nonce === undefined && c.code === undefined && !c.error);
  const failed = chains.filter((c) => c.error && c.nonce === undefined);

  const delegated = done.filter((c) => isDelegation(c.code)).map((c) => c.chainName);
  if (delegated.length) {
    return {
      status: 'exposed',
      reason: `EIP-7702 delegated on ${list(delegated)}: the key signed an authorization, so the public key is out. Same key on every EVM chain.`,
    };
  }

  const contractOn = done.filter((c) => isContractCode(c.code)).map((c) => c.chainName);
  if (contractOn.length) {
    if (safe) {
      const exposedOwners = safe.ownerStatus.filter((s) => s === 'exposed').length;
      const ownersTxt = `${safe.threshold}-of-${safe.owners.length} Safe on ${safe.chainName}`;
      if (safe.safeNonce > 0) {
        return {
          status: 'exposed',
          reason: `${ownersTxt} executed ${safe.safeNonce} tx: owner signatures sit in on-chain calldata, so at least ${safe.threshold} owner key${safe.threshold > 1 ? 's are' : ' is'} public.`,
        };
      }
      if (exposedOwners >= safe.threshold) {
        return { status: 'exposed', reason: `${ownersTxt}: ${exposedOwners} owner keys exposed, enough to reach the threshold.` };
      }
      if (safe.ownerStatus.includes('pending')) {
        return { status: 'pending', reason: `${ownersTxt}: checking owner keys…` };
      }
      if (exposedOwners > 0) {
        return { status: 'warn', reason: `${ownersTxt}: ${exposedOwners} owner key${exposedOwners > 1 ? 's' : ''} exposed, below the threshold. Rotate them.` };
      }
      return {
        status: 'hidden',
        reason: `${ownersTxt}, never executed: no owner key has signed on-chain yet. Security depends on owner keys.`,
        caveat: OFFCHAIN_CAVEAT,
      };
    }
    return {
      status: 'warn',
      reason: `Smart contract on ${list(contractOn)}: no key of its own, security depends on whoever controls it (owner/signer keys).`,
    };
  }

  const signed = done.filter((c) => (c.nonce ?? 0) > 0);
  if (signed.length) {
    const total = signed.reduce((s, c) => s + (c.nonce ?? 0), 0);
    return {
      status: 'exposed',
      reason: `Signed ${total} tx on ${list(signed.map((c) => c.chainName))}: public key is on-chain. Same key controls this address on every EVM chain.`,
    };
  }
  if (pending.length) return { status: 'pending', reason: `checking ${pending.length} chain${pending.length > 1 ? 's' : ''}…` };
  if (failed.length) {
    return {
      status: 'warn',
      reason: `No signature on ${done.length} chains, but ${list(failed.map((c) => c.chainName))} didn't answer. Retry before trusting it.`,
    };
  }
  return {
    status: 'hidden',
    reason: `Never signed on ${done.length} chains: only the keccak256 hash of the key is public.`,
    caveat: OFFCHAIN_CAVEAT,
  };
}

export interface BtcFacts {
  btcType: BtcType;
  spentTxo: number; // chain_stats.spent_txo_count
  mempoolSpentTxo: number; // mempool_stats.spent_txo_count
}

const BTC_LABEL: Record<BtcType, string> = {
  p2pkh: 'Legacy P2PKH (1…)',
  p2sh: 'P2SH (3…)',
  p2wpkh: 'SegWit P2WPKH (bc1q…)',
  p2wsh: 'SegWit P2WSH (bc1q…, 62)',
  p2tr: 'Taproot P2TR (bc1p…)',
};
export const btcLabel = (t: BtcType) => BTC_LABEL[t];

export function classifyBtc(f: BtcFacts): Verdict {
  if (f.btcType === 'p2tr') {
    return {
      status: 'exposed',
      reason: 'Taproot: the address encodes the tweaked public key itself. Exposed from the first sat, no spend needed.',
    };
  }
  const spent = f.spentTxo + f.mempoolSpentTxo;
  const what = f.btcType === 'p2pkh' || f.btcType === 'p2wpkh' ? 'public key' : 'script and its public keys';
  if (spent > 0) {
    return {
      status: 'exposed',
      reason: `Spent ${spent}× before${f.mempoolSpentTxo ? ' (incl. unconfirmed)' : ''}: the ${what} sits in the spending input. What's left is on a reused address.`,
    };
  }
  const hash = f.btcType === 'p2wsh' ? 'SHA-256' : 'HASH160';
  return {
    status: 'hidden',
    reason: `Never spent: only the ${hash} of the ${f.btcType === 'p2pkh' || f.btcType === 'p2wpkh' ? 'key' : 'script'} is on-chain. Hidden until the first spend.`,
    caveat: 'Spending reveals it. So does reusing the same key elsewhere (signed messages, a Taproot address from the same key).',
  };
}

export function classifySol(): Verdict {
  return {
    status: 'exposed',
    reason: 'A Solana address IS the ed25519 public key. There is no hash to hide behind.',
  };
}
