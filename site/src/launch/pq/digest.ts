// Mirrors BunkerLaunchpad.launchDigest / feeDigest. The launch flow also asks the contract (eth_call) and refuses to
// sign if the two disagree.
import { encodeAbiParameters, keccak256, toBytes, type Hex } from 'viem';

export const LAUNCH_TAG = keccak256(toBytes('BunkerLaunchpad.launch.v1'));
export const FEE_TAG = keccak256(toBytes('BunkerLaunchpad.setFeeTo.v1'));

export interface LaunchParams {
  name: string;
  symbol: string;
  meta: string;
  image: Hex;
  devTo: Hex;
  devVault: Hex;
  feeTo: Hex;
  feeVault: Hex;
}

export function launchDigest(a: {
  chainId: number;
  launchpad: Hex;
  identity: Hex;
  leaf: number;
  creator: Hex;
  devBuy: bigint;
  p: LaunchParams;
}): Hex {
  const { p } = a;
  const content = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [keccak256(toBytes(p.name)), keccak256(toBytes(p.symbol)), keccak256(toBytes(p.meta)), keccak256(p.image)],
    ),
  );
  const payees = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }],
      [p.devTo, p.devVault, p.feeTo, p.feeVault],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'uint32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [LAUNCH_TAG, BigInt(a.chainId), a.launchpad, a.identity, a.leaf, a.creator, a.devBuy, content, payees],
    ),
  );
}

export function feeDigest(a: {
  chainId: number;
  launchpad: Hex;
  token: Hex;
  identity: Hex;
  leaf: number;
  feeTo: Hex;
  feeVault: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'uint32' },
        { type: 'address' },
        { type: 'bytes32' },
      ],
      [FEE_TAG, BigInt(a.chainId), a.launchpad, a.token, a.identity, a.leaf, a.feeTo, a.feeVault],
    ),
  );
}
