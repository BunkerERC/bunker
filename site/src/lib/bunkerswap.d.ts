import type { Abi, Hex, PublicClient } from 'viem';

export const ETH: Hex;
export const UNIVERSAL_ROUTER: Hex;
export const WETH: Hex;
export const V4_QUOTER: Hex;
export const V3_QUOTER: Hex;
export const V2_ROUTER: Hex;
export const swapAbi: Abi;

export interface Order {
  id: Hex;
  nonce: bigint | number | string;
  tokenIn: Hex;
  tokenOut: Hex;
  amountIn: bigint | string;
  minOut: bigint | string;
  tip: bigint | string;
  /** zero address = anyone may submit it */
  submitter: Hex;
  deadline: bigint | number | string;
  route: Hex;
}

export interface Route {
  commands: Hex;
  inputs: Hex[];
}

export interface Candidate {
  kind: 'v4' | 'v3' | 'v2';
  label: string;
  tokenIn: Hex;
  tokenOut: Hex;
  fee?: number;
  tickSpacing?: number;
  hooks?: Hex;
}

export interface Quote extends Candidate {
  amountOut: bigint;
}

export function orderArgs(order: Order): {
  id: Hex; nonce: bigint; tokenIn: Hex; tokenOut: Hex; amountIn: bigint; minOut: bigint; tip: bigint; submitter: Hex; deadline: bigint; route: Hex;
};
export function orderHash(order: Order): Hex;
export function boxOf(swap: Hex, boxCode: Hex, order: Order): Hex;
export function routeHash(route: Route): Hex;
export function poolKeyOf(tokenIn: Hex, tokenOut: Hex, fee: number, tickSpacing: number, hooks?: Hex): {
  poolKey: { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex };
  zeroForOne: boolean;
};
export function v4Route(c: { tokenIn: Hex; tokenOut: Hex; fee: number; tickSpacing: number; hooks?: Hex }): Route;
export function v3Route(c: { tokenIn: Hex; tokenOut: Hex; fee: number }): Route;
export function v2Route(c: { tokenIn: Hex; tokenOut: Hex }): Route;
export function candidates(p: { tokenIn: Hex; tokenOut: Hex; launchpad?: Hex | null }): Candidate[];
export function routeOf(c: Candidate): Route;
export function quoteAll(
  client: PublicClient,
  p: { tokenIn: Hex; tokenOut: Hex; amountIn: bigint; launchpad?: Hex | null },
): Promise<Quote[]>;
export function buySplit(amountIn: bigint, tip: bigint, feeBps: bigint | number): { fee: bigint; spend: bigint };
export function sellSplit(gross: bigint, tip: bigint, feeBps: bigint | number): { fee: bigint; net: bigint };
export function withSlippage(amount: bigint, bps: bigint | number): bigint;
