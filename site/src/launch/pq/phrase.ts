// The 24-word bunker phrase is the ONLY secret. It is not a wallet seed: it never derives an ECDSA key. Its 32 bytes
// of entropy seed the XMSS creator identity (launch signatures) and the BunkerVault account (dev bags, fees).
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const norm = (p: string) => String(p).trim().toLowerCase().split(/\s+/).join(' ');

export function newPhrase(): string {
  const e = new Uint8Array(32);
  crypto.getRandomValues(e);
  return entropyToMnemonic(e, wordlist);
}

export function isPhrase(p: string): boolean {
  const n = norm(p);
  return n.split(' ').length === 24 && validateMnemonic(n, wordlist);
}

export function phraseEntropy(p: string): Uint8Array {
  if (!isPhrase(p)) throw new Error('Not a valid 24-word phrase.');
  return mnemonicToEntropy(norm(p), wordlist);
}

// ---------------------------------------------------------------- optional: remember on this device, encrypted

const STORE = 'bunker:sealed-phrase:v1';
const ITER = 600_000;

interface Sealed {
  salt: string;
  iv: string;
  ct: string;
  label: string; // short public id, so the UI can say which identity is saved
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function keyFrom(pass: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITER },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealEntropy(entropy: Uint8Array, pass: string, label: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(pass, salt), entropy as BufferSource),
  );
  const s: Sealed = { salt: b64(salt), iv: b64(iv), ct: b64(ct), label };
  localStorage.setItem(STORE, JSON.stringify(s));
}

export function sealedLabel(): string | null {
  try {
    const raw = localStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Sealed).label : null;
  } catch {
    return null;
  }
}

export async function unsealEntropy(pass: string): Promise<Uint8Array> {
  const raw = localStorage.getItem(STORE);
  if (!raw) throw new Error('Nothing saved on this device.');
  const s = JSON.parse(raw) as Sealed;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(s.iv) as BufferSource },
      await keyFrom(pass, unb64(s.salt)),
      unb64(s.ct) as BufferSource,
    );
    return new Uint8Array(pt);
  } catch {
    throw new Error('Wrong passcode.');
  }
}

export function forgetSealed() {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
}
