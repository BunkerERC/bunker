export const HEIGHT: number;
export const LEAVES: number;
export const CHAINS: number;
export type Bytes = Uint8Array;
export interface Sig { leaf: number; wots: `0x${string}`[]; auth: `0x${string}`[] }
export interface Trace { digits?: number[]; leafHash?: string; path?: { height: number; index: number; side: 'L' | 'R'; node: string }[] }
export function toHex(b: Bytes): `0x${string}`;
export function fromHex(h: string): Bytes;
export function identityKeys(entropy: Bytes): { master: Bytes; seed: Bytes };
export function digitsOf(digest: Bytes): number[];
export function node(seed: Bytes, h: number, j: number, left: Bytes, right: Bytes): Bytes;
export function leafHash(master: Bytes, seed: Bytes, leaf: number): Bytes;
export function leafRange(master: Bytes, seed: Bytes, from: number, to: number, onLeaf?: (l: number) => void): Bytes[];
export function treeFromLeaves(seed: Bytes, leaves: Bytes[]): Bytes[][];
export function buildTree(master: Bytes, seed: Bytes): Bytes[][];
export function rootOf(levels: Bytes[][]): Bytes;
export function authPath(levels: Bytes[][], leaf: number): Bytes[];
export function sign(master: Bytes, seed: Bytes, levels: Bytes[][], leaf: number, digest: Bytes): Sig;
export function rootFromSignature(seed: Bytes, leaf: number, digest: Bytes, wots: (string | Bytes)[], auth: (string | Bytes)[], trace?: Trace): Bytes;
export function identityId(seed: Bytes, root: Bytes): Bytes;
