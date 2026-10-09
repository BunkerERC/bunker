// XMSS (Merkle tree of WOTS one-time keys) over keccak256. Must match launchpad/contracts/src/XMSS.sol byte for byte.
// Plain JS so the site, its Web Worker and the node tests share one implementation.
//
//   chain step  F(x, leaf, i, j) = keccak256(seed ‖ x ‖ u32 leaf ‖ u8 i ‖ u8 j)            70 bytes
//   leaf        L(leaf, ends)    = keccak256(seed ‖ u32 leaf ‖ end_0 ‖ … ‖ end_66)       2,180 bytes
//   node        N(h, j, l, r)    = keccak256(seed ‖ u8 h ‖ u32 j ‖ l ‖ r)                  101 bytes
//   digits      64 nibbles of the digest (msb first) + 3 nibbles of sum(15 - d) (msb first)
//
// Secrets (client only, from the 32-byte entropy of the 24-word bunker phrase; BunkerVault keys use "BUNKER/WOTS/v1"):
//   master       = keccak256("BUNKER/XMSS/v1" ‖ entropy)
//   seed         = keccak256(master ‖ "seed")                      public
//   sk(leaf, i)  = keccak256(master ‖ u32 leaf ‖ u8 i)              secret chain start
import { keccak_256 } from '@noble/hashes/sha3';

export const HEIGHT = 10;
export const LEAVES = 1 << HEIGHT;
export const CHAINS = 67;
const TOP = 15; // last chain step (w = 16)
const enc = new TextEncoder();

export function toHex(b) {
  let s = '0x';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h) {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2) throw new Error('odd hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function cat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** master (secret) and seed (public) of an identity, from 32 bytes of phrase entropy. */
export function identityKeys(entropy) {
  if (entropy.length !== 32) throw new Error('entropy must be 32 bytes');
  const master = keccak_256(cat(enc.encode('BUNKER/XMSS/v1'), entropy));
  const seed = keccak_256(cat(master, enc.encode('seed')));
  return { master, seed };
}

/** The 67 chain positions signed for a 32-byte digest. */
export function digitsOf(digest) {
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  const out = new Array(CHAINS);
  let csum = 0;
  for (let b = 0; b < 32; b++) {
    out[2 * b] = digest[b] >> 4;
    out[2 * b + 1] = digest[b] & 15;
  }
  for (let i = 0; i < 64; i++) csum += TOP - out[i];
  out[64] = (csum >> 8) & 15;
  out[65] = (csum >> 4) & 15;
  out[66] = csum & 15;
  return out;
}

function secret(master, leaf, i) {
  const buf = new Uint8Array(37);
  buf.set(master, 0);
  new DataView(buf.buffer).setUint32(32, leaf);
  buf[36] = i;
  return keccak_256(buf);
}

/** Walks chain i of `leaf` from step `from` to step `to` (exclusive), starting at x. */
function walk(seed, x, leaf, i, from, to) {
  if (from >= to) return x;
  const buf = new Uint8Array(70);
  buf.set(seed, 0);
  new DataView(buf.buffer).setUint32(64, leaf);
  buf[68] = i;
  for (let j = from; j < to; j++) {
    buf.set(x, 32);
    buf[69] = j;
    x = keccak_256(buf);
  }
  return x;
}

function leafFromEnds(seed, leaf, ends) {
  const buf = new Uint8Array(36 + CHAINS * 32);
  buf.set(seed, 0);
  new DataView(buf.buffer).setUint32(32, leaf);
  for (let i = 0; i < CHAINS; i++) buf.set(ends[i], 36 + 32 * i);
  return keccak_256(buf);
}

export function node(seed, h, j, left, right) {
  const buf = new Uint8Array(101);
  buf.set(seed, 0);
  buf[32] = h;
  new DataView(buf.buffer).setUint32(33, j);
  buf.set(left, 37);
  buf.set(right, 69);
  return keccak_256(buf);
}

/** Leaf hash (public) of one-time key `leaf`. ~1,005 hashes. */
export function leafHash(master, seed, leaf) {
  const ends = new Array(CHAINS);
  for (let i = 0; i < CHAINS; i++) ends[i] = walk(seed, secret(master, leaf, i), leaf, i, 0, TOP);
  return leafFromEnds(seed, leaf, ends);
}

/** Leaf hashes [from, to). The expensive part (~1M hashes for all 1,024); run it in workers. */
export function leafRange(master, seed, from, to, onLeaf) {
  const out = [];
  for (let l = from; l < to; l++) {
    out.push(leafHash(master, seed, l));
    if (onLeaf) onLeaf(l);
  }
  return out;
}

/** Full tree from the 1,024 leaf hashes: levels[0] = leaves … levels[HEIGHT] = [root]. All public. */
export function treeFromLeaves(seed, leaves) {
  if (leaves.length !== LEAVES) throw new Error(`need ${LEAVES} leaves`);
  const levels = [leaves];
  for (let h = 1; h <= HEIGHT; h++) {
    const below = levels[h - 1];
    const next = new Array(below.length / 2);
    for (let j = 0; j < next.length; j++) next[j] = node(seed, h, j, below[2 * j], below[2 * j + 1]);
    levels.push(next);
  }
  return levels;
}

export function buildTree(master, seed) {
  return treeFromLeaves(seed, leafRange(master, seed, 0, LEAVES));
}

export const rootOf = levels => levels[HEIGHT][0];

export function authPath(levels, leaf) {
  const path = [];
  let idx = leaf;
  for (let h = 0; h < HEIGHT; h++) {
    path.push(levels[h][idx ^ 1]);
    idx >>= 1;
  }
  return path;
}

/** XMSS signature of a 32-byte digest with one-time key `leaf`. NEVER sign twice with one leaf. */
export function sign(master, seed, levels, leaf, digest) {
  if (!Number.isInteger(leaf) || leaf < 0 || leaf >= LEAVES) throw new Error('leaf out of range');
  const d = digitsOf(digest);
  return {
    leaf,
    wots: d.map((v, i) => toHex(walk(seed, secret(master, leaf, i), leaf, i, 0, v))),
    auth: authPath(levels, leaf).map(toHex),
  };
}

/**
 * Recomputes the root a signature leads to, exactly like XMSS.rootOf on-chain. `trace` (optional) receives every
 * intermediate value so the UI can show the work.
 */
export function rootFromSignature(seed, leaf, digest, wots, auth, trace) {
  const d = digitsOf(digest);
  const ends = wots.map((s, i) => walk(seed, typeof s === 'string' ? fromHex(s) : s, leaf, i, d[i], TOP));
  let n = leafFromEnds(seed, leaf, ends);
  if (trace) {
    trace.digits = d;
    trace.leafHash = toHex(n);
    trace.path = [];
  }
  let idx = leaf;
  for (let h = 0; h < HEIGHT; h++) {
    const sib = typeof auth[h] === 'string' ? fromHex(auth[h]) : auth[h];
    const parent = idx >> 1;
    n = idx & 1 ? node(seed, h + 1, parent, sib, n) : node(seed, h + 1, parent, n, sib);
    if (trace) trace.path.push({ height: h + 1, index: parent, side: idx & 1 ? 'R' : 'L', node: toHex(n) });
    idx = parent;
  }
  return n;
}

/** keccak256(abi.encode(seed, root)) — the identity id BunkerLaunchpad uses. */
export function identityId(seed, root) {
  return keccak_256(cat(seed, root));
}
