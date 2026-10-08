// HEAD-TO-TOE browser test of the BUNKER site against a local Ethereum mainnet fork.
//   node launch/test/site-e2e.mjs            (needs: forge build done, site deps installed, network for the fork)
// Starts its own anvil fork (port 8646) and Vite dev server (port 5192), deploys BunkerToken + BunkerVault on the
// fork, funds a test wallet, and drives the real UI in headless Chromium with a mock window.ethereum that sends
// through the fork (anvil impersonation). Every money flow is checked on-chain. Only its own processes are stopped.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  createPublicClient, createWalletClient, http, parseEther, getAddress, keccak256, encodeAbiParameters, toHex,
  parseAbi, formatEther, formatUnits,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { mainnet } from 'viem/chains';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'site');
const FORK_PORT = 8646, WEB_PORT = 5192;
const FORK = `http://127.0.0.1:${FORK_PORT}`, WEB = `http://localhost:${WEB_PORT}`;
const UPSTREAM = process.env.FORK_UPSTREAM ?? 'https://ethereum-rpc.publicnode.com';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const art = n => JSON.parse(readFileSync(join(ROOT, 'contracts', 'out', `${n}.sol`, `${n}.json`), 'utf8'));
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const vaultAbi = art('BunkerVault').abi;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (ok, what, detail = '') => {
  results.push(ok);
  console.log(`[${ok ? ' OK ' : 'FAIL'}] ${what}${detail ? '  ' + detail : ''}`);
  if (!ok) throw new Error(`${what} ${detail}`);
};
const reverts = async fn => { try { await fn(); return false; } catch { return true; } };
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
  // ---------------------------------------------------------------- fork + contracts + funded test wallet
  startProc('anvil', ['--fork-url', UPSTREAM, '--port', String(FORK_PORT), '--chain-id', '1', '--silent']);
  await waitHttp(FORK, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
  const pub = createPublicClient({ chain: mainnet, transport: http(FORK) });
  const rpc = (method, params) => pub.request({ method, params });
  const deployer = privateKeyToAccount(generatePrivateKey());
  const user = privateKeyToAccount(generatePrivateKey()).address;
  await rpc('anvil_setBalance', [deployer.address, toHex(parseEther('1'))]);
  const wal = createWalletClient({ account: deployer, chain: mainnet, transport: http(FORK) });
  const deploy = async (n, args = []) => {
    const a = art(n);
    const hash = await wal.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    return getAddress((await pub.waitForTransactionReceipt({ hash })).contractAddress);
  };
  const token = await deploy('MockERC20', ['Bunker Mode', 'BUNKER', 18]); // stands in for BUNKER: the real token mints to itself
  await pub.waitForTransactionReceipt({ hash: await wal.writeContract({ address: token, abi: art('MockERC20').abi, functionName: 'mint', args: [user, 10n ** 27n] }) });
  const vault = await deploy('BunkerVault');
  const vaultBlock = await pub.getBlockNumber();
  const usdcSlot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [user, 9n]));
  const fund = async (eth, usdc) => {
    await rpc('anvil_setBalance', [user, toHex(parseEther(eth))]);
    await rpc('anvil_setStorageAt', [USDC, usdcSlot, toHex(usdc * 1_000_000n, { size: 32 })]);
  };
  await fund('3', 1000n);
  await rpc('anvil_impersonateAccount', [user]);
  const bal = async (addr, t) => (t ? pub.readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [addr] }) : pub.getBalance({ address: addr }));
  check(await bal(user, USDC) === 1_000_000_000n, 'fork ready: token + vault deployed, test wallet funded', `vault ${vault}`);

  // ---------------------------------------------------------------- site
  startProc(process.execPath, [join(SITE, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(WEB_PORT), '--strictPort'], { cwd: SITE });
  await waitHttp(WEB);
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript(({ FORK, USER }) => {
    let id = 0; const batches = {};
    const rpc = async (method, params) => {
      const r = await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    };
    const receipt = async h => { for (let i = 0; i < 300; i++) { const r = await rpc('eth_getTransactionReceipt', [h]); if (r) return r; await new Promise(s => setTimeout(s, 100)); } throw new Error('no receipt'); };
    window.__log = [];
    window.ethereum = {
      on() {}, removeListener() {},
      async request({ method, params }) {
        window.__log.push(method);
        switch (method) {
          case 'eth_requestAccounts': case 'eth_accounts': return [USER];
          case 'eth_chainId': return '0x1';
          case 'wallet_switchEthereumChain': case 'wallet_revokePermissions': return null;
          case 'wallet_getCapabilities': return localStorage.getItem('mock-atomic') === '1' ? { '0x1': { atomic: { status: 'supported' } } } : {};
          case 'wallet_sendCalls': {
            const receipts = [];
            for (const c of params[0].calls) { const h = await rpc('eth_sendTransaction', [{ from: USER, to: c.to, data: c.data, value: c.value }]); const r = await receipt(h); receipts.push({ transactionHash: h, status: r.status }); }
            const cid = 'b' + (++id); batches[cid] = receipts; return { id: cid };
          }
          case 'wallet_getCallsStatus': { const rs = batches[params[0]]; return { status: rs.every(r => r.status === '0x1') ? 200 : 500, receipts: rs }; }
          case 'eth_sendTransaction':
            if (localStorage.getItem('mock-reject-next') === '1') { localStorage.removeItem('mock-reject-next'); throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
            return rpc(method, params);
          default: return rpc(method, params);
        }
      },
    };
  }, { FORK, USER: user });
  const page = await ctx.newPage();
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const q = `?fork1=${encodeURIComponent(FORK)}&vault=${vault}&token=${token}&vaultblock=${vaultBlock}`;
  const fresh = () => privateKeyToAccount(generatePrivateKey()).address;

  // ---------------------------------------------------------------- home: ticker + board
  await page.goto(`${WEB}/${q}#scan`);
  await page.locator('.ticker').getByText(/\$\d/).first().waitFor({ timeout: 20000 });
  await page.locator('.ticker').getByText(/#\d/).waitFor({ timeout: 20000 });
  check(true, 'ticker: live ETH price + block', (await page.locator('.ticker-in').innerText()).replace(/\s+/g, ' ').slice(0, 80));
  await page.locator('.wtbl tbody tr.r').first().waitFor({ timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.wtbl tbody tr.r .state')].every(e => !e.classList.contains('dim')), null, { timeout: 45000 });
  const boardRows = await page.locator('.wtbl tbody tr.r').count();
  const stat = await page.locator('.stats').innerText();
  check(boardRows === 20 && /\d+\/20/.test(stat), 'board: 20 largest plain-key holders, every row classified', stat.replace(/\s+/g, ' '));

  // ---------------------------------------------------------------- scan: every address type
  const freshEvm = fresh();
  const list = ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', freshEvm,
    'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', 'not-an-address'];
  await page.locator('.scan-input').fill(list.join(', '));
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await page.locator('.results .grp').nth(5).waitFor({ timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.results .grp-head .chip.pending').length === 0, null, { timeout: 60000 });
  const heads = await page.locator('.results .grp-head').allInnerTexts();
  const verdict = i => (heads[i].match(/(exposed|hidden|check|invalid)/) ?? [])[1];
  check(verdict(0) === 'exposed', 'scan: vitalik.eth = exposed');
  check(verdict(1) === 'hidden', 'scan: fresh random EVM address = hidden');
  check(verdict(2) === 'exposed', 'scan: Taproot (bc1p) = exposed by design');
  check(verdict(3) === 'exposed', 'scan: reused bc1q (spent before) = exposed');
  check(verdict(4) === 'exposed', 'scan: Solana = always exposed');
  check(verdict(5) === 'invalid', 'scan: garbage input flagged invalid');
  check(page.url().includes('#scan?a='), 'scan: shareable URL updated');
  await page.locator('.wtbl tbody tr.r').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.results .grp').length === 1, null, { timeout: 10000 });
  check(true, 'board row click scans that holder');

  // ---------------------------------------------------------------- move: sequential
  await page.goto(`${WEB}/${q}#move`);
  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.locator('.asset-row', { hasText: 'USDC' }).waitFor({ timeout: 30000 });
  await page.getByPlaceholder('+ token address on Ethereum').fill(token);
  await page.locator('.addtok').first().getByRole('button', { name: 'add' }).click();
  await page.locator('.asset-row', { hasText: 'BUNKER' }).waitFor({ timeout: 20000 });
  for (const cb of await page.locator('.asset-row input[type=checkbox]').all()) if (!(await cb.isChecked())) await cb.check();
  let dest = fresh();
  await page.getByPlaceholder(/NEW address/).fill(user);
  await page.getByText('That is the source wallet').waitFor({ timeout: 5000 });
  check(true, 'move: refuses the source wallet as destination');
  await page.getByPlaceholder(/NEW address/).fill('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  await page.getByText(/Already signed on|Has code on/).waitFor({ timeout: 30000 });
  check(true, 'move: refuses a destination that already signed');
  await page.getByPlaceholder(/NEW address/).fill(dest);
  await page.getByText('Valid bunker').waitFor({ timeout: 30000 });
  await page.locator('select[aria-label="Send mode"]').first().selectOption('sequential');
  await page.getByRole('button', { name: /Move to bunker/ }).first().click();
  await page.getByText(/Moved \(one tx per asset\)/).waitFor({ timeout: 120000 });
  check(await bal(dest, USDC) === 1_000_000_000n && await bal(dest, token) === 10n ** 27n && await bal(user) < parseEther('0.001') && await bal(dest) > parseEther('2.99'),
    'move (one tx per asset): USDC + BUNKER + ETH landed, source left with dust', `dust ${formatEther(await bal(user))} ETH`);

  // ---------------------------------------------------------------- move: EIP-5792 batch
  await fund('2', 500n);
  await page.evaluate(() => localStorage.setItem('mock-atomic', '1'));
  await page.reload();
  await page.locator('.asset-row', { hasText: 'USDC' }).waitFor({ timeout: 30000 });
  dest = fresh();
  await page.getByPlaceholder(/NEW address/).fill(dest);
  await page.getByText('Valid bunker').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /Move to bunker/ }).first().click();
  await page.getByText(/Moved \(one atomic batch\)/).waitFor({ timeout: 120000 });
  check(await bal(dest, USDC) === 500_000_000n && await bal(user) < parseEther('0.002') && await bal(dest) > parseEther('1.99'),
    'move (atomic batch): USDC + ETH landed in one wallet confirmation', `dust ${formatEther(await bal(user))} ETH`);
  await page.evaluate(() => localStorage.removeItem('mock-atomic'));

  // ---------------------------------------------------------------- vault
  await fund('1', 300n);
  await page.goto(`${WEB}/${q}#vault`);
  await page.getByRole('button', { name: 'Create a bunker' }).click();
  const words = (await page.locator('.phrase-grid li').allInnerTexts()).map(t => t.replace(/^\d+\s*/, '').trim());
  check(words.length === 24 && new Set(words).size >= 20, 'vault: 24-word phrase shown');
  await page.getByRole('button', { name: 'Open my bunker' }).isDisabled().then(d => check(d, 'vault: cannot open before the backup quiz'));
  const labels = await page.locator('.vault-quiz label').allInnerTexts();
  for (let i = 0; i < 2; i++) await page.locator('.vault-quiz input').nth(i).fill(words[Number(labels[i].match(/#(\d+)/)[1]) - 1]);
  await page.getByText('I wrote all 24 words down offline').click();
  await page.getByRole('button', { name: 'Open my bunker' }).click();
  await page.getByText(/empty: deposit to open it/).waitFor({ timeout: 20000 });
  const dep = page.locator('.vault-card').filter({ hasText: 'Deposit' });
  await dep.locator('input.field').fill('0.4');
  await page.getByRole('button', { name: 'Deposit to bunker' }).click();
  await page.getByText('Deposited 0.4 ETH.').waitFor({ timeout: 60000 });
  await dep.locator('select').selectOption({ label: 'USDC' });
  await dep.locator('input.field').fill('120');
  await page.getByRole('button', { name: 'Deposit to bunker' }).click();
  await page.getByText('Deposited 120 USDC.').waitFor({ timeout: 60000 });
  const hold = page.locator('.vault-card').filter({ hasText: 'Holdings' });
  await hold.getByText('USDC').waitFor({ timeout: 15000 });
  check(/ETH\s+0\.4/.test(await hold.innerText()) && /USDC\s+120/.test(await hold.innerText()), 'vault: deposits of ETH + USDC shown', (await hold.innerText()).replace(/\s+/g, ' '));

  // the wallet rejects the submission after the browser signed -> pending signature, button locked, re-broadcast works
  dest = fresh();
  const w = () => page.locator('.vault-card').filter({ hasText: 'Withdraw' });
  await w().locator('tr', { hasText: 'ETH' }).locator('input.field').fill('0.1');
  await w().locator('tr', { hasText: 'USDC' }).locator('input[type=checkbox]').uncheck();
  await w().getByPlaceholder(/destination address/).fill(dest);
  await page.evaluate(() => localStorage.setItem('mock-reject-next', '1'));
  await w().getByRole('button', { name: /Sign with key #0/ }).click();
  await page.getByText('You rejected it in the wallet.').waitFor({ timeout: 30000 });
  await page.getByText('Signed, not confirmed yet').waitFor({ timeout: 5000 });
  check(await w().getByRole('button', { name: /Sign with key #0/ }).isDisabled(), 'vault: after a signed-but-unsent withdrawal, signing anything else with key #0 is locked');
  await page.getByRole('button', { name: /Re-broadcast/ }).click();
  await page.getByText(/^Done\. Tx/).waitFor({ timeout: 60000 });
  await page.getByText(/live · key #1/).waitFor({ timeout: 20000 });
  check(await bal(dest) === parseEther('0.1'), 'vault: re-broadcast of the SAME signature landed 0.1 ETH, key rotated to #1');

  // second withdrawal with key #1: everything left
  await page.waitForTimeout(800);
  await w().getByPlaceholder(/destination address/).fill(dest);
  await w().getByRole('button', { name: /Sign with key #1/ }).click();
  await page.getByText(/Key #1 burned/).waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  check(await bal(dest) === parseEther('0.4') && await bal(dest, USDC) === 120_000_000n && await bal(vault) === 0n && await bal(vault, USDC) === 0n,
    'vault: key #1 sent the rest; vault empty, destination holds 0.4 ETH + 120 USDC');
  check(/Nothing in this bunker/.test(await hold.innerText()), 'vault: holdings panel shows empty');

  // lock + reopen with the phrase (wrong phrase rejected)
  await page.getByRole('button', { name: 'Lock' }).click();
  await page.getByRole('button', { name: 'Open my bunker' }).click();
  await page.locator('textarea').fill(words.slice(0, 23).join(' ') + ' zoo');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  const badPhrase = await page.getByText('not a valid 24-word bunker phrase').isVisible().catch(() => false);
  await page.locator('textarea').fill(words.join(' '));
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByText(/live · key #2/).waitFor({ timeout: 20000 });
  check(true, 'vault: lock, reopen from phrase at key #2', badPhrase ? 'tampered phrase refused' : 'tampered phrase happened to checksum (1/16 odds)');
  const [onKey, onNonce] = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'accounts', args: [(await page.locator('.vault-head code').getAttribute('title'))] });
  check(Number(onNonce) === 2 && (await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'spentKey', args: [onKey] })) === false, 'vault: on-chain nonce 2, current key unspent');

  // ---------------------------------------------------------------- tripwire: arm, fund the bounty, trip, escape
  const TWA = art('BunkerTripwire');
  const twHash = await wal.deployContract({ abi: TWA.abi, bytecode: TWA.bytecode.object, args: [vault], value: parseEther('0.25') });
  const tw = getAddress((await pub.waitForTransactionReceipt({ hash: twHash })).contractAddress);
  const twRead = (functionName, args = []) => pub.readContract({ address: tw, abi: TWA.abi, functionName, args });
  await fund('1', 400n);
  await pub.waitForTransactionReceipt({ hash: await wal.writeContract({ address: token, abi: art('MockERC20').abi, functionName: 'mint', args: [user, parseEther('777')] }) });
  const tq = `${q}&tripwire=${tw}`;
  await page.goto(`${WEB}/${tq}#tripwire`);
  await page.locator('.tw-status .tw-state.armed').waitFor({ timeout: 20000 });
  check(/0\.25 ETH/.test(await page.locator('.tw-status').innerText()), 'tripwire: ARMED, 0.25 ETH bounty shown', (await page.locator('.tw-stats').innerText()).replace(/\s+/g, ' '));
  const myBunker = await page.evaluate(() => localStorage.getItem('bunker:last-id'));
  await page.getByText('Bunker found in the vault.').waitFor({ timeout: 20000 });
  check(await page.locator('.tw-field input').inputValue() === myBunker, 'tripwire: bunker ID prefilled from the vault page and found on-chain');
  await page.locator('.tw-tokens .asset-row', { hasText: 'BUNKER' }).waitFor({ timeout: 20000 });
  const armBtn = page.getByRole('button', { name: /^Arm \d+ tokens?$/ });
  check(/Arm 2 tokens/.test(await armBtn.innerText()), 'tripwire: tokens the wallet holds (USDC + BUNKER) preselected');
  await armBtn.click();
  await page.getByText(/^Armed\. If the canary ever signs/).waitFor({ timeout: 90000 });
  const armedTokens = (await twRead('tokensOf', [user])).map(a => a.toLowerCase()).sort();
  check(await twRead('bunkerOf', [user]) === myBunker && armedTokens.join() === [USDC, token].map(a => a.toLowerCase()).sort().join(),
    'tripwire: registered on-chain (bunker + USDC + BUNKER, approvals given)');
  await page.locator('.tw-fund input').fill('0.05');
  await page.getByRole('button', { name: 'Add to bounty' }).click();
  await page.getByText(/Added 0\.05 ETH to the bounty/).waitFor({ timeout: 60000 });
  check(await bal(tw) === parseEther('0.3'), 'tripwire: bounty topped up from the page to 0.3 ETH');
  check(await reverts(() => pub.simulateContract({ address: tw, abi: TWA.abi, functionName: 'escape', account: deployer, args: [user] })), 'tripwire: escape impossible while armed');
  // the canary signs (simulated: a 7702 delegation designator appears at its address)
  await rpc('anvil_setCode', [await twRead('canary'), '0xef0100' + vault.slice(2).toLowerCase()]);
  await page.reload();
  await page.locator('.tw-alarm').waitFor({ timeout: 30000 });
  check(true, 'tripwire: page shows TRIPPED alarm');
  await page.getByRole('button', { name: 'Escape everyone', exact: true }).click();
  await page.getByText(/^Done: 1 armed wallets swept/).waitFor({ timeout: 90000 }).catch(async e => {
    console.log('ALARM TEXT:', await page.locator('.tw-alarm').innerText());
    throw e;
  });
  check(await bal(user, USDC) === 0n && await bal(user, token) === 0n
    && await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [myBunker, USDC] }) === 400_000_000n
    && await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [myBunker, token] }) === parseEther('777'),
    'tripwire: "Escape everyone" moved 400 USDC + 777 BUNKER into the bunker');

  // ---------------------------------------------------------------- phones
  await page.setViewportSize({ width: 390, height: 844 });
  for (const h of ['#scan', '#board', '#move', '#vault', '#tripwire', '#coin']) {
    await page.goto(`${WEB}/${h === '#tripwire' ? tq : q}${h}`);
    await page.waitForTimeout(1500);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 0, `phone 390px ${h}: no sideways scroll`);
  }

  check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3).join(' | '));
  const noisy = consoleErrors.filter(e => !/Failed to load resource/.test(e));
  check(noisy.length === 0, 'no console errors (network 4xx/5xx from public RPCs excluded)', noisy.slice(0, 3).join(' | '));
  if (consoleErrors.length) console.log(`       (${consoleErrors.length} network console errors: ${[...new Set(consoleErrors)].slice(0, 3).join(' | ')})`);
}

main()
  .then(() => console.log(`\n${results.length}/${results.length} checks passed`))
  .catch(e => { console.error(`\nFAILED after ${results.filter(Boolean).length} passing checks: ${e.message.split('\n')[0]}`); process.exitCode = 1; })
  .finally(async () => {
    await browser?.close().catch(() => {});
    for (const p of procs) { try { process.platform === 'win32' ? spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }) : p.kill(); } catch { /* gone */ } }
  });
