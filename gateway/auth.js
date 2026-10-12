// Passwords, signed tokens and the users file. Web Crypto only, so this runs on Node, Workers and in
// the browser alike.
//
// Users live in the site's repository at .werft/users.json, never served and hidden from the CMS:
//   { "users": [{ "email", "name", "role", "password": "pbkdf2-sha256$<iterations>$<salt>$<hash>" }] }

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const USERS_FILE = '.werft/users.json';

// Cloudflare Workers reject more than 100,000 PBKDF2 iterations.
export const DEFAULT_ITERATIONS = 100000;

export const base64url = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password, iterations = DEFAULT_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${base64url.encode(salt)}$${base64url.encode(await pbkdf2(password, salt, iterations))}`;
}

// Compares in constant time once both hashes exist.
export async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, hash] = String(stored ?? '').split('$');
  if (scheme !== 'pbkdf2-sha256' || !hash) return false;
  const actual = await pbkdf2(password, base64url.decode(salt), Number(iterations));
  const expected = base64url.decode(hash);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

// A token is base64url(JSON payload) "." base64url(HMAC). Each user's tokens carry a stamp derived
// from the stored password hash, so changing a password or deleting a user revokes them.
export async function stampOf(user) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(`${user.email}\n${user.password}\n${user.role}`))).slice(0, 16);
}

export async function signToken(secret, payload) {
  const body = base64url.encode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${base64url.encode(await hmac(secret, body))}`;
}

export async function readToken(secret, token, now = Date.now()) {
  const [body, signature] = String(token ?? '').split('.');
  if (!body || !signature) return null;
  const expected = base64url.encode(await hmac(secret, body));
  if (expected.length !== signature.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff) return null;
  const payload = JSON.parse(decoder.decode(base64url.decode(body)));
  return payload.exp && payload.exp * 1000 > now ? payload : null;
}

export const parseUsers = (text) => (text ? JSON.parse(text).users ?? [] : []);
export const serializeUsers = (users) => `${JSON.stringify({ users }, null, 2)}\n`;
export const findUser = (users, email) => users.find((u) => u.email.toLowerCase() === String(email ?? '').trim().toLowerCase());

// The public view of a user, as the admin shows it.
export const publicUser = ({ email, name, role }) => ({ email, name, role });
