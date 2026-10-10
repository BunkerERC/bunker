// Browser test of "swap inside the bunker" and gasless sends, against a local Ethereum mainnet fork.
//   node launch/test/swap-site-e2e.mjs        (needs: forge build in contracts, site deps, network for the fork)
// Starts its own anvil fork (port 8661), deploys BunkerSwap with launch/swap.mjs, runs the real relayer
// (launch/swap.mjs relayer, port 8662) and a Vite dev server (port 5194), then drives the real UI in headless
// Chromium against the LIVE BunkerVault and the real $BUNKER pool: once with a (mock) wallet, once with NO wallet
// at all. Every step is checked on-chain.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createPublicClient, createWalletClient, formatEther, getAddress, http, parseAbi, parseEther, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'site');
const FORK_PORT = 8661, RELAY_PORT = 8662, WEB_PORT = 5194;
const FORK = `http://127.0.0.1:${FORK_PORT}`, RELAY = `http://127.0.0.1:${RELAY_PORT}`, WEB = `http://localhost:${WEB_PORT}`;
const UPSTREAM = process.env.FORK_UPSTREAM ?? 'https://ethereum-rpc.publicnode.com';
const SHOTS = process.env.SHOTS; // optional folder for screenshots
const VAULT = '0x39C71b635409b1f98dc632e08d3B29515ddb2727';
const BUNKER = '0xBDC4cE7c4718d20498e7D549751FF336690eb6D7';
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const vaultAbi = parseAbi(['function balanceOf(bytes32, address) view returns (uint256)', 'function accounts(bytes32) view returns (bytes32 key, uint64 nonce)']);
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
const keysDir = mkdtempSync(join(tmpdir(), 'bunker-swap-site-'));

let browser;
async function main() {
  // ---------------------------------------------------------------- fork, BunkerSwap, relayer
  startProc('anvil', ['--fork-url', UPSTREAM, '--port', String(FORK_PORT), '--chain-id', '1', '--silent']);
  await waitHttp(FORK, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
  const pub = createPublicClient({ chain: mainnet, transport: http(FORK) });
  const rpc = (method, params) => pub.request({ method, params });
  const ownerKey = generatePrivateKey(), relayKey = generatePrivateKey(); // throwaway keys, fork only
  const relayer = privateKeyToAccount(relayKey).address;
  const platform = privateKeyToAccount(generatePrivateKey()).address;
  const user = privateKeyToAccount(generatePrivateKey()).address;
  writeFileSync(join(keysDir, 'owner.txt'), ownerKey + '\n');
  writeFileSync(join(keysDir, 'relayer.key'), relayKey + '\n');
  await rpc('anvil_setBalance', [privateKeyToAccount(ownerKey).address, toHex(parseEther('1'))]);
  await rpc('anvil_setBalance', [user, toHex(parseEther('10'))]);
  await rpc('anvil_setBalance', [relayer, toHex(parseEther('0.01'))]);
  await rpc('anvil_impersonateAccount', [user]);
  const dep = spawnSync(process.execPath, ['launch/swap.mjs', 'deploy', '--rpc', FORK, '--keys', keysDir, '--platform', platform], { cwd: ROOT, encoding: 'utf8' });
  const SWAP = getAddress(JSON.parse(readFileSync(join(keysDir, 'swap-fork.json'), 'utf8')).swap);
  check(dep.status === 0, 'BunkerSwap deployed on the fork for the live vault', SWAP);
  startProc(process.execPath, ['launch/swap.mjs', 'relayer', '--rpc', FORK, '--key', join(keysDir, 'relayer.key'), '--swap', SWAP, '--token', BUNKER,
    '--port', String(RELAY_PORT), '--min-balance', '0.001', '--rate-ip', '60', '--rate-id', '60', '--free-cap', '0.002'], { cwd: ROOT });
  await waitHttp(`${RELAY}/info`);

  const bal = (who, token) => (token ? pub.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [who] }) : pub.getBalance({ address: who }));
  const fresh = () => privateKeyToAccount(generatePrivateKey()).address;

  // ---------------------------------------------------------------- browser with a mock wallet
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
          case 'eth_sendTransaction':
            if (localStorage.getItem('mock-reject-next')) {
              localStorage.removeItem('mock-reject-next');
              throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
            }
            return rpc(method, params);
          default: return rpc(method, params);
        }
      },
    };
  }, { FORK, USER: user });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  const q = `?fork1=${encodeURIComponent(FORK)}&swap=${SWAP}&relay=${encodeURIComponent(RELAY)}`;
  const shot = async (pg, name) => { if (SHOTS) await pg.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

  // ---------------------------------------------------------------- a bunker with 3 ETH
  await page.goto(`${WEB}/${q}#vault`);
  await page.getByRole('button', { name: 'Create a bunker' }).click();
  const words = (await page.locator('.phrase-grid li').allInnerTexts()).map(t => t.replace(/^\d+\s*/, '').trim());
  const labels = await page.locator('.vault-quiz label').allInnerTexts();
  for (let i = 0; i < 2; i++) await page.locator('.vault-quiz input').nth(i).fill(words[Number(labels[i].match(/#(\d+)/)[1]) - 1]);
  await page.getByText('I wrote all 24 words down offline').click();
  await page.getByRole('button', { name: 'Open my bunker' }).click();
  await page.getByText(/empty: deposit to open it/).waitFor({ timeout: 30000 });
  const id = await page.locator('.vault-head code').getAttribute('title');
  check(await page.locator('.swap-card').count() === 0, 'no swap card while the bunker is empty');
  const depCard = page.locator('.vault-card').filter({ hasText: 'Deposit' });
  await depCard.locator('input.field').fill('3');
  await depCard.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('button', { name: 'Deposit to bunker' }).click();
  await page.getByText('Deposited 3 ETH.').waitFor({ timeout: 60000 });
  const inBunker = token => pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'balanceOf', args: [id, token ?? zeroAddress] });
  const nonce = async () => Number((await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: 'accounts', args: [id] }))[1]);

  // ---------------------------------------------------------------- buy, the wallet only pays gas
  const sw = () => page.locator('.swap-card');
  const wd = () => page.locator('.vault-card').filter({ has: page.getByPlaceholder(/destination address/) });
  await sw().waitFor({ timeout: 20000 });
  check(await sw().locator('select[aria-label=token] option').first().innerText() === 'BUNKER', 'swap card: appears once the bunker holds funds, $BUNKER first in the list');
  await sw().getByLabel('amount').fill('1');
  await sw().getByText(/≈ [\d,.]+ BUNKER/).waitFor({ timeout: 30000 });
  const qtext = (await sw().locator('.swap-q').innerText()).replace(/\s+/g, ' ');
  check(/Uniswap v4, 1% pool/.test(qtext) && /Swap fee 0\.5% 0\.005 ETH/.test(qtext) && /At least [\d,.]+ BUNKER/.test(qtext), 'quote: amount out, minimum, 0.5% fee and the pool are shown before signing', qtext);
  check(await sw().locator('.send-mode .seg button.on').innerText() === 'My wallet pays gas', 'with a wallet connected the default is "my wallet pays gas"');
  await shot(page, '01-swap-quote');
  const userBunkerBefore = await bal(user, BUNKER);
  await sw().getByRole('button', { name: /Sign with key #0 & swap/ }).click();
  await sw().getByText(/^Done\. 1 ETH for about/).waitFor({ timeout: 90000 });
  const got = await inBunker(BUNKER);
  check(got > 0n && (await inBunker()) === parseEther('2') && (await nonce()) === 1, 'buy: 1 ETH left the bunker and BUNKER landed back in it; key rotated to #1', `${Number(formatEther(got)).toFixed(0)} BUNKER`);
  check((await bal(user, BUNKER)) === userBunkerBefore && (await bal(platform)) === parseEther('0.005'), 'the submitting wallet got no tokens; 0.5% went to the platform wallet');
  const hold = page.locator('.vault-card').filter({ hasText: 'Holdings' });
  await hold.getByText('BUNKER').waitFor({ timeout: 20000 });
  check(/ETH\s+2\b/.test(await hold.innerText()), 'holdings: 2 ETH + BUNKER shown', (await hold.innerText()).replace(/\s+/g, ' '));

  // ---------------------------------------------------------------- a signed swap that does not land: nothing else may be signed
  await sw().getByLabel('amount').fill('0.5');
  await sw().getByText(/≈ [\d,.]+ BUNKER/).waitFor({ timeout: 30000 });
  await page.evaluate(() => localStorage.setItem('mock-reject-next', '1'));
  await sw().getByRole('button', { name: /Sign with key #1 & swap/ }).click();
  await page.getByText('You rejected it in the wallet.').waitFor({ timeout: 30000 });
  await sw().getByText('Signed swap, not confirmed yet').waitFor({ timeout: 5000 });
  check(await sw().getByRole('button', { name: /Sign with key #1 & swap/ }).isDisabled() && await wd().getByRole('button', { name: /Sign with key #1/ }).isDisabled(),
    'after a signed-but-unsent swap, key #1 can sign nothing else: swap and send are both locked');
  check(/already signed a swap/.test(await wd().innerText()), 'the send card says why');
  await shot(page, '02-swap-pending');
  // the relayer will not swap it (it names the wallet as its submitter)...
  await sw().getByRole('button', { name: /Try again \(gasless\)/ }).click();
  await sw().getByText(/locked to another submitter/).waitFor({ timeout: 20000 });
  check((await nonce()) === 1, 'a swap signed for my wallet can not be filled by anyone else');
  // ...but once its 10 minutes are up, anyone may hand it back
  const ethBefore = await inBunker();
  const relayBefore = await bal(relayer);
  await rpc('evm_increaseTime', [700]);
  await rpc('evm_mine', []);
  await sw().getByRole('button', { name: /\(gasless\)/ }).click();
  await sw().getByText(/The order had expired, so nothing was swapped/).waitFor({ timeout: 60000 }).catch(async e => { console.log('DEBUG msgs:', JSON.stringify(await sw().locator('p').allInnerTexts()), 'nonce', await nonce(), 'relayer info', JSON.stringify(await (await fetch(RELAY + '/info')).json()).slice(0, 200)); throw e; });
  check((await nonce()) === 2 && (await inBunker()) === ethBefore && (await inBunker(BUNKER)) === got, 'expired swap: the same signature handed everything back and freed the key', 'key #2');
  check((await bal(relayer)) < relayBefore, '...the relayer paid for that trip itself (this order carried no tip)');
  await page.getByText(/live · key #2/).waitFor({ timeout: 20000 });

  // ---------------------------------------------------------------- gasless sell
  await sw().getByRole('button', { name: 'Sell', exact: true }).click();
  await sw().getByRole('button', { name: 'max' }).click();
  await sw().getByRole('button', { name: 'Gasless' }).click();
  await sw().getByText(/≈ [\d.]+ ETH/).waitFor({ timeout: 30000 });
  check(/Relayer 0\.\d+ ETH/.test((await sw().locator('.swap-q').innerText()).replace(/\s+/g, ' ')), 'gasless: the relayer\'s cut is shown before signing', (await sw().locator('.swap-q').innerText()).replace(/\s+/g, ' '));
  const relayBefore2 = await bal(relayer), userEth = await bal(user), eth2 = await inBunker();
  await sw().getByRole('button', { name: /Sign with key #2 & swap/ }).click();
  await sw().getByText(/^Done\. .* BUNKER for about/).waitFor({ timeout: 90000 });
  check((await inBunker(BUNKER)) === 0n && (await inBunker()) > eth2 + parseEther('0.9'), 'gasless sell: all BUNKER sold, ETH credited to the bunker', `+${formatEther((await inBunker()) - eth2)} ETH`);
  check((await bal(user)) === userEth && (await bal(relayer)) > relayBefore2, 'gasless sell: my wallet sent nothing and paid nothing; the relayer was paid from the swap');
  await shot(page, '03-after-sell');
  await ctx.close();

  // ---------------------------------------------------------------- no wallet at all
  const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', e => pageErrors.push(e.message));
  await p2.goto(`${WEB}/${q}#vault?buy=${BUNKER}`);
  check(await p2.evaluate(() => typeof window.ethereum === 'undefined'), 'second browser: no wallet installed');
  await p2.getByRole('button', { name: 'Open my bunker' }).click();
  await p2.locator('textarea').fill(words.join(' '));
  await p2.getByRole('button', { name: 'Open', exact: true }).click();
  await p2.getByText(/live · key #3/).waitFor({ timeout: 30000 });
  const sw2 = () => p2.locator('.swap-card');
  const wd2 = () => p2.locator('.vault-card').filter({ has: p2.getByPlaceholder(/destination address/) });
  await sw2().waitFor({ timeout: 20000 });
  check(await sw2().locator('.send-mode .seg button.on').innerText() === 'Gasless', 'without a wallet the default is gasless');
  await sw2().getByLabel('amount').fill('1');
  await sw2().getByText(/≈ [\d,.]+ BUNKER/).waitFor({ timeout: 30000 });
  await sw2().getByRole('button', { name: /Sign with key #3 & swap/ }).click();
  await sw2().getByText(/^Done\. 1 ETH for about/).waitFor({ timeout: 90000 });
  const got2 = await inBunker(BUNKER);
  check(got2 > 0n && (await nonce()) === 4, 'no wallet: bought BUNKER inside the bunker', `${Number(formatEther(got2)).toFixed(0)} BUNKER`);
  await shot(p2, '04-no-wallet-buy');

  // gasless send of everything to an address that never held gas
  const dest = fresh();
  await p2.getByText(/live · key #4/).waitFor({ timeout: 20000 });
  await p2.waitForTimeout(800);
  await wd2().getByPlaceholder(/destination address/).fill(dest);
  check(await wd2().locator('.send-mode .seg button.on').innerText() === 'Gasless' && /Relayer fee: 0\.\d+ ETH/.test(await wd2().innerText()), 'send card: gasless by default, fee shown');
  const ethLeft = await inBunker();
  await wd2().getByRole('button', { name: /Sign with key #4 & send/ }).click();
  await wd2().getByText(/Key #4 burned/).waitFor({ timeout: 90000 });
  const destEth = await bal(dest);
  check((await bal(dest, BUNKER)) === got2 && destEth > 0n && destEth < ethLeft && ethLeft - destEth < parseEther('0.002') && (await inBunker()) === 0n && (await inBunker(BUNKER)) === 0n,
    'no wallet: everything left the bunker to a fresh address; only the relayer fee came off', `fee ${formatEther(ethLeft - destEth)} ETH`);
  check(/The relayer took 0\.\d+ ETH, out of the ETH you sent/.test(await wd2().innerText()), 'the page says what the relayer took');
  await shot(p2, '05-no-wallet-send');

  // ---------------------------------------------------------------- phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const p3 = await phone.newPage();
  p3.on('pageerror', e => pageErrors.push(e.message));
  // put 0.5 ETH back in so the swap card is on screen
  const node = createWalletClient({ account: user, chain: mainnet, transport: http(FORK) }); // anvil signs for the impersonated user
  await pub.waitForTransactionReceipt({ hash: await node.writeContract({ address: VAULT, abi: parseAbi(['function depositETH(bytes32 id) payable']), functionName: 'depositETH', args: [id], value: parseEther('0.5') }) });
  await p3.goto(`${WEB}/${q}#vault`);
  await p3.getByRole('button', { name: 'Open my bunker' }).click();
  await p3.locator('textarea').fill(words.join(' '));
  await p3.getByRole('button', { name: 'Open', exact: true }).click();
  await p3.getByText(/live · key #5/).waitFor({ timeout: 30000 });
  await p3.locator('.swap-card').getByLabel('amount').fill('0.1');
  await p3.locator('.swap-card').getByText(/≈ [\d,.]+ BUNKER/).waitFor({ timeout: 30000 });
  const wide = await p3.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, 'phone 390px: vault with the swap card, no sideways scroll', `${wide}px`);
  await shot(p3, '06-phone');

  check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.join(' | '));
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
}

main().catch(e => { console.error('\nFAILED:', e.message); process.exitCode = 1; }).finally(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  for (const p of procs) { try { p.kill(); } catch { /* ignore */ } }
  try { rmSync(keysDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
