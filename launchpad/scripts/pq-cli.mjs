// XMSS helper for Foundry tests (vm.ffi) and scripts. Trees are cached in scripts/.cache (public data only).
//
//   node scripts/pq-cli.mjs identity <entropyHex>                  -> abi(bytes32 seed, bytes32 root)
//   node scripts/pq-cli.mjs sign <entropyHex> <leaf> <digestHex>    -> abi(PQSig)
//   node scripts/pq-cli.mjs vectors <outFile>                       -> writes XMSS test vectors (JSON)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters } from 'viem';
import { identityKeys, buildTree, treeFromLeaves, rootOf, sign, toHex, fromHex, LEAVES } from '../../site/src/launch/pq/xmss.js';

const CACHE = join(dirname(fileURLToPath(import.meta.url)), '.cache');

export function loadIdentity(entropyHex) {
  const { master, seed } = identityKeys(fromHex(entropyHex));
  const file = join(CACHE, `${toHex(seed).slice(2, 18)}.json`);
  let levels;
  if (existsSync(file)) {
    levels = treeFromLeaves(seed, JSON.parse(readFileSync(file, 'utf8')).map(fromHex));
  } else {
    levels = buildTree(master, seed);
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, JSON.stringify(levels[0].map(toHex)));
  }
  return { master, seed, levels, root: rootOf(levels) };
}

const SIG = [{
  type: 'tuple',
  components: [
    { name: 'seed', type: 'bytes32' },
    { name: 'root', type: 'bytes32' },
    { name: 'leaf', type: 'uint32' },
    { name: 'wots', type: 'bytes32[67]' },
    { name: 'auth', type: 'bytes32[10]' },
  ],
}];

export function signDigest(id, leaf, digestHex) {
  const s = sign(id.master, id.seed, id.levels, leaf, fromHex(digestHex));
  return { seed: toHex(id.seed), root: toHex(id.root), leaf, wots: s.wots, auth: s.auth };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'identity') {
    const id = loadIdentity(a);
    process.stdout.write(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [toHex(id.seed), toHex(id.root)]));
  } else if (cmd === 'sign') {
    const id = loadIdentity(a);
    process.stdout.write(encodeAbiParameters(SIG, [signDigest(id, Number(b), c)]));
  } else if (cmd === 'vectors') {
    const id = loadIdentity('0x' + '11'.repeat(32));
    const cases = [];
    const digests = [
      '0x' + '00'.repeat(32), // worst case: every chain walked 15 steps
      '0x' + 'ff'.repeat(32), // best case
      '0x' + Array.from({ length: 32 }, (_, i) => ((i * 37 + 11) & 255).toString(16).padStart(2, '0')).join(''),
    ];
    const leaves = [0, 1, 513, LEAVES - 1];
    for (const leaf of leaves) for (const d of digests) cases.push({ digest: d, ...signDigest(id, leaf, d) });
    writeFileSync(a, JSON.stringify({ seed: toHex(id.seed), root: toHex(id.root), cases }, null, 1));
    console.log(`wrote ${cases.length} vectors to ${a}`);
  } else {
    console.error('usage: identity <entropy> | sign <entropy> <leaf> <digest> | vectors <out>');
    process.exit(1);
  }
}
