// Prepares a running mainnet fork (anvil on FORK_URL, default http://127.0.0.1:8645) for the site's browser test:
// deploys BunkerToken + BunkerVault, funds a test "user" with ETH, USDC and BUNKER, impersonates it so a mock
// window.ethereum can send its transactions, and prints the addresses as JSON.
//   node launch/test/site-fork-setup.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther, getAddress, keccak256, encodeAbiParameters, toHex, parseAbi } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const art = n => JSON.parse(readFileSync(join(ROOT, 'contracts', 'out', `${n}.sol`, `${n}.json`), 'utf8'));
const URL = process.env.FORK_URL ?? 'http://127.0.0.1:8645';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const pub = createPublicClient({ chain: mainnet, transport: http(URL) });
const rpc = (method, params) => pub.request({ method, params });

const deployer = privateKeyToAccount(generatePrivateKey());
const user = privateKeyToAccount(generatePrivateKey()).address;
await rpc('anvil_setBalance', [deployer.address, toHex(parseEther('1'))]);
await rpc('anvil_setBalance', [user, toHex(parseEther('3'))]);
const wal = createWalletClient({ account: deployer, chain: mainnet, transport: http(URL) });
const deploy = async (n, args = []) => {
  const a = art(n);
  const hash = await wal.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
  return getAddress((await pub.waitForTransactionReceipt({ hash })).contractAddress);
};
const token = await deploy('MockERC20', ['Bunker Mode', 'BUNKER', 18]);
await pub.waitForTransactionReceipt({ hash: await wal.writeContract({ address: token, abi: art('MockERC20').abi, functionName: 'mint', args: [user, 10n ** 27n] }) });
const vault = await deploy('BunkerVault');
const block = await pub.getBlockNumber();

// 1,000 USDC: FiatToken balances live in mapping slot 9
const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [user, 9n]));
await rpc('anvil_setStorageAt', [USDC, slot, toHex(1_000_000_000n, { size: 32 })]);
const usdc = await pub.readContract({ address: USDC, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [user] });
if (usdc !== 1_000_000_000n) throw new Error(`USDC slot guess wrong: ${usdc}`);
await rpc('anvil_impersonateAccount', [user]);
console.log(JSON.stringify({ user, token, vault, block: block.toString(), usdc: usdc.toString() }));
