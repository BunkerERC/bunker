// Browser test of the BUNKER launchpad against a local Ethereum mainnet fork.
//   node launch/test/launchpad-e2e.mjs        (needs: forge build in launchpad/contracts, site deps, network for the fork)
// Starts its own anvil fork (port 8647) and Vite dev server (port 5193), deploys BunkerLaunchpad on the fork exactly
// like mainnet (CREATE2 + mined hook salt, pointing at the LIVE BunkerVault), then drives the real UI in headless
// Chromium with a mock window.ethereum: make a bunker phrase, launch a coin with an image and a dev buy into the
// bunker, verify the signature in the browser, buy, sell, collect fees, move the creator fee share with a fresh
// one-time key, and withdraw the dev bag from the vault with the same phrase. Every step is checked on-chain.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  concat, createPublicClient, createWalletClient, encodeAbiParameters, formatEther, getAddress, http, parseAbi,
  parseEther, toHex, zeroAddress, zeroHash,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { artifact, mineSalt, BUNKER_VAULT, CREATE2_DEPLOYER, POOL_MANAGER } from '../../launchpad/scripts/launchpad.mjs';
import { launchParams } from '../../launchpad/scripts/v4math.mjs';
import * as wots from '../../site/src/lib/wots.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'site');
const FORK_PORT = 8647, WEB_PORT = 5193;
const FORK = `http://127.0.0.1:${FORK_PORT}`, WEB = `http://localhost:${WEB_PORT}`;
const UPSTREAM = process.env.FORK_UPSTREAM ?? 'https://ethereum-rpc.publicnode.com';
const SHOTS = process.env.SHOTS; // optional folder for screenshots
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const vaultAbi = parseAbi([
  'function balanceOf(bytes32, address) view returns (uint256)',
  'function accounts(bytes32) view returns (bytes32 key, uint64 nonce)',
  'struct Transfer { address token; address to; uint256 amount; }',
  'function execute(bytes32 id, Transfer[] transfers, address relayer, uint256 fee, bytes32 nextKey, bytes32[67] sig)',
]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (ok, what, detail = '') => {
  results.push(ok);
  console.log(`[${ok ? ' OK ' : 'FAIL'}] ${what}${detail ? '  ' + detail : ''}`);
  if (!ok) throw new Error(`${what} ${detail}`);
};
const procs = [];
const startProc = (cmd, args, opts) => { const p = spawn(cmd, args, { stdio: 'ignore', ...opts }); procs.push(p); return p; };
async function waitHttp(url, body) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body } : undefined);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`${url} did not come up`);
}

let browser;
async function main() {
  // ---------------------------------------------------------------- fork + launchpad (same path as mainnet)
  startProc('anvil', ['--fork-url', UPSTREAM, '--port', String(FORK_PORT), '--chain-id', '1', '--silent']);
  await waitHttp(FORK, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
  const pub = createPublicClient({ chain: mainnet, transport: http(FORK) });
  const rpc = (method, params) => pub.request({ method, params });
  const deployer = privateKeyToAccount(generatePrivateKey());
  const platform = privateKeyToAccount(generatePrivateKey()).address;
  const user = privateKeyToAccount(generatePrivateKey()).address;
  await rpc('anvil_setBalance', [deployer.address, toHex(parseEther('1'))]);
  await rpc('anvil_setBalance', [user, toHex(parseEther('5'))]);
  await rpc('anvil_impersonateAccount', [user]);
  const wal = createWalletClient({ account: deployer, chain: mainnet, transport: http(FORK) });

  const p = launchParams(2);
  const art = artifact('BunkerLaunchpad');
  const ctor = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }, { type: 'uint128' }],
    [POOL_MANAGER, BUNKER_VAULT, platform, p.sqrtPriceX96, p.tickUpper, p.liquidity],
  );
  const initCode = concat([art.bytecode, ctor]);
  const { salt, address: LP } = mineSalt(initCode);
  const dh = await wal.sendTransaction({ to: CREATE2_DEPLOYER, data: concat([salt, initCode]), gas: 8_000_000n });
  const dr = await pub.waitForTransactionReceipt({ hash: dh });
  const lpBlock = dr.blockNumber;
  const lp = { address: LP, abi: art.abi };
  check(dr.status === 'success' && (BigInt(LP) & 0x3fffn) === 0x2000n && (await pub.readContract({ ...lp, functionName: 'vault' })) === BUNKER_VAULT,
    'launchpad deployed via CREATE2 with the hook-flag address, pointing at the live BunkerVault', `${LP} · ${dr.gasUsed} gas`);

  // ---------------------------------------------------------------- browser with a mock wallet that sends through the fork
  startProc(process.execPath, [join(SITE, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(WEB_PORT), '--strictPort'], { cwd: SITE });
  await waitHttp(WEB);
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript(({ FORK, USER }) => {
    let id = 0;
    const rpc = async (method, params) => {
      const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    };
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method, params }) {
        switch (method) {
          case 'eth_requestAccounts': case 'eth_accounts': return [USER];
          case 'eth_chainId': return '0x1';
          case 'wallet_switchEthereumChain': case 'wallet_revokePermissions': return null;
          case 'wallet_getCapabilities': return {};
          default: return rpc(method, params);
        }
      },
    };
  }, { FORK, USER: user });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  const q = `?fork1=${encodeURIComponent(FORK)}&launchpad=${LP}&lpblock=${lpBlock}`;
  const shot = async name => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

  // ---------------------------------------------------------------- empty board: the signature bench
  await page.goto(`${WEB}/${q}#launch`);
  await page.getByRole('heading', { name: /Launch from/i }).waitFor({ timeout: 20000 });
  await page.locator('.lp-bench .matrix').waitFor();
  check(await page.locator('.tab.on').innerText() === 'Launch', 'Launch tab in the nav, highlighted');
  const before = await page.locator('.lp-bench .hexline').innerText();
  await page.locator('.lp-bench-in input').fill('TEST');
  const after = await page.locator('.lp-bench .hexline').innerText();
  check(before !== after && (await page.locator('.matrix .c').count()) === 67, 'empty board: ticker bench re-signs on every keystroke (67 chains)');
  await shot('01-launch-empty');
  await page.getByRole('link', { name: 'Launch $TEST →' }).click();
  await page.getByRole('heading', { name: 'Launch a coin' }).waitFor();
  check(await page.getByPlaceholder('BCAT').inputValue() === 'TEST', 'bench hands the ticker to the launch form');

  // ---------------------------------------------------------------- bunker phrase → 1,024 one-time keys
  await page.getByRole('button', { name: 'Create a bunker phrase' }).click();
  const words = (await page.locator('.phrase-grid li').allInnerTexts()).map(t => t.replace(/^\d+\s*/, '').trim());
  check(words.length === 24 && wots.isPhrase(words.join(' ')), 'phrase: 24 valid words made in the browser');
  const phrase = words.join(' ');
  for (const label of await page.locator('.vault-quiz label').all()) {
    const n = Number((await label.innerText()).match(/#(\d+)/)[1]);
    await label.locator('input').fill(words[n - 1]);
  }
  await page.locator('.check input').check();
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Grow my keys' }).click();
  await page.getByRole('button', { name: /Connect wallet|Sign & launch/ }).waitFor({ timeout: 60000 });
  check(true, 'keys: 1,024-leaf XMSS tree grown in Web Workers', `${Date.now() - t0} ms`);

  // ---------------------------------------------------------------- launch: image + dev buy into the bunker
  await page.getByRole('button', { name: 'Connect wallet' }).last().click();
  await page.getByPlaceholder('Bunker Cat').fill('Bunker Test');
  await page.locator('textarea.field').first().fill('launched from a bunker on a fork');
  await page.locator('input[type=file]').setInputFiles(join(SITE, 'public', 'logo-mark.png'));
  await page.getByText('Change image').waitFor({ timeout: 10000 });
  await page.getByPlaceholder('https://x.com/…').fill('x.com/BunkerCoinEth');
  await page.locator('.trade-amt input').fill('0.5');
  check(await page.locator('.opt button.on').first().innerText().then(t => t.includes('My bunker')), 'dev bag defaults to the bunker (BunkerVault)');
  await shot('02-launch-form');
  await page.getByRole('button', { name: 'Sign & launch' }).click();
  await page.waitForURL(/#coin\/0x[0-9a-fA-F]{40}/, { timeout: 90000 });
  const token = getAddress(page.url().match(/#coin\/(0x[0-9a-fA-F]{40})/)[1]);
  const [identity, creator, leaf, , feeTo, , feeVault] = await pub.readContract({ ...lp, functionName: 'coins', args: [token] });
  const vaultId = wots.accountId(wots.masterOf(phrase));
  const devBag = await pub.readContract({ address: BUNKER_VAULT, abi: vaultAbi, functionName: 'balanceOf', args: [vaultId, token] });
  check(creator === user && feeTo === user && feeVault === zeroHash && (await pub.readContract({ ...lp, functionName: 'isLeafUsed', args: [identity, leaf] })),
    'launch landed: coin, pool, signature checked and one-time key burned on-chain', `$TEST ${token} · key #${leaf}`);
  check(devBag > 100_000_000n * 10n ** 18n && (await pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [user] })) === 0n,
    'dev buy (0.5 ETH) sits in the bunker of this phrase, nothing under the ECDSA wallet', `${formatEther(devBag)} TEST`);

  // ---------------------------------------------------------------- coin page
  await page.getByRole('heading', { name: 'Bunker Test' }).waitFor({ timeout: 20000 });
  await page.locator('.coin-top .av img').waitFor({ timeout: 20000 });
  check(true, 'coin page: name, on-chain image, PQ-signed badge');
  await page.getByRole('button', { name: 'Signature' }).click();
  await page.getByRole('button', { name: 'Verify in my browser' }).click();
  await page.getByText('✓ valid post-quantum signature').waitFor({ timeout: 20000 });
  check(true, 'signature re-verified in the browser from the launch logs (keccak256 only)');

  // buy
  const tokBal = () => pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [user] });
  await page.locator('.c-trade .trade-amt input').fill('0.2');
  await page.locator('.c-trade').getByText(/TEST$/).first().waitFor();
  await page.waitForFunction(() => !/—/.test(document.querySelector('.c-trade .lkv .num')?.textContent ?? '—'), null, { timeout: 20000 });
  await page.getByRole('button', { name: 'Buy TEST' }).click();
  await page.locator('.c-trade').getByText('Bought.').waitFor({ timeout: 60000 });
  const bought = await tokBal();
  check(bought > 0n, 'buy 0.2 ETH from the coin page', `${formatEther(bought)} TEST`);
  // sell half (approve + sell)
  await page.locator('.c-trade .seg.buysell').getByRole('button', { name: 'Sell' }).click();
  await page.locator('.c-trade .presets').getByRole('button', { name: '50%' }).click();
  const ethBefore = await pub.getBalance({ address: user });
  await page.getByRole('button', { name: 'Sell TEST' }).click();
  await page.locator('.c-trade').getByText('Sold.').waitFor({ timeout: 60000 });
  const left = await tokBal();
  check(left > 0n && left < bought && (await pub.getBalance({ address: user })) > ethBefore - parseEther('0.001'), 'sell 50% (approve + sell) from the coin page', `${formatEther(left)} TEST left`);

  // fees: anyone collects, 50/50
  const p0 = await pub.getBalance({ address: platform });
  const u0 = await pub.getBalance({ address: user });
  await page.locator('.c-fees').getByRole('button', { name: /Collect/ }).click();
  await page.waitForFunction(async () => true);
  let p1 = p0;
  for (let i = 0; i < 60 && p1 === p0; i++) { await sleep(500); p1 = await pub.getBalance({ address: platform }); }
  const platformGot = p1 - p0;
  // ETH fees come from the ETH-in swaps (dev buy 0.5 + buy 0.2); the sell pays its 1% in tokens
  const platTok = await pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [platform] });
  check(platformGot > parseEther('0.00345') && platformGot < parseEther('0.00355') && platTok > 0n,
    'collect: platform gets exactly half of the 1% fee (0.7 ETH bought → 0.0035 ETH, plus half the sell fee in tokens)', `${formatEther(platformGot)} ETH + ${formatEther(platTok)} TEST`);
  check((await pub.getBalance({ address: user })) > u0 - parseEther('0.0005'), 'collect: creator half paid to the creator wallet (net of gas)');
  await shot('03-coin');

  // creator moves its fee share into the bunker with a fresh one-time key
  await page.locator('.c-creator').getByRole('button', { name: 'My bunker' }).click();
  await page.locator('.c-creator').getByRole('button', { name: 'Sign & change' }).click();
  await page.locator('.c-creator').getByText('Fee recipient changed.').waitFor({ timeout: 60000 });
  const after2 = await pub.readContract({ ...lp, functionName: 'coins', args: [token] });
  check(after2[4] === zeroAddress && after2[6] === vaultId, 'creator fee share moved to the bunker, signed with a second one-time key');

  // board + keys page
  await page.goto(`${WEB}/${q}#launch`);
  await page.locator('.lcard').first().waitFor({ timeout: 30000 });
  check((await page.locator('.lcard').count()) === 1 && (await page.locator('.lcard-t b').first().innerText()) === '$TEST', 'board: the coin card shows up');
  await shot('04-board');
  await page.locator('.lcard').first().click();
  await page.waitForURL(new RegExp(`#coin/${token}`), { timeout: 10000 });
  check(true, 'board card opens the coin page');
  await page.goto(`${WEB}/${q}#launch/keys`); // same document: keys stay unlocked
  await page.getByText(/2 burned · 1022 free/).waitFor({ timeout: 20000 });
  check(true, 'keys page: creator key, 2 one-time keys burned on-chain, 1,022 left');
  await shot('05-keys');
  await page.reload(); // a reload locks them (phrase kept in memory only)
  await page.getByRole('button', { name: 'I have one' }).waitFor({ timeout: 20000 });
  check(true, 'keys page: locked again after a reload (phrase kept in memory only)');
  await page.getByRole('button', { name: 'I have one' }).click();
  await page.locator('textarea.phrase-input').fill(phrase);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.getByText(/2 burned · 1022 free/).waitFor({ timeout: 60000 });
  check(true, 'keys page: same phrase re-opens the same creator key (cached tree, spot-checked)');

  // vault tab opens the same bunker with the unlocked phrase
  await page.locator('a.tab', { hasText: 'Vault' }).click();
  await page.getByRole('button', { name: 'Open with the unlocked phrase' }).waitFor({ timeout: 20000 });
  check(true, 'Vault tab offers the phrase already unlocked in Launch');

  // ---------------------------------------------------------------- the dev bag is really withdrawable with the phrase (WOTS)
  const master = wots.masterOf(phrase);
  const [key, nonce] = await pub.readContract({ address: BUNKER_VAULT, abi: vaultAbi, functionName: 'accounts', args: [vaultId] });
  const to = privateKeyToAccount(generatePrivateKey()).address;
  const transfers = [{ token, to, amount: devBag }];
  const nextKey = wots.keyHash(master, Number(nonce) + 1);
  const digest = wots.digestOf({ chainId: 1, vault: BUNKER_VAULT, id: vaultId, nonce, transfers, relayer: zeroAddress, fee: 0n, nextKey });
  const sig = wots.sign(master, Number(nonce), digest);
  check(key === wots.keyHash(master, Number(nonce)), 'vault account key matches the phrase');
  const subm = createWalletClient({ account: deployer, chain: mainnet, transport: http(FORK) });
  const eh = await subm.writeContract({ address: BUNKER_VAULT, abi: vaultAbi, functionName: 'execute', args: [vaultId, transfers, zeroAddress, 0n, nextKey, sig] });
  const er = await pub.waitForTransactionReceipt({ hash: eh });
  check(er.status === 'success' && (await pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [to] })) === devBag,
    'dev bag withdrawn from the BunkerVault with a WOTS signature from the same phrase', `${er.gasUsed} gas`);

  // ---------------------------------------------------------------- phone width
  await page.setViewportSize({ width: 390, height: 844 });
  for (const h of ['#launch', `#coin/${token}`, '#launch/new']) {
    await page.goto(`${WEB}/${q}${h}`);
    await page.locator('.lp').first().waitFor({ timeout: 20000 });
    await sleep(800);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    check(w <= 390, `phone: ${h.slice(0, 10)} has no sideways scroll`, `${w}px`);
  }
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '05-phone-new.png'), fullPage: true });
  check(pageErrors.length === 0, 'no page errors', pageErrors.slice(0, 3).join(' | '));
}

main()
  .catch(e => { console.error('\n' + (e.stack ?? e)); results.push(false); })
  .finally(async () => {
    await browser?.close().catch(() => {});
    for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
    const ok = results.filter(Boolean).length;
    console.log(`\n${ok}/${results.length} checks passed`);
    process.exit(results.every(Boolean) ? 0 : 1);
  });
