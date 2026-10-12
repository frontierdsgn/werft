// Credentials for githubStorage from a GitHub App instead of a personal token. The app signs a JWT
// with its private key (RS256), looks up its installation on the repository and gets an
// installation token limited to that one repository and contents:write. A token lasts an hour and
// is reused until five minutes before it expires. Commits name the app's bot (e.g. werft[bot]) as
// committer; the editor stays the author.
//
// The private key must be PKCS#8; GitHub's download is PKCS#1, which Web Crypto cannot import:
//   openssl pkcs8 -topk8 -nocrypt -in <app>.private-key.pem -out <app>.pkcs8.pem
//
// githubStorage only needs a function that resolves to { token, committer }. A central service
// that holds the key and issues tokens per repository can supply the same function.
import { base64url } from '../auth.js';

const RENEW_BEFORE = 5 * 60 * 1000;
const encoder = new TextEncoder();
const part = (data) => base64url.encode(encoder.encode(JSON.stringify(data)));

function importKey(pem) {
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) throw new Error('The GitHub App private key is PKCS#1; convert it with: openssl pkcs8 -topk8 -nocrypt -in <app>.private-key.pem -out <app>.pkcs8.pem');
  // Tolerates a key whose line breaks were pasted as spaces or as literal \n.
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\\n|\s/g, '')), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

// appId: the app's client ID or app ID (both are accepted as the JWT issuer).
export function githubApp({ appId, privateKey, owner, repo, api = 'https://api.github.com', fetch: request = globalThis.fetch.bind(globalThis), now = Date.now }) {
  let key;
  let installation;
  let bot;
  let pending = null;
  let expires = 0;
  const host = new URL(api).hostname;
  const noreply = `users.noreply.${host === 'api.github.com' ? 'github.com' : host}`;

  async function jwt() {
    key ??= importKey(privateKey);
    // GitHub allows at most 10 minutes; iat lies a minute back against clock drift.
    const iat = Math.floor(now() / 1000) - 60;
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat, exp: iat + 600, iss: String(appId) })}`;
    return `${unsigned}.${base64url.encode(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await key, encoder.encode(unsigned))))}`;
  }

  async function gh(path, { method = 'GET', token, body }) {
    const response = await request(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'werft', ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub App ${method} ${path}: ${response.status} ${(await response.text()).slice(0, 200)}`), { github: response.status });
    return response.json();
  }

  async function issue() {
    const signed = await jwt();
    installation ??= gh(`/repos/${owner}/${repo}/installation`, { token: signed }).catch((e) => {
      installation = null;
      throw e.github === 404 ? new Error(`The GitHub App ${appId} is not installed on ${owner}/${repo}.`) : e;
    });
    const { id, app_slug: slug } = await installation;
    const access = await gh(`/app/installations/${id}/access_tokens`, { method: 'POST', token: signed, body: { repositories: [repo], permissions: { contents: 'write' } } }).catch((e) => {
      // Reinstalled: the next attempt looks the installation up again.
      if (e.github === 404) installation = null;
      throw e;
    });
    // The bot's user id is part of its commit e-mail address.
    bot ??= gh(`/users/${encodeURIComponent(`${slug}[bot]`)}`, { token: access.token }).catch((e) => { bot = null; throw e; });
    const { login, id: userId } = await bot;
    return { token: access.token, expires: Date.parse(access.expires_at), committer: { name: login, email: `${userId}+${login}@${noreply}` } };
  }

  return async () => {
    if (!pending || expires - now() < RENEW_BEFORE) {
      expires = Infinity;
      pending = issue().then((c) => { expires = c.expires; return c; }, (e) => { pending = null; throw e; });
    }
    const { token, committer } = await pending;
    return { token, committer };
  };
}
