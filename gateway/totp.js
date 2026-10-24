// Two-factor sign-in with an authenticator app (TOTP, RFC 6238: HMAC-SHA1, 6 digits, 30 seconds)
// and one-time recovery codes. Web Crypto only.
//
// In .werft/users.json an account with two-factor sign-in has
//   "totp": "v1.<iv>.<ciphertext>"   its secret, encrypted (AES-GCM) with a key from WERFT_SECRET,
//                                     so reading the repository is not enough to make codes
//   "recovery": ["<hash>", …]        its unused recovery codes, as HMACs keyed with WERFT_SECRET
import { base64url } from './auth.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP = 30;
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of String(text).toUpperCase().replace(/[\s=-]/g, '')) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('Not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export const newSecret = () => base32(crypto.getRandomValues(new Uint8Array(20)));

// The code for a time step.
export async function codeAt(secret, step) {
  const key = await crypto.subtle.importKey('raw', fromBase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new Uint8Array(8);
  for (let i = 7, n = step; i >= 0; i--, n = Math.floor(n / 256)) counter[i] = n % 256;
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = mac[19] & 15;
  const number = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(number % 1e6).padStart(6, '0');
}

// The time step a code belongs to (this one, the one before or after, for clocks that are a little
// off), or null.
export async function stepOf(secret, code, now = Date.now()) {
  const given = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const step = Math.floor(now / 1000 / STEP);
  for (const s of [step, step - 1, step + 1]) if ((await codeAt(secret, s)) === given) return s;
  return null;
}

// The address an authenticator app reads (as a QR code or a link).
export const otpauthURL = ({ issuer, account, secret }) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

async function aesKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', encoder.encode(`werft totp\n${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealSecret(werftSecret, totpSecret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(werftSecret), encoder.encode(totpSecret)));
  return `v1.${base64url.encode(iv)}.${base64url.encode(sealed)}`;
}

export async function openSecret(werftSecret, sealed) {
  const [version, iv, data] = String(sealed ?? '').split('.');
  if (version !== 'v1' || !iv || !data) return null;
  try {
    return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64url.decode(iv) }, await aesKey(werftSecret), base64url.decode(data)));
  } catch {
    return null; // another WERFT_SECRET
  }
}

// Ten codes like "k7mq-2xpa"; the account keeps only their hashes.
export function newRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const code = base32(crypto.getRandomValues(new Uint8Array(5))).toLowerCase();
    return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
  });
}

export async function recoveryHash(werftSecret, email, code) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(werftSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const normal = String(code ?? '').toLowerCase().replace(/[^a-z2-7]/g, '');
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`werft recovery\n${email.toLowerCase()}\n${normal}`))).slice(0, 32);
}
