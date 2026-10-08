import { parseAbi } from 'viem';

export const vaultAbi = parseAbi([
  'struct Transfer { address token; address to; uint256 amount; }',
  'function accounts(bytes32 id) view returns (bytes32 key, uint64 nonce)',
  'function balanceOf(bytes32 id, address token) view returns (uint256)',
  'function spentKey(bytes32 key) view returns (bool)',
  'function claimable(address to, address token) view returns (uint256)',
  'function digest(bytes32 id, Transfer[] transfers, address relayer, uint256 fee, bytes32 nextKey) view returns (bytes32)',
  'function wotsPublicKey(bytes32 d, bytes32[67] sig) pure returns (bytes32)',
  'function depositETH(bytes32 id) payable',
  'function deposit(bytes32 id, address token, uint256 amount)',
  'function execute(bytes32 id, Transfer[] transfers, address relayer, uint256 fee, bytes32 nextKey, bytes32[67] sig)',
  'function claim(address to, address token)',
  'event Deposited(bytes32 indexed id, address indexed token, address indexed from, uint256 amount)',
  'event Executed(bytes32 indexed id, uint64 nonce, bytes32 nextKey, address submitter, uint256 fee)',
]);

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
