// Winternitz one-time signatures for BunkerVault (contracts/src/BunkerVault.sol). Pure JS so the site and the
// node tests share one implementation.
//
// Scheme (must match the contract byte for byte):
//   digits   = 64 nibbles of the 32-byte digest (most significant first) + 3 nibbles of
//              checksum = sum(15 - digit) (most significant first)          -> 67 chains, w = 16
//   step     = x' = keccak256(x || uint8(chain) || uint8(step))
//   sig[i]   = secret_i advanced `digit_i` steps; public end_i = secret_i advanced 15 steps
//   key hash = keccak256(end_0 || ... || end_66)
// Secrets (client only):
//   master       = keccak256("BUNKER/WOTS/v1" || 32-byte entropy of the 24-word bunker phrase)
//   secret(k, i) = keccak256(master || uint32(k) || uint8(i))      k = key index = the account nonce
//   account id   = key hash of index 0
import { keccak256, concat, toBytes, toHex, encodeAbiParameters, hexToBytes, bytesToHex } from 'viem';
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

export const CHAINS = 67;
const W = 15; // last step index (w = 16)
const TAG = keccak256(toBytes('BunkerVault.execute.v1'));

/** A new 24-word bunker phrase from 32 bytes of browser/node crypto randomness. */
export function newPhrase() {
  const entropy = new Uint8Array(32);
  globalThis.crypto.getRandomValues(entropy);
  return entropyToMnemonic(entropy, wordlist);
}

export function isPhrase(phrase) {
  return validateMnemonic(normalize(phrase), wordlist) && normalize(phrase).split(' ').length === 24;
}

function normalize(phrase) {
  return String(phrase).trim().toLowerCase().split(/\s+/).join(' ');
}

/** 32-byte master secret (Uint8Array) of a 24-word phrase. Throws on a bad phrase. */
export function masterOf(phrase) {
  const p = normalize(phrase);
  if (!isPhrase(p)) throw new Error('not a valid 24-word bunker phrase');
  return masterFromEntropy(mnemonicToEntropy(p, wordlist));
}

/** Same master from the phrase's 32 bytes of entropy (the launchpad keys unlock from entropy). */
export function masterFromEntropy(entropy) {
  if (entropy.length !== 32) throw new Error('entropy must be 32 bytes');
  return keccak256(concat([toBytes('BUNKER/WOTS/v1'), entropy]), 'bytes');
}

function secret(master, k, i) {
  const buf = new Uint8Array(37);
  buf.set(master, 0);
  new DataView(buf.buffer).setUint32(32, k);
  buf[36] = i;
  return keccak256(buf, 'bytes');
}

function advance(x, i, from, to) {
  const buf = new Uint8Array(34);
  buf[32] = i;
  for (let j = from; j < to; j++) {
    buf.set(x, 0);
    buf[33] = j;
    x = keccak256(buf, 'bytes');
  }
  return x;
}

/** The 67 base-16 digits signed for `digest` (0x-hex bytes32). */
export function digitsOf(digest) {
  const d = hexToBytes(digest);
  if (d.length !== 32) throw new Error('digest must be 32 bytes');
  const out = new Array(CHAINS);
  let csum = 0;
  for (let b = 0; b < 32; b++) {
    out[2 * b] = d[b] >> 4;
    out[2 * b + 1] = d[b] & 0xf;
  }
  for (let i = 0; i < 64; i++) csum += W - out[i];
  out[64] = (csum >> 8) & 0xf;
  out[65] = (csum >> 4) & 0xf;
  out[66] = csum & 0xf;
  return out;
}

function hashEnds(ends) {
  const all = new Uint8Array(CHAINS * 32);
  ends.forEach((e, i) => all.set(e, i * 32));
  return keccak256(all);
}

/** Public-key hash (0x bytes32) of key index `k`. */
export function keyHash(master, k) {
  const ends = [];
  for (let i = 0; i < CHAINS; i++) ends.push(advance(secret(master, k, i), i, 0, W));
  return hashEnds(ends);
}

export const accountId = master => keyHash(master, 0);

/** bytes32[67] signature (0x-hex strings) of `digest` with key index `k`. */
export function sign(master, k, digest) {
  const dg = digitsOf(digest);
  return dg.map((d, i) => bytesToHex(advance(secret(master, k, i), i, 0, d)));
}

/** Recomputes the key hash from a signature, exactly like BunkerVault.wotsPublicKey. */
export function recover(digest, sig) {
  const dg = digitsOf(digest);
  return hashEnds(sig.map((s, i) => advance(hexToBytes(s), i, dg[i], W)));
}

const TRANSFERS = [{ type: 'tuple[]', components: [
  { name: 'token', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] }];

/** The message BunkerVault.execute checks (same as the contract's digest() view, with an explicit nonce). */
export function digestOf({ chainId, vault, id, nonce, transfers, relayer, fee, nextKey }) {
  const transfersHash = keccak256(encodeAbiParameters(TRANSFERS, [transfers.map(t => ({
    token: t.token, to: t.to, amount: BigInt(t.amount) }))]));
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint64' },
      { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [TAG, BigInt(chainId), vault, id, BigInt(nonce), relayer, BigInt(fee), nextKey, transfersHash]));
}

export const _test = { secret: (m, k, i) => toHex(secret(m, k, i)), advance };
