// $BUNKER on Ethereum mainnet (or a local fork standing in for it). No bundle: the token launches its own pool.
//
//   node launch/bunker-launch.mjs deploy        --rpc URL --keys DIR [--send-rpc URL] [--tip-gwei 0.2] [--mainnet]
//   node launch/bunker-launch.mjs launch        --rpc URL --keys DIR [--send-rpc URL] [--mcap 5000] [--fee 10000 --spacing 200] [--mainnet]
//   node launch/bunker-launch.mjs collect       --rpc URL --keys DIR [--mainnet]      (LP fees -> fee recipient)
//   node launch/bunker-launch.mjs remove-limits --rpc URL --keys DIR [--mainnet]      (switch the 2% max wallet off, for good)
//   node launch/bunker-launch.mjs status        --rpc URL --keys DIR
//
// deploy: BunkerToken(feeRecipient = owner) at the owner's nonce 0 (CA known in advance) and BunkerVault at nonce 1.
//   The whole supply sits inside the token contract; nobody holds any BUNKER yet.
// launch: token.launch(fee, spacing, sqrtPrice, tickLower, tickUpper, liquidity): creates the ETH pool at ~--mcap USD
//   and adds ALL the supply single-sided as one position the token contract holds forever (LP locked in-contract).
// --send-rpc: where signed txs go (e.g. https://rpc.flashbots.net/fast keeps them out of the public mempool).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, getAddress, getCreateAddress, keccak256,
  AbiCoder, formatEther, formatUnits, parseUnits } from 'ethers';
const require = createRequire(import.meta.url);
const { TickMath } = require('@uniswap/v3-sdk');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'out', `${name}.sol`, `${name}.json`), 'utf8'));
const ETH = Object.freeze({
  stateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
  positionManager: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',
  chainlinkEthUsd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
});
const MIN_TICK = { 200: -887200, 60: -887220, 10: -887270, 1: -887272 };
const POOL_KEY = '(address,address,uint24,int24,address)';
const coder = AbiCoder.defaultAbiCoder();
const Q96 = 1n << 96n;

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, fallback) => { const i = args.indexOf('--' + name); return i > 0 ? args[i + 1] : fallback; };
const flag = name => args.includes('--' + name);
const isLocal = url => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url);
const say = (...a) => console.log(...a);

function loadKey(file) {
  const key = fs.readFileSync(file, 'utf8').match(/0x[0-9a-fA-F]{64}/)?.[0];
  if (!key) throw new Error(`${file} holds no private key`);
  return key;
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2), { mode: 0o600 });
}

async function connect() {
  const rpc = opt('rpc');
  if (!rpc) throw new Error('--rpc is required');
  const provider = new JsonRpcProvider(rpc, 1, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = isLocal(rpc) ? 100 : 2000;
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== 1) throw new Error(`chain ${chainId}: expected Ethereum (1)`);
  const local = isLocal(rpc);
  if (!local && !flag('mainnet') && cmd !== 'status') throw new Error('This is real Ethereum mainnet. Add --mainnet to send real transactions.');
  const keys = opt('keys'); if (!keys) throw new Error('--keys DIR is required');
  const sendProvider = opt('send-rpc') ? new JsonRpcProvider(opt('send-rpc'), 1, { staticNetwork: true }) : provider;
  sendProvider.pollingInterval = provider.pollingInterval;
  const owner = new Wallet(loadKey(path.join(keys, 'owner.txt')), sendProvider);
  const dfile = path.join(keys, local ? 'deployment-fork.json' : 'deployment.json');
  return { provider, local, keys, owner, dfile };
}

async function fees(provider) {
  const block = await provider.getBlock('latest');
  const tip = parseUnits(String(opt('tip-gwei', '0.2')), 'gwei');
  return { maxPriorityFeePerGas: tip, maxFeePerGas: block.baseFeePerGas * 2n + tip };
}
async function send(label, provider, fn) {
  const tx = await fn(await fees(provider));
  say(`  -> ${label}: ${tx.hash}`);
  let rec = null;
  for (let i = 0; i < 600 && !rec; i++) { rec = await provider.getTransactionReceipt(tx.hash); if (!rec) await new Promise(r => setTimeout(r, provider.pollingInterval)); }
  if (!rec) throw new Error(`${label}: no receipt after waiting (${tx.hash}) — check it before re-running`);
  if (rec.status !== 1) throw new Error(`${label} reverted (${tx.hash})`);
  say(`     ok · block ${rec.blockNumber} · gas ${rec.gasUsed} · ${formatEther(rec.gasUsed * rec.gasPrice)} ETH`);
  return rec;
}

// ------------------------------------------------------------------ deploy
async function deploy() {
  const { provider, local, owner, dfile } = await connect();
  const d = readJson(dfile, { chainId: 1, owner: owner.address });
  if (d.owner !== owner.address) throw new Error(`${dfile} belongs to ${d.owner}, not ${owner.address}`);
  const save = () => writeJson(dfile, d);
  const nonce = await provider.getTransactionCount(owner.address, 'latest');
  say(`BUNKER deploy on ${local ? 'a LOCAL FORK' : 'ETHEREUM MAINNET'} · owner ${owner.address} · nonce ${nonce} · ${formatEther(await provider.getBalance(owner.address))} ETH`);
  if (!d.token) {
    d.expectToken = getCreateAddress({ from: owner.address, nonce });
    say(`  token will land at ${d.expectToken}`);
    const a = artifact('BunkerToken');
    const rec = await send('deploy BunkerToken', provider, f => new ContractFactory(a.abi, a.bytecode.object, owner).deploy(owner.address, f).then(c => c.deploymentTransaction()));
    d.token = getAddress(rec.contractAddress); d.tokenBlock = rec.blockNumber; save();
    if (d.token !== d.expectToken) say(`  NOTE: token landed at ${d.token}, not the predicted ${d.expectToken}`);
  } else say(`  = token ${d.token}`);
  if (!d.vault) {
    const a = artifact('BunkerVault');
    const rec = await send('deploy BunkerVault', provider, f => new ContractFactory(a.abi, a.bytecode.object, owner).deploy(f).then(c => c.deploymentTransaction()));
    d.vault = getAddress(rec.contractAddress); d.vaultBlock = rec.blockNumber; save();
  } else say(`  = vault ${d.vault}`);
  const token = new Contract(d.token, artifact('BunkerToken').abi, provider);
  const held = await token.balanceOf(d.token);
  if (held !== 10n ** 27n) throw new Error(`token contract holds ${formatUnits(held, 18)}, expected the whole supply`);
  if ((await token.owner()) !== owner.address) throw new Error('token owner is not the deployer');
  d.done = true; save();
  say(`\nBUNKER token ${d.token}  (all 1,000,000,000 inside the contract)\nBunkerVault  ${d.vault}\nsaved ${dfile}`);
}

// ------------------------------------------------------------------ launch
async function ethUsd(provider) {
  if (opt('eth-usd')) return Number(opt('eth-usd'));
  const feed = new Contract(ETH.chainlinkEthUsd, ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'], provider);
  const [, answer] = await feed.latestRoundData();
  return Number(answer) / 1e8;
}
function poolId(token, fee, spacing) {
  return keccak256(coder.encode([POOL_KEY], [[ZeroAddress, token, fee, spacing, ZeroAddress]]));
}
async function launch() {
  const { provider, local, owner, dfile } = await connect();
  const d = readJson(dfile, null);
  if (!d?.done) throw new Error(`${dfile}: run "deploy" first`);
  const token = new Contract(d.token, artifact('BunkerToken').abi, owner);
  const tokenR = token.connect(provider);
  if ((await tokenR.lpTokenId()) !== 0n) { say(`already launched: LP #${await tokenR.lpTokenId()}`); return; }
  const fee = Number(opt('fee', '10000')), spacing = Number(opt('spacing', '200'));
  const usd = await ethUsd(provider);
  const mcapUsd = Number(opt('mcap', '5000'));
  const supply = 10n ** 27n;
  // price = BUNKER (raw) per wei. Round the start tick DOWN to the grid (= slightly higher opening mcap) so the start
  // price is exactly the top of the position and the position is all BUNKER.
  const rawPerWei = Number(supply) / ((mcapUsd / usd) * 1e18);
  const tickUpper = Math.floor(Math.log(rawPerWei) / Math.log(1.0001) / spacing) * spacing;
  const tickLower = MIN_TICK[spacing];
  if (tickLower === undefined) throw new Error(`no min tick for spacing ${spacing}`);
  const sqrtUpper = BigInt(TickMath.getSqrtRatioAtTick(tickUpper).toString());
  const sqrtLower = BigInt(TickMath.getSqrtRatioAtTick(tickLower).toString());
  const liquidity = supply * Q96 / (sqrtUpper - sqrtLower);
  const openMcapEth = Number(supply) / (1.0001 ** tickUpper) / 1e18;
  const id = poolId(d.token, fee, spacing);
  const sv = new Contract(ETH.stateView, ['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)'], provider);
  const [sqrtNow, tickNow] = await sv.getSlot0(id);
  if (sqrtNow !== 0n && Number(tickNow) < tickUpper) throw new Error(`pool ${id} was already created at tick ${tickNow} (pricier than our start ${tickUpper}). Re-run with another tier, e.g. --fee 3000 --spacing 60`);
  say(`launch: fee ${fee / 10000}% spacing ${spacing} · ticks ${tickLower}..${tickUpper} · open mcap ${openMcapEth.toFixed(4)} ETH ≈ $${Math.round(openMcapEth * usd)} (ETH $${usd.toFixed(2)})`);
  const args_ = [fee, spacing, sqrtUpper, tickLower, tickUpper, liquidity];
  await tokenR.launch.staticCall(...args_, { from: owner.address });
  const rec = await send('token.launch (pool + locked LP)', provider, f => token.launch(...args_, { ...f, gasLimit: 900_000 }));
  const lp = await tokenR.lpTokenId();
  d.launch = { fee, spacing, tickLower, tickUpper, liquidity: liquidity.toString(), poolId: id, lpTokenId: lp.toString(), block: rec.blockNumber, tx: rec.hash, openMcapEth, ethUsd: usd };
  writeJson(dfile, d);
  const pm = new Contract(ETH.positionManager, ['function ownerOf(uint256) view returns (address)'], provider);
  say(`\nLIVE: pool ${id}\nLP #${lp} owner ${await pm.ownerOf(lp)} (= token contract: ${(await pm.ownerOf(lp)) === d.token})\nlocked liquidity ${await tokenR.lockedLiquidity()} · max wallet ${await tokenR.limitsInEffect() ? 'ON (2%)' : 'off'}`);
}

// ------------------------------------------------------------------ after launch
async function collect() {
  const { provider, owner, dfile } = await connect();
  const d = readJson(dfile, null);
  const token = new Contract(d.token, artifact('BunkerToken').abi, owner);
  const [e, b] = await token.connect(provider).collectFees.staticCall({ from: owner.address });
  say(`collecting ${formatEther(e)} ETH + ${formatUnits(b, 18)} BUNKER -> ${await token.connect(provider).feeRecipient()}`);
  await send('collectFees', provider, f => token.collectFees(f));
}
async function removeLimits() {
  const { provider, owner, dfile } = await connect();
  const d = readJson(dfile, null);
  const token = new Contract(d.token, artifact('BunkerToken').abi, owner);
  await send('removeLimits (2% max wallet off, permanently)', provider, f => token.removeLimits(f));
}
async function status() {
  const { provider, owner, dfile } = await connect();
  const d = readJson(dfile, null);
  const out = { owner: owner.address, ownerEth: formatEther(await provider.getBalance(owner.address)), ownerNonce: await provider.getTransactionCount(owner.address), token: d?.token, vault: d?.vault };
  if (d?.token) {
    const t = new Contract(d.token, artifact('BunkerToken').abi, provider);
    Object.assign(out, { lpTokenId: (await t.lpTokenId()).toString(), lockedLiquidity: (await t.lockedLiquidity()).toString(), maxWallet: await t.limitsInEffect(), feeRecipient: await t.feeRecipient() });
    if (d.launch) {
      const sv = new Contract(ETH.stateView, ['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)'], provider);
      const [, tick] = await sv.getSlot0(d.launch.poolId);
      const mcapEth = 1e27 / (1.0001 ** Number(tick)) / 1e18;
      out.mcapEth = mcapEth.toFixed(4); out.mcapUsd = Math.round(mcapEth * await ethUsd(provider));
    }
  }
  say(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

const commands = { deploy, launch, collect, 'remove-limits': removeLimits, status };
if (!commands[cmd]) { console.error('usage: deploy | launch | collect | remove-limits | status  (see the header of this file)'); process.exit(2); }
commands[cmd]().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.shortMessage || e.message); process.exit(1); });
