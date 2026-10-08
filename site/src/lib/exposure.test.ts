import { describe, expect, it } from 'vitest';
import { classifyBtc, classifyEvm, classifySol, detectAddress, parseAddressList, type EvmChainFacts } from './exposure';

describe('detectAddress', () => {
  it('EVM: checksummed, lowercase, bad checksum', () => {
    expect(detectAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toEqual({
      kind: 'evm',
      address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    });
    expect(detectAddress('0xd8da6bf26964af9d7eed9e03e53415d37aa96045').kind).toBe('evm');
    expect(detectAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96046').kind).toBe('invalid');
  });

  it('Bitcoin types', () => {
    expect(detectAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toMatchObject({ kind: 'btc', btcType: 'p2pkh' });
    expect(detectAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toMatchObject({ kind: 'btc', btcType: 'p2sh' });
    expect(detectAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toMatchObject({ kind: 'btc', btcType: 'p2wpkh' });
    expect(detectAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4')).toMatchObject({ kind: 'btc', btcType: 'p2wpkh' });
    expect(detectAddress('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3')).toMatchObject({
      kind: 'btc',
      btcType: 'p2wsh',
    });
    expect(detectAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0')).toMatchObject({
      kind: 'btc',
      btcType: 'p2tr',
    });
  });

  it('Bitcoin checksum failures', () => {
    expect(detectAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5').kind).toBe('invalid');
    // BIP-173 v1 address encoded with bech32 (not bech32m) is invalid since BIP-350
    expect(detectAddress('bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx').kind).toBe('invalid');
    expect(detectAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb').kind).not.toBe('btc');
  });

  it('Solana', () => {
    expect(detectAddress('vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg')).toMatchObject({ kind: 'sol' });
    expect(detectAddress('So11111111111111111111111111111111111111112')).toMatchObject({ kind: 'sol' });
    expect(detectAddress('not-an-address').kind).toBe('invalid');
  });

  it('parses lists and dedupes', () => {
    expect(parseAddressList('0xAbc, 0xabc\nbc1qXYZ  bc1qxyz;foo')).toEqual(['0xAbc', 'bc1qXYZ', 'foo']);
  });
});

const fresh = (name: string, nonce = 0, code: `0x${string}` = '0x'): EvmChainFacts => ({ chainName: name, nonce, code });

describe('classifyEvm', () => {
  it('nonce > 0 on one chain exposes every chain and names it', () => {
    const v = classifyEvm([fresh('Ethereum'), fresh('Base', 3), fresh('Arbitrum')]);
    expect(v.status).toBe('exposed');
    expect(v.reason).toContain('Base');
    expect(v.reason).toContain('every EVM chain');
  });

  it('nonce 0 everywhere + no code → hidden with off-chain caveat', () => {
    const v = classifyEvm([fresh('Ethereum'), fresh('Base'), fresh('Arbitrum')]);
    expect(v.status).toBe('hidden');
    expect(v.caveat).toMatch(/Permit2/);
    expect(v.caveat).toMatch(/Sign-In-With-Ethereum/);
  });

  it('EIP-7702 delegation code → exposed', () => {
    const v = classifyEvm([fresh('Ethereum', 0, '0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f9'), fresh('Base')]);
    expect(v.status).toBe('exposed');
    expect(v.reason).toMatch(/7702/);
  });

  it('plain contract → warn (owner keys)', () => {
    const v = classifyEvm([fresh('Ethereum', 1, '0x6080604052'), fresh('Base')]);
    expect(v.status).toBe('warn');
    expect(v.reason).toMatch(/depends on/);
  });

  it('Safe: executed tx → exposed; fresh owners → hidden; exposed owners ≥ threshold → exposed', () => {
    const chains = [fresh('Ethereum', 1, '0x6080604052')];
    const base = { chainName: 'Ethereum', owners: ['0x1', '0x2', '0x3'] as `0x${string}`[], threshold: 2 };
    expect(classifyEvm(chains, { ...base, safeNonce: 5, ownerStatus: ['hidden', 'hidden', 'hidden'] }).status).toBe('exposed');
    expect(classifyEvm(chains, { ...base, safeNonce: 0, ownerStatus: ['hidden', 'hidden', 'hidden'] }).status).toBe('hidden');
    expect(classifyEvm(chains, { ...base, safeNonce: 0, ownerStatus: ['exposed', 'hidden', 'hidden'] }).status).toBe('warn');
    expect(classifyEvm(chains, { ...base, safeNonce: 0, ownerStatus: ['exposed', 'exposed', 'hidden'] }).status).toBe('exposed');
  });

  it('pending and failed chains', () => {
    expect(classifyEvm([fresh('Ethereum'), { chainName: 'Base' }]).status).toBe('pending');
    // a signature found anywhere wins even while others load
    expect(classifyEvm([fresh('Ethereum', 2), { chainName: 'Base' }]).status).toBe('exposed');
    const v = classifyEvm([fresh('Ethereum'), { chainName: 'Robinhood Chain', error: true }]);
    expect(v.status).toBe('warn');
    expect(v.reason).toContain('Robinhood Chain');
  });
});

describe('classifyBtc', () => {
  it('P2TR is always exposed', () => {
    expect(classifyBtc({ btcType: 'p2tr', spentTxo: 0, mempoolSpentTxo: 0 }).status).toBe('exposed');
  });
  it('hash types hidden until first spend', () => {
    for (const t of ['p2pkh', 'p2sh', 'p2wpkh', 'p2wsh'] as const) {
      expect(classifyBtc({ btcType: t, spentTxo: 0, mempoolSpentTxo: 0 }).status).toBe('hidden');
      expect(classifyBtc({ btcType: t, spentTxo: 1, mempoolSpentTxo: 0 }).status).toBe('exposed');
      expect(classifyBtc({ btcType: t, spentTxo: 0, mempoolSpentTxo: 1 }).status).toBe('exposed');
    }
  });
  it('P2WSH names SHA-256, P2WPKH names HASH160', () => {
    expect(classifyBtc({ btcType: 'p2wsh', spentTxo: 0, mempoolSpentTxo: 0 }).reason).toContain('SHA-256');
    expect(classifyBtc({ btcType: 'p2wpkh', spentTxo: 0, mempoolSpentTxo: 0 }).reason).toContain('HASH160');
  });
});

describe('classifySol', () => {
  it('always exposed', () => {
    expect(classifySol().status).toBe('exposed');
  });
});
