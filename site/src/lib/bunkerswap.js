// Orders, routes and quotes for BunkerSwap (contracts/src/BunkerSwap.sol). Pure JS so the site and the node tests
// share one implementation.
//
// An order is tied to the bunker's hash signature through an address: the vault is told to pay the order's "box",
// and the box address is a hash of the whole order (CREATE2 of a minimal proxy, salt = orderHash). Everything here
// must match the contract byte for byte.
import { concat, encodeAbiParameters, encodePacked, getAddress, keccak256, parseAbi, toBytes, zeroAddress } from 'viem';

export const ETH = zeroAddress;
export const UNIVERSAL_ROUTER = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af';
export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
export const V4_QUOTER = '0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203';
export const V3_QUOTER = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
export const V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

const TAG = keccak256(toBytes('BunkerSwap.order.v1'));
const ORDER = {
  type: 'tuple',
  components: [
    { name: 'id', type: 'bytes32' }, { name: 'nonce', type: 'uint64' }, { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' }, { name: 'minOut', type: 'uint256' },
    { name: 'tip', type: 'uint256' }, { name: 'submitter', type: 'address' }, { name: 'deadline', type: 'uint64' },
    { name: 'route', type: 'bytes32' },
  ],
};

export const swapAbi = parseAbi([
  'struct Order { bytes32 id; uint64 nonce; address tokenIn; address tokenOut; uint256 amountIn; uint256 minOut; uint256 tip; address submitter; uint64 deadline; bytes32 route; }',
  'function run(Order o, bytes32 nextKey, bytes32[67] sig, bytes commands, bytes[] inputs)',
  'function rescue(Order o, address token) returns (uint256)',
  'function boxOf(Order o) view returns (address)',
  'function orderHash(Order o) pure returns (bytes32)',
  'function BOX() view returns (address)',
  'function FEE_BPS() view returns (uint256)',
  'function MAX_LIFE() view returns (uint256)',
  'function VAULT() view returns (address)',
  'function platform() view returns (address)',
  'function owed() view returns (uint256)',
  'event Swapped(bytes32 indexed id, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 tip, address submitter)',
  'event Returned(bytes32 indexed id, address indexed token, uint256 amount, address submitter)',
  'event Stranded(bytes32 indexed id, address indexed token, address box)',
  'error BadOrder()', 'error BadRoute()', 'error NothingThere()', 'error TooLittle(uint256 out)', 'error OutOfGas()', 'error NotSubmitter()',
  'error BadSignature()', 'error UnknownAccount()', 'error BadNextKey()', 'error NotRelayer()', 'error Insufficient(address token)',
]);

/** The order with every number as a bigint, in the shape the contract calls take. */
export const orderArgs = o => ({ id: o.id, nonce: BigInt(o.nonce), tokenIn: o.tokenIn, tokenOut: o.tokenOut, amountIn: BigInt(o.amountIn),
  minOut: BigInt(o.minOut), tip: BigInt(o.tip), submitter: o.submitter, deadline: BigInt(o.deadline), route: o.route });
const big = orderArgs;

/** keccak256(abi.encode(TAG, order)), same as BunkerSwap.orderHash. */
export function orderHash(order) {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, ORDER], [TAG, big(order)]));
}

/** The address the vault pays for this order, same as BunkerSwap.boxOf. `boxCode` = BunkerSwap.BOX(). */
export function boxOf(swap, boxCode, order) {
  const init = concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', boxCode, '0x5af43d82803e903d91602b57fd5bf3']);
  const h = keccak256(concat(['0xff', swap, orderHash(order), keccak256(init)]));
  return getAddress(`0x${h.slice(26)}`);
}

export function routeHash(route) {
  return keccak256(encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [route.commands, route.inputs]));
}

// ------------------------------------------------------------------ routes (Universal Router)
// Every route swaps "whatever the router was handed" and sends all of the output back to the caller (BunkerSwap).
// The minimum is enforced by BunkerSwap, on what the vault credits, so the routes carry no minimum of their own.

const CONTRACT_BALANCE = 1n << 255n;
const MSG_SENDER = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const POOL_KEY = { name: 'poolKey', type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
const EXACT_IN_SINGLE = { type: 'tuple', components: [POOL_KEY, { name: 'zeroForOne', type: 'bool' },
  { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] };

export function poolKeyOf(tokenIn, tokenOut, fee, tickSpacing, hooks = zeroAddress) {
  const inFirst = BigInt(tokenIn) < BigInt(tokenOut);
  return { poolKey: { currency0: inFirst ? tokenIn : tokenOut, currency1: inFirst ? tokenOut : tokenIn, fee, tickSpacing, hooks }, zeroForOne: inFirst };
}

/** Uniswap v4, one pool: SETTLE (all the router holds), SWAP_EXACT_IN_SINGLE (the open amount), TAKE_ALL. */
export function v4Route({ tokenIn, tokenOut, fee, tickSpacing, hooks = zeroAddress }) {
  const { poolKey, zeroForOne } = poolKeyOf(tokenIn, tokenOut, fee, tickSpacing, hooks);
  const params = [
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [tokenIn, CONTRACT_BALANCE, false]),
    encodeAbiParameters([EXACT_IN_SINGLE], [{ poolKey, zeroForOne, amountIn: 0n, amountOutMinimum: 0n, hookData: '0x' }]),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tokenOut, 0n]),
  ];
  return { commands: '0x10', inputs: [encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x0b060f', params])] };
}

const V3_IN = [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }];
const V2_IN = [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'bool' }];
const wrapAll = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ADDRESS_THIS, CONTRACT_BALANCE]);
const unwrapAll = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [MSG_SENDER, 0n]);

/** Uniswap v3, one WETH pool. Buying wraps the ETH first; selling unwraps the WETH at the end. */
export function v3Route({ tokenIn, tokenOut, fee }) {
  if (tokenIn === ETH) {
    const path = encodePacked(['address', 'uint24', 'address'], [WETH, fee, tokenOut]);
    return { commands: '0x0b00', inputs: [wrapAll, encodeAbiParameters(V3_IN, [MSG_SENDER, CONTRACT_BALANCE, 0n, path, false])] };
  }
  const path = encodePacked(['address', 'uint24', 'address'], [tokenIn, fee, WETH]);
  return { commands: '0x000c', inputs: [encodeAbiParameters(V3_IN, [ADDRESS_THIS, CONTRACT_BALANCE, 0n, path, false]), unwrapAll] };
}

/** Uniswap v2, the WETH pair. */
export function v2Route({ tokenIn, tokenOut }) {
  if (tokenIn === ETH)
    return { commands: '0x0b08', inputs: [wrapAll, encodeAbiParameters(V2_IN, [MSG_SENDER, CONTRACT_BALANCE, 0n, [WETH, tokenOut], false])] };
  return { commands: '0x080c', inputs: [encodeAbiParameters(V2_IN, [ADDRESS_THIS, CONTRACT_BALANCE, 0n, [tokenIn, WETH], false]), unwrapAll] };
}

// ------------------------------------------------------------------ quotes

const v4QuoterAbi = [{ type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [POOL_KEY, { name: 'zeroForOne', type: 'bool' },
    { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }] }];
const v3QuoterAbi = [{ type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }] }],
  outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' }] }];
const v2RouterAbi = parseAbi(['function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)']);

const pct = fee => `${fee / 10000}%`;

/** Every pool worth asking for an ETH <-> token swap. `launchpad` = the BunkerLaunchpad hook, if the token may be one of its coins. */
export function candidates({ tokenIn, tokenOut, launchpad }) {
  const list = [];
  if (launchpad) list.push({ kind: 'v4', fee: 10000, tickSpacing: 200, hooks: launchpad, label: 'Bunker launchpad pool (Uniswap v4, 1%)' });
  for (const [fee, tickSpacing] of [[10000, 200], [3000, 60], [500, 10], [100, 1]])
    list.push({ kind: 'v4', fee, tickSpacing, hooks: zeroAddress, label: `Uniswap v4, ${pct(fee)} pool` });
  for (const fee of [10000, 3000, 500, 100]) list.push({ kind: 'v3', fee, label: `Uniswap v3, ${pct(fee)} pool` });
  list.push({ kind: 'v2', label: 'Uniswap v2' });
  return list.map(c => ({ ...c, tokenIn, tokenOut }));
}

export function routeOf(c) {
  return c.kind === 'v4' ? v4Route(c) : c.kind === 'v3' ? v3Route(c) : v2Route(c);
}

function quoteCall(c, amountIn) {
  const wrap = t => (t === ETH ? WETH : t);
  if (c.kind === 'v4') {
    const { poolKey, zeroForOne } = poolKeyOf(c.tokenIn, c.tokenOut, c.fee, c.tickSpacing, c.hooks);
    return { address: V4_QUOTER, abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' }] };
  }
  if (c.kind === 'v3')
    return { address: V3_QUOTER, abi: v3QuoterAbi, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: wrap(c.tokenIn), tokenOut: wrap(c.tokenOut), amountIn, fee: c.fee, sqrtPriceLimitX96: 0n }] };
  return { address: V2_ROUTER, abi: v2RouterAbi, functionName: 'getAmountsOut', args: [amountIn, [wrap(c.tokenIn), wrap(c.tokenOut)]] };
}

/**
 * Asks every candidate pool what `amountIn` of tokenIn gives, in one multicall, and returns them best first.
 * One of tokenIn / tokenOut must be ETH. Pools that do not exist are simply missing from the result.
 */
export async function quoteAll(client, { tokenIn, tokenOut, amountIn, launchpad }) {
  if ((tokenIn === ETH) === (tokenOut === ETH)) throw new Error('one side of a bunker swap must be ETH');
  if (amountIn <= 0n) return [];
  const list = candidates({ tokenIn, tokenOut, launchpad });
  const res = await client.multicall({ contracts: list.map(c => quoteCall(c, amountIn)), allowFailure: true });
  const out = [];
  res.forEach((r, i) => {
    if (r.status !== 'success') return;
    const amountOut = list[i].kind === 'v2' ? r.result[r.result.length - 1] : r.result[0];
    if (amountOut > 0n) out.push({ ...list[i], amountOut });
  });
  return out.sort((a, b) => (a.amountOut === b.amountOut ? 0 : a.amountOut > b.amountOut ? -1 : 1));
}

// ------------------------------------------------------------------ amounts

/** Buying: of `amountIn` ETH leaving the bunker, the fee and the tip come off first; the rest is swapped. */
export function buySplit(amountIn, tip, feeBps) {
  const fee = (amountIn * BigInt(feeBps)) / 10000n;
  return { fee, spend: amountIn - fee - tip };
}

/** Selling: of `gross` ETH coming out of the pool, the fee and the tip come off; the rest is credited. */
export function sellSplit(gross, tip, feeBps) {
  const fee = (gross * BigInt(feeBps)) / 10000n;
  return { fee, net: gross - fee - tip };
}

/** `amount` less `bps` of slippage. */
export const withSlippage = (amount, bps) => (amount * (10000n - BigInt(bps))) / 10000n;
