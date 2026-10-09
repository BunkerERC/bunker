type Hex = `0x${string}`;

export const CHAINS: 67;
export function newPhrase(): string;
export function isPhrase(phrase: string): boolean;
export function masterOf(phrase: string): Uint8Array;
export function masterFromEntropy(entropy: Uint8Array): Uint8Array;
export function digitsOf(digest: Hex): number[];
export function keyHash(master: Uint8Array, k: number): Hex;
export function accountId(master: Uint8Array): Hex;
export function sign(master: Uint8Array, k: number, digest: Hex): Hex[];
export function recover(digest: Hex, sig: Hex[]): Hex;
export interface VaultTransfer {
  token: Hex;
  to: Hex;
  amount: bigint;
}
export function digestOf(msg: {
  chainId: number;
  vault: Hex;
  id: Hex;
  nonce: number | bigint;
  transfers: VaultTransfer[];
  relayer: Hex;
  fee: bigint;
  nextKey: Hex;
}): Hex;
