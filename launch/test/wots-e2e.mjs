// BunkerVault + the site's WOTS signer on a plain local anvil: deposit, sign in JS, execute, rotate.
//   node launch/test/wots-e2e.mjs
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther, getAddress, zeroAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { foundry } from 'viem/chains';
import * as wots from '../../site/src/lib/wots.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const art = n => JSON.parse(readFileSync(join(ROOT, 'contracts', 'out', `${n}.sol`, `${n}.json`), 'utf8'));
const PORT = 8745, URL = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (ok, what, detail = '') => { results.push(ok); console.log(`[${ok ? ' OK ' : 'FAIL'}] ${what}${detail ? '  ' + detail : ''}`); if (!ok) throw Error(what); };

const anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
const stop = () => { try { anvil.kill(); } catch {} };
try {
  const pub = createPublicClient({ chain: foundry, transport: http(URL) });
  for (let i = 0; i < 50; i++) { try { await pub.getChainId(); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const dev = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'); // anvil #0
  const wal = createWalletClient({ account: dev, chain: foundry, transport: http(URL) });
  const deploy = async (n, args = []) => {
    const a = art(n);
    const hash = await wal.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    return getAddress((await pub.waitForTransactionReceipt({ hash })).contractAddress);
  };
  const V = art('BunkerVault').abi, T = art('MockERC20').abi;
  const vault = await deploy('BunkerVault');
  const token = await deploy('MockERC20', ['Bunker Mode', 'BUNKER', 18]);
  const write = async (address, abi, functionName, args, value) => {
    const hash = await wal.writeContract({ address, abi, functionName, args, value });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw Error(functionName + ' reverted');
    return r;
  };

  // phrase -> master -> id
  const phrase = wots.newPhrase();
  check(phrase.split(' ').length === 24 && wots.isPhrase(phrase), '24-word phrase generated and valid');
  check(!wots.isPhrase(phrase.split(' ').slice(0, 23).join(' ') + ' abandon'), 'corrupted phrase rejected');
  const master = wots.masterOf(phrase);
  let t0 = performance.now();
  const id = wots.accountId(master);
  check(true, 'account id from phrase', `${id} in ${(performance.now() - t0).toFixed(1)} ms`);
  check(wots.masterOf('  ' + phrase.toUpperCase().replace(/ /g, '   ') + ' ').every((b, i) => b === master[i]), 'phrase normalisation (case/spaces) gives the same master');

  await write(token, T, 'mint', [dev.address, 10n ** 27n]);
  await write(vault, V, 'depositETH', [id], parseEther('2'));
  await write(token, T, 'approve', [vault, parseEther('1000')]);
  await write(vault, V, 'deposit', [id, token, parseEther('1000')]);
  check(await pub.readContract({ address: vault, abi: V, functionName: 'balanceOf', args: [id, zeroAddress] }) === parseEther('2'), 'deposited 2 ETH');

  // three rotations, each submitted by a DIFFERENT throwaway wallet (only pays gas)
  const dest = privateKeyToAccount(generatePrivateKey()).address;
  const plan = [
    [{ token: zeroAddress, to: dest, amount: parseEther('0.5') }],
    [{ token, to: dest, amount: parseEther('400') }, { token: zeroAddress, to: dest, amount: parseEther('0.25') }],
    [{ token, to: dest, amount: parseEther('600') }, { token: zeroAddress, to: dest, amount: parseEther('1.25') }],
  ];
  for (const [n, transfers] of plan.entries()) {
    const [key, nonce] = await pub.readContract({ address: vault, abi: V, functionName: 'accounts', args: [id] });
    check(Number(nonce) === n && key === wots.keyHash(master, n), `round ${n + 1}: on-chain key = JS key index ${n}`);
    const nextKey = wots.keyHash(master, n + 1);
    const msg = { chainId: 31337, vault, id, nonce: n, transfers, relayer: zeroAddress, fee: 0n, nextKey };
    const d = wots.digestOf(msg);
    const onchain = await pub.readContract({ address: vault, abi: V, functionName: 'digest', args: [id, transfers, zeroAddress, 0n, nextKey] });
    check(d === onchain, `round ${n + 1}: JS digest = contract digest()`);
    t0 = performance.now();
    const sig = wots.sign(master, n, d);
    const ms = (performance.now() - t0).toFixed(1);
    check(wots.recover(d, sig) === key, `round ${n + 1}: JS recover = key`, `sign ${ms} ms`);
    check(await pub.readContract({ address: vault, abi: V, functionName: 'wotsPublicKey', args: [d, sig] }) === key, `round ${n + 1}: contract wotsPublicKey = key`);
    const sub = privateKeyToAccount(generatePrivateKey());
    await wal.sendTransaction({ to: sub.address, value: parseEther('0.01') });
    const subWal = createWalletClient({ account: sub, chain: foundry, transport: http(URL) });
    const hash = await subWal.writeContract({ address: vault, abi: V, functionName: 'execute', args: [id, transfers, zeroAddress, 0n, nextKey, sig] });
    const r = await pub.waitForTransactionReceipt({ hash });
    check(r.status === 'success', `round ${n + 1}: execute by throwaway submitter`, `gas ${r.gasUsed}`);
  }
  check(await pub.getBalance({ address: dest }) === parseEther('2'), 'destination got all 2 ETH');
  check(await pub.readContract({ address: token, abi: T, functionName: 'balanceOf', args: [dest] }) === parseEther('1000'), 'destination got all 1000 BUNKER');
  check(await pub.readContract({ address: vault, abi: V, functionName: 'spentKey', args: [wots.keyHash(master, 2)] }), 'key 2 burned');

  // an old signature cannot be replayed with the new key
  const d0 = wots.digestOf({ chainId: 31337, vault, id, nonce: 0, transfers: plan[0], relayer: zeroAddress, fee: 0n, nextKey: wots.keyHash(master, 1) });
  let reverted = false;
  try { await pub.simulateContract({ address: vault, abi: V, functionName: 'execute', account: dev, args: [id, plan[0], zeroAddress, 0n, wots.keyHash(master, 4), wots.sign(master, 0, d0)] }); } catch { reverted = true; }
  check(reverted, 'old key-0 signature rejected after rotation');
  console.log(`\n${results.length}/${results.length} checks passed`);
} catch (e) {
  console.error('\nFAILED:', e.shortMessage || e.message); process.exitCode = 1;
} finally { stop(); }
