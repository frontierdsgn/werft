// The werft gateway: the server half of the admin. It signs editors in with werft's own users and
// roles, serves the site's files to the editor and stores every change as a git commit through a
// storage driver (local git, GitHub). Its file API follows the shape of Gitea's REST API. It only
// uses the Fetch API (Request/Response) and Web Crypto, so the same code runs on Node, Cloudflare
// and Deno.
//
//   /api/werft/session                    POST: sign-in with e-mail and password → tokens (throttled,
//                                         see throttle.js), or with two-factor sign-in a ticket, then
//                                         { ticket, code }; DELETE: sign-out, { everywhere } for all
//                                         of one's sessions
//   /api/werft/me/two-factor              set up, renew recovery codes, switch off (see totp.js)
//   /api/werft/login/oauth/access_token   renews tokens (refresh-token grant)
//   /api/werft/password/forgot, …/reset   "Passwort vergessen?": a link by e-mail, then a new password
//   /api/werft/previews                   preview links of a page or post: list, create, revoke
//   /api/werft/preview/<token>            public: the page as saved, for someone without an account
//
// A session is an access token (12 hours, sent as "Authorization: token …") and a refresh token
// (30 days) in an HttpOnly cookie, so scripts on the site cannot read it. Both carry the session's
// id. Ended sessions are listed in .werft/sessions.json on the branch werft-sessions, away from the
// site's history: a sign-out adds its id, "everywhere" (by the user or an administrator) the time
// before which a user's sessions count as ended. Renewing a session reads the list; other requests
// use a copy at most SESSIONS_CHECK old. The same file lists the preview links until they expire or
// are revoked.
//   /api/werft/me, /api/werft/users       current user, POST: own name and password; user
//                                         management (administrators)
//   /api/werft/tick                       publish scheduled entries that are due
//   /api/werft/forms/<form>               form submissions from visitors (see submissions.js)
//   /api/werft/submissions                read and delete them (administrators and editors)
//   /api/werft/api/v1/repos/<o>/<r>/...   files, commits and saves (git/trees, file-contents, raw,
//                                         contents, commits)
import { USERS_FILE, DEFAULT_ITERATIONS, base64url, hashPassword, verifyPassword, signToken, readToken, stampOf, parseUsers, serializeUsers, findUser, publicUser } from './auth.js';
import { ROLES, denial, classify, editable, statuses } from './roles.js';
import { submissions } from './submissions.js';
import { previewTarget, renderPreview } from './preview.js';
import { throttle, addressKey } from './throttle.js';
import { newSecret, stepOf, otpauthURL, sealSecret, openSecret, newRecoveryCodes, recoveryHash } from './totp.js';
import { loadContent, isScheduled, siteLanguages } from '../lib/content.js';

const PREFIX = '/api/werft';
const ACCESS_TTL = 12 * 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const DEVICE_TTL = 365 * 24 * 3600;
export const SESSIONS_BRANCH = 'werft-sessions';
const SESSIONS_FILE = '.werft/sessions.json';
const SESSIONS_CHECK = 60 * 1000;
const COOKIE = 'werft_refresh';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const error = (status, message) => json({ message }, status);
const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function sha256(text) {
  return base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

// The gateway's view of a site (werft.config.js and its theme).
export const gatewaySite = (site, theme) => ({ twoFactor: site.twoFactor, name: site.name, contentDir: site.contentDir ?? site.content ?? 'content', postType: theme.postType?.name, mediaDirs: site.mediaDirs ?? [], languages: siteLanguages(site), base: site.base, admin: site.admin });

// options: { storage, secret, branch, site: { name, contentDir, postType, mediaDirs, languages? },
//   onCommit?(commit), onTick?(), tickKey?, maxFiles? (per save), now?(),
//   turnstileSecret? (forms need Cloudflare Turnstile), fetch? (for Turnstile),
//   mail? (an e-mail driver from mail.js; without it the gateway sends no e-mail),
//   throttleStore? (failed sign-ins shared between processes, see throttle.js),
//   render? ({ site, theme }: the site's configuration and theme, for preview links) }
// The returned handler takes the request and { address?, origin?, waitUntil? }: the client's address
// and the admin's origin as the host knows them (never from the request's Host header), and the
// host's way to finish work after the response (Cloudflare's waitUntil).

export function createGateway(options) {
  const { storage, secret, branch = 'main', site, onCommit, onTick, mail = null } = options;
  const now = options.now ?? (() => Date.now());
  if (!secret || secret.length < 32) throw new Error('WERFT_SECRET must be set to at least 32 characters.');

  // Users are read from the branch head; cached per head commit.
  let usersCache = { sha: null, users: [] };
  async function loadUsers() {
    const { sha } = await storage.head(branch);
    if (usersCache.sha !== sha) {
      const bytes = await storage.read(sha, USERS_FILE);
      usersCache = { sha, users: parseUsers(bytes && decoder.decode(bytes)) };
    }
    return usersCache;
  }

  // ---- Sessions ----
  let sessionsCache = { sha: undefined, at: -Infinity, ended: {}, users: {}, previews: {} };
  async function loadSessions(fresh = false) {
    if (!fresh && now() - sessionsCache.at < SESSIONS_CHECK) return sessionsCache;
    const sha = await storage.head(SESSIONS_BRANCH).then((h) => h.sha, (e) => { if (e.status === 404) return null; throw e; });
    if (sha === sessionsCache.sha) return Object.assign(sessionsCache, { at: now() });
    const bytes = sha && await storage.read(sha, SESSIONS_FILE);
    const data = bytes ? JSON.parse(decoder.decode(bytes)) : {};
    sessionsCache = { sha, at: now(), ended: data.ended ?? {}, users: data.users ?? {}, previews: data.previews ?? {} };
    return sessionsCache;
  }

  // Records ended sessions on the newest list, again when another sign-out came first. Entries of
  // tokens that have expired anyway are dropped.
  async function endSessions(user, change, message) {
    for (let attempt = 1; ; attempt++) {
      const { sha, ended, users, previews } = await loadSessions(true);
      const t = now();
      const next = {
        ended: Object.fromEntries(Object.entries(ended).filter(([, exp]) => exp * 1000 > t)),
        users: Object.fromEntries(Object.entries(users).filter(([, at]) => at > t - REFRESH_TTL * 1000)),
        previews: Object.fromEntries(Object.entries(previews).filter(([, link]) => link.exp * 1000 > t)),
      };
      change(next);
      try {
        const result = await storage.commit({ branch: SESSIONS_BRANCH, parent: sha, message, author: { name: user.name ?? user.email, email: user.email }, changes: [{ path: SESSIONS_FILE, data: encoder.encode(`${JSON.stringify(next, null, 2)}\n`) }] });
        sessionsCache = { sha: result.sha, at: now(), ...next };
        return;
      } catch (e) {
        if (e.status !== 409 || attempt === 3) throw e;
      }
    }
  }

  const sessionEnded = (sessions, payload) => !!sessions.ended[payload.sid] || (payload.iat ?? 0) <= (sessions.users[payload.sub.toLowerCase()] ?? -1);

  // The refresh token's cookie; Secure where the request came over HTTPS (not on `werft dev`), also
  // through a reverse proxy that says so (a client that claims it only affects its own cookie).
  const secure = (request) => new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
  const cookie = (request, value, maxAge) => `${COOKIE}=${value}; Path=${PREFIX}/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure(request) ? '; Secure' : ''}`;
  const cookieToken = (request) => (request.headers.get('cookie') ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

  // The tokens of a new session, or of a renewed one: same sid, and iat stays the time the session
  // began, so a renewal racing "everywhere" cannot carry a session past it.
  async function issueTokens(request, user, sid = base64url.encode(crypto.getRandomValues(new Uint8Array(12))), iat = now()) {
    const stamp = await stampOf(user);
    const t = Math.floor(now() / 1000);
    const common = { sub: user.email, stamp, sid, iat };
    const refresh = await signToken(secret, { typ: 'refresh', ...common, exp: t + REFRESH_TTL });
    return {
      body: { access_token: await signToken(secret, { typ: 'access', ...common, exp: t + ACCESS_TTL }), token_type: 'bearer', expires_in: ACCESS_TTL },
      headers: { 'set-cookie': cookie(request, refresh, REFRESH_TTL) },
    };
  }

  async function userFromToken(token, typ = 'access') {
    const payload = await readToken(secret, token, now());
    if (payload?.typ !== typ) return null;
    const user = findUser((await loadUsers()).users, payload.sub);
    if (!user || (await stampOf(user)) !== payload.stamp) return null;
    return sessionEnded(await loadSessions(typ === 'refresh'), payload) ? null : { ...user, payload };
  }

  async function authenticate(request) {
    const header = request.headers.get('authorization') ?? '';
    const token = header.replace(/^(token|bearer)\s+/i, '');
    return token ? userFromToken(token) : null;
  }

  const attempts = throttle({ secret, now, store: options.throttleStore });
  const tooMany = (wait, what = 'Anmeldeversuche') => {
    const minutes = Math.ceil(wait / 60000);
    return json({ message: `Zu viele ${what}. Bitte in ${minutes === 1 ? 'einer Minute' : `${minutes} Minuten`} noch einmal versuchen.` }, 429, { 'retry-after': String(Math.ceil(wait / 1000)) });
  };

  // A browser that signed in to an account gets a device token for it; its later attempts count
  // against that token instead of the account and the address, so guesses from elsewhere do not
  // lock the owner out.
  async function session(request, body, address) {
    if (body.ticket !== undefined) return secondFactor(request, body, address);
    const email = String(body.email ?? '').trim().toLowerCase();
    const device = await readToken(secret, body.device, now()).catch(() => null);
    const keys = device?.typ === 'device' && device.sub === email ? [['device', device.id]]
      : [['account', email], ...(addressKey(address) ? [['address', addressKey(address)]] : [])];
    const attempt = await attempts.attempt(keys);
    if (attempt.wait) return tooMany(attempt.wait);
    let user;
    try { user = await signIn(email, body.password); } catch (e) { attempt.cancel(); throw e; }
    if (!user) { await attempt.failed(); return error(401, 'E-Mail oder Passwort stimmt nicht.'); }
    await attempt.succeeded();
    // With two-factor sign-in the password only earns a ticket for five minutes; the code earns the session.
    if (user.totp) return json({ second_factor: true, ticket: await signToken(secret, { typ: 'mfa', sub: user.email, stamp: await stampOf(user), device: device?.typ === 'device' && device.sub === email ? device.id : undefined, exp: Math.floor(now() / 1000) + 300 }) });
    return started(request, user, device?.typ === 'device' && device.sub === email ? device.id : null);
  }

  // ---- Two-factor sign-in (totp.js) ----
  // The roles the site requires it of (werft.config.js `twoFactor`: true for administrators, or a
  // list of roles); until they set it up, their sessions reach only "Mein Konto".
  const mustUseTwoFactor = (user) => !user.totp && (site.twoFactor === true ? ['administrator'] : [site.twoFactor ?? []].flat()).includes(user.role);

  // The second step of a sign-in: the ticket and a code from the app, or a recovery code, which is
  // then used up. Codes count against the account like passwords; a code used once does not work
  // again in this process.
  const usedSteps = new Map();
  async function secondFactor(request, body, address) {
    const ticket = await readToken(secret, body.ticket, now()).catch(() => null);
    const again = () => error(401, 'Bitte melden Sie sich noch einmal an.');
    if (ticket?.typ !== 'mfa') return again();
    const { users, sha: parent } = await loadUsers();
    const user = findUser(users, ticket.sub);
    if (!user?.totp || (await stampOf(user)) !== ticket.stamp) return again();
    const email = user.email.toLowerCase();
    const attempt = await attempts.attempt([['totp', email], ...(addressKey(address) ? [['address', addressKey(address)]] : [])]);
    if (attempt.wait) return tooMany(attempt.wait, 'Versuche');
    const code = String(body.code ?? '').trim();
    let ok = false;
    try {
      if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
        const totpSecret = await openSecret(secret, user.totp);
        const step = totpSecret && await stepOf(totpSecret, code, now());
        ok = step != null && step > (usedSteps.get(email) ?? -1);
        if (ok) usedSteps.set(email, step);
      } else {
        const hash = await recoveryHash(secret, email, code);
        if ((user.recovery ?? []).includes(hash)) {
          await saveUsers(user, users.map((u) => (u === user ? { ...u, recovery: u.recovery.filter((h) => h !== hash) } : u)), `Wiederherstellungscode verwendet: ${user.email}`, parent);
          ok = true;
        }
      }
    } catch (e) {
      attempt.cancel();
      if (e.status === 409) return error(409, 'Der Stand hat sich inzwischen geändert. Bitte noch einmal versuchen.');
      throw e;
    }
    if (!ok) { await attempt.failed(); return error(401, 'Der Code stimmt nicht.'); }
    await attempt.succeeded();
    return started(request, user, ticket.device ?? null);
  }

  // "Zwei-Faktor-Anmeldung" in "Mein Konto": start (a new secret, sealed into a ticket for ten
  // minutes), enable (with a code from the app and the current password; returns the recovery
  // codes once), recovery (new codes), disable (not where the site requires it). Each change but
  // new codes ends the user's other sessions; this one goes on with new tokens.
  async function twoFactorApi(request, user) {
    const body = (await request.json()) ?? {};
    const { users, sha: parent } = await loadUsers();
    const existing = findUser(users, user.email);
    if (!existing || (await stampOf(existing)) !== user.payload.stamp) return error(401, 'Bitte anmelden.');
    if (body.action === 'start') {
      if (existing.totp) return error(422, 'Die Zwei-Faktor-Anmeldung ist schon eingerichtet.');
      const totpSecret = newSecret();
      const pending = await signToken(secret, { typ: 'totp-setup', sub: existing.email, secret: await sealSecret(secret, totpSecret), exp: Math.floor(now() / 1000) + 600 });
      return json({ secret: totpSecret, url: otpauthURL({ issuer: site.name ?? 'werft', account: existing.email, secret: totpSecret }), pending });
    }
    if (!['enable', 'disable', 'recovery'].includes(body.action)) return error(422, 'Unbekannte Aktion.');
    if (body.action === 'disable' && mustUseTwoFactor({ ...existing, totp: null })) return error(422, 'Auf dieser Website ist die Zwei-Faktor-Anmeldung für Ihre Rolle Pflicht.');
    if (body.action !== 'enable' && !existing.totp) return error(422, 'Die Zwei-Faktor-Anmeldung ist nicht eingerichtet.');
    const attempt = await attempts.attempt([user.payload.sid ? ['session', user.payload.sid] : ['account', user.email.toLowerCase()]]);
    if (attempt.wait) return tooMany(attempt.wait, 'Versuche');
    if (!(await verifyPassword(String(body.current_password ?? ''), existing.password))) { await attempt.failed(); return error(422, 'Das bisherige Passwort stimmt nicht.'); }
    let updated, codes = null;
    if (body.action === 'enable') {
      const pending = await readToken(secret, body.pending, now()).catch(() => null);
      const totpSecret = pending?.typ === 'totp-setup' && pending.sub === existing.email ? await openSecret(secret, pending.secret) : null;
      if (!totpSecret) { attempt.cancel(); return error(410, 'Die Einrichtung ist abgelaufen. Bitte noch einmal beginnen.'); }
      if ((await stepOf(totpSecret, body.code, now())) == null) { await attempt.failed(); return error(422, 'Der Code stimmt nicht. Bitte den aktuellen Code aus der App eingeben.'); }
      codes = newRecoveryCodes();
      updated = { ...existing, totp: pending.secret, recovery: await Promise.all(codes.map((c) => recoveryHash(secret, existing.email, c))) };
    } else if (body.action === 'recovery') {
      codes = newRecoveryCodes();
      updated = { ...existing, recovery: await Promise.all(codes.map((c) => recoveryHash(secret, existing.email, c))) };
    } else {
      const { totp, recovery, ...rest } = existing;
      updated = rest;
    }
    await attempt.succeeded();
    try {
      await saveUsers(user, users.map((u) => (u === existing ? updated : u)), `Zwei-Faktor-Anmeldung ${{ enable: 'eingerichtet', disable: 'ausgeschaltet', recovery: 'mit neuen Wiederherstellungscodes' }[body.action]}: ${existing.email}`, parent);
    } catch (e) {
      if (e.status === 409) return error(409, 'Der Stand hat sich inzwischen geändert. Bitte neu laden und erneut versuchen.');
      throw e;
    }
    const result = { ...publicUser(updated), ...(codes && { recovery_codes: codes }) };
    if (body.action === 'recovery') return json(result);
    const { body: tokens, headers } = await issueTokens(request, updated);
    return json({ ...result, ...tokens }, 200, headers);
  }

  // A signed-in session, with the device token of this browser for the account.
  async function started(request, user, deviceId) {
    const email = user.email.toLowerCase();
    const id = deviceId ?? base64url.encode(crypto.getRandomValues(new Uint8Array(12)));
    const deviceToken = await signToken(secret, { typ: 'device', sub: email, id, exp: Math.floor(now() / 1000) + DEVICE_TTL });
    const { body: tokens, headers } = await issueTokens(request, user);
    return json({ ...tokens, device: deviceToken, user: publicUser(user) }, 200, headers);
  }

  async function signIn(email, password) {
    const { users } = await loadUsers();
    const user = findUser(users, email);
    // Hash anyway when the user is unknown, as often as the first user's hash, so timing does not
    // reveal which e-mails exist.
    const first = Number(String(users[0]?.password ?? '').split('$')[1]);
    const iterations = first > 0 ? first : DEFAULT_ITERATIONS;
    const ok = await verifyPassword(password ?? '', user?.password ?? `pbkdf2-sha256$${iterations}$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
    return ok && user ? user : null;
  }

  // Renews the tokens of a session (OAuth 2 refresh-token grant), with the token from the cookie or,
  // as werft 0.5 kept it, from the body.
  async function accessToken(request) {
    const type = request.headers.get('content-type') ?? '';
    const body = type.includes('json') ? (await request.json()) ?? {} : Object.fromEntries(new URLSearchParams(await request.text()));
    if (body.grant_type !== 'refresh_token') return json({ error: 'unsupported_grant_type' }, 400);
    const user = await userFromToken(cookieToken(request) ?? body.refresh_token, 'refresh');
    if (!user) return json({ error: 'invalid_grant' }, 400, { 'set-cookie': cookie(request, '', 0) });
    const { body: tokens, headers } = await issueTokens(request, user, user.payload.sid, user.payload.iat ?? 0);
    return json(tokens, 200, headers);
  }

  // Ends the session of the access token or the refresh cookie, or all sessions of its user.
  async function signOut(request) {
    const user = (await authenticate(request)) ?? (await userFromToken(cookieToken(request), 'refresh'));
    const everywhere = (await request.json().catch(() => null))?.everywhere === true;
    // The cookie goes in any case; a failure says so, and the open page can try again with its
    // access token.
    const clear = { 'set-cookie': cookie(request, '', 0) };
    if (user && (everywhere || user.payload.sid)) {
      try {
        await endSessions(user, (next) => {
          if (everywhere) next.users[user.email.toLowerCase()] = now();
          else next.ended[user.payload.sid] = Math.floor(now() / 1000) + REFRESH_TTL;
        }, everywhere ? `Überall abgemeldet: ${user.email}` : `Abgemeldet: ${user.email}`);
      } catch (e) {
        console.error('werft gateway: sign-out:', e);
        return json({ message: 'Die Abmeldung hat nicht geklappt. Bitte noch einmal versuchen.' }, 503, clear);
      }
    }
    return json({ ok: true }, 200, clear);
  }

  // ---- Files ----
  async function resolveRef(ref) {
    if (!ref || ref === branch) return (await storage.head(branch)).sha;
    if (/^[0-9a-f]{40,64}$/.test(ref)) return ref;
    throw Object.assign(new Error(`Unknown ref ${ref}`), { status: 404 });
  }

  const visible = (path) => classify(path, site) !== 'private';

  async function treeAt(sha) {
    return (await storage.tree(sha)).filter((e) => visible(e.path));
  }

  const readMany = (sha, paths) => (storage.readMany ? storage.readMany(sha, paths) : Promise.all(paths.map((p) => storage.read(sha, p))));

  async function changeFiles(user, body) {
    if ((body.branch ?? branch) !== branch || body.new_branch) return error(422, `Only the ${branch} branch can be changed.`);
    const head = await storage.head(branch);
    const files = await treeAt(head.sha);
    const blobOf = (p) => files.find((f) => f.path === p);
    if (options.maxFiles && (body.files ?? []).length > options.maxFiles) {
      return error(413, `Bitte höchstens ${options.maxFiles} Dateien auf einmal speichern oder hochladen.`);
    }
    const changes = [];
    const touched = new Set();
    for (const file of body.files ?? []) {
      const path = String(file.path ?? '').replace(/^\/+/, '');
      if (!path || path.split('/').some((s) => s === '..' || s === '.')) return error(422, `Invalid path ${file.path}`);
      if (!visible(path)) return error(403, 'Dieser Bereich ist geschützt.');
      const data = file.operation === 'delete' ? null : fromBase64(file.content ?? '');
      const source = file.from_path && file.from_path !== path ? String(file.from_path).replace(/^\/+/, '') : path;
      if (source.split('/').some((s) => s === '..' || s === '.' || s === '') || !visible(source)) return error(422, `Invalid path ${file.from_path}`);
      // Each path once per save, so no change can slip past the checks of another.
      for (const p of new Set([source, path])) { if (touched.has(p)) return error(422, `${p} appears twice.`); touched.add(p); }
      const existing = blobOf(source);
      // A new file, or a renamed one, must not replace a file that is already there.
      if ((file.operation === 'create' || source !== path) && blobOf(path)) return error(422, `${path} already exists.`);
      if (file.operation !== 'create') {
        if (!existing) return error(404, `${source} does not exist.`);
        if (file.sha && file.sha !== existing.sha) return error(409, `${source} was changed by someone else.`);
      }
      // Who added a post and whether it was published only matter to authors and contributors, and
      // each costs a storage request.
      const ownPostsOnly = ['author', 'contributor'].includes(user.role) && file.operation !== 'create' && classify(source, site) === 'post';
      const creator = ownPostsOnly ? await storage.creator(branch, source) : null;
      const old = ownPostsOnly && user.role === 'contributor' ? decoder.decode(await storage.read(head.sha, source)) : '';
      const wasPublished = !!old && (() => { try { return (JSON.parse(old).status ?? 'published') === 'published'; } catch { return true; } })();
      for (const [p, operation] of source !== path ? [[source, 'delete'], [path, 'create']] : [[path, file.operation]]) {
        const reason = denial(user, { operation, path: p, text: data && decoder.decode(data), creator, wasPublished }, site);
        if (reason) return error(403, reason);
      }
      if (source !== path) changes.push({ path: source, data: null });
      changes.push({ path, data });
    }
    if (!changes.length) return error(422, 'No changes.');
    const message = String(body.message ?? 'Update content').slice(0, 2000);
    let result;
    try {
      result = await storage.commit({ branch, parent: head.sha, message, author: { name: user.name ?? user.email, email: user.email }, changes });
    } catch (e) {
      if (e.status === 409) return error(409, 'Der Stand hat sich inzwischen geändert. Bitte neu laden.');
      throw e;
    }
    await onCommit?.({ ...result, message, author: user.email, paths: changes.map((c) => c.path) });
    return json({
      commit: { sha: result.sha, created: result.date, message, parents: [{ sha: head.sha }] },
      files: (body.files ?? []).map((f) => (f.operation === 'delete' ? null : { path: f.path, sha: result.blobs[f.path] ?? '', type: 'file' })),
    }, 201);
  }

  const giteaCommit = (c) => ({
    sha: c.sha, created: c.date,
    commit: { message: c.message, author: { name: c.author.name, email: c.author.email, date: c.date } },
  });

  async function gitea(request, url, user, rest) {
    const method = request.method;
    const match = rest.match(/^\/repos\/[^/]+\/[^/]+(\/.*)$/);
    if (!match) return error(404, 'Not found');
    const sub = match[1];
    const q = url.searchParams;
    if (sub.startsWith('/git/trees/')) {
      const sha = await resolveRef(decodeURIComponent(sub.slice(11)));
      const page = Number(q.get('page') ?? 1);
      const tree = page > 1 ? [] : (await treeAt(sha)).map(({ path, mode, sha: s, size }) => ({ path, mode, type: 'blob', sha: s, size }));
      return json({ sha, tree, truncated: false, page, total_count: tree.length });
    }
    if (sub === '/file-contents' && method === 'POST') {
      const sha = await resolveRef(q.get('ref'));
      const files = await treeAt(sha);
      const { files: paths = [] } = await request.json();
      const entries = paths.map((p) => files.find((f) => f.path === p) ?? null);
      const contents = await readMany(sha, entries.filter(Boolean).map((e) => e.path));
      return json(entries.map((entry) => {
        if (!entry) return null;
        const bytes = contents.shift();
        return { name: entry.path.split('/').pop(), path: entry.path, sha: entry.sha, type: 'file', size: entry.size, encoding: 'base64', content: toBase64(bytes) };
      }));
    }
    if (sub.startsWith('/raw/')) {
      const path = decodeURIComponent(sub.slice(5));
      const bytes = visible(path) && await storage.read(await resolveRef(q.get('ref')), path);
      return bytes ? new Response(bytes, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }) : error(404, 'Not found');
    }
    if (sub === '/contents' && method === 'POST') return changeFiles(user, await request.json());
    if (sub === '/commits') {
      const path = q.get('path') ?? '';
      if (path && !visible(path)) return json([]);
      const limit = Math.min(Number(q.get('limit') ?? 30), 100);
      return json((await storage.log({ branch, path, limit })).map(giteaCommit));
    }
    return error(404, 'Not found');
  }

  // ---- werft's own API ----
  // parent: the commit the users were read from, so a concurrent change fails instead of being undone.
  async function saveUsers(admin, users, message, parent) {
    const result = await storage.commit({ branch, parent, message, author: { name: admin.name ?? admin.email, email: admin.email }, changes: [{ path: USERS_FILE, data: encoder.encode(serializeUsers(users)) }] });
    usersCache = { sha: null, users: [] };
    return result;
  }

  // "Mein Konto": every user changes their own name and, with the current password, their own
  // password; nothing else and nobody else's. Checking the current password counts like a sign-in
  // attempt. A new password ends the user's other sessions (see stampOf); this one goes on with new
  // tokens.
  async function account(request, user) {
    const body = (await request.json()) ?? {};
    const other = body.email !== undefined && String(body.email).trim().toLowerCase() !== user.email.toLowerCase();
    if (typeof body !== 'object' || other || Object.keys(body).some((k) => !['email', 'name', 'password', 'current_password'].includes(k))) return error(403, 'Hier ändern Sie nur Ihren eigenen Namen und Ihr Passwort.');
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) return error(422, 'Bitte einen Namen angeben.');
    if (body.name?.trim().length > 100) return error(422, 'Der Name darf höchstens 100 Zeichen haben.');
    if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length < 10)) return error(422, 'Passwörter brauchen mindestens 10 Zeichen.');
    // The entry as it is now, and the commit it was read from: a change in between (an administrator
    // setting a new password) fails with 409 instead of being undone, and a session the change has
    // ended may not change anything.
    const { users, sha: parent } = await loadUsers();
    const existing = findUser(users, user.email);
    if (!existing || (await stampOf(existing)) !== user.payload.stamp) return error(401, 'Bitte anmelden.');
    const name = body.name?.trim() ?? existing.name;
    let { password } = existing;
    if (body.password !== undefined) {
      // Guesses count against this session (an older one without an id: the account), so guessing
      // elsewhere does not keep the owner from changing the password.
      const attempt = await attempts.attempt([user.payload.sid ? ['session', user.payload.sid] : ['account', user.email.toLowerCase()]]);
      if (attempt.wait) return tooMany(attempt.wait, 'Versuche');
      if (!(await verifyPassword(String(body.current_password ?? ''), existing.password))) { await attempt.failed(); return error(422, 'Das bisherige Passwort stimmt nicht.'); }
      await attempt.succeeded();
      password = await hashPassword(body.password, options.iterations);
    }
    if (name === existing.name && password === existing.password) return json(publicUser(existing));
    const updated = { ...existing, name, password };
    try {
      await saveUsers(user, users.map((u) => (u === existing ? updated : u)), `Konto geändert: ${user.email}`, parent);
    } catch (e) {
      if (e.status === 409) return error(409, 'Der Stand hat sich inzwischen geändert. Bitte neu laden und erneut versuchen.');
      throw e;
    }
    if (password === existing.password) return json(publicUser(updated));
    const { body: tokens, headers } = await issueTokens(request, updated);
    return json({ ...publicUser(updated), ...tokens }, 200, headers);
  }

  // "Passwort vergessen?": a link to the admin with a token that is signed, lasts RESET_TTL and is
  // tied to the password hash (its stamp), so it no longer works once a password was set with it
  // or otherwise. The reply is the same whether the address has an account or not, and the e-mail
  // goes out after it (waitUntil), so its timing does not tell either. Requests count against the
  // address entered and the client's address, like sign-ins.
  const RESET_TTL = 3600;
  const SENT = 'Wenn es zu dieser Adresse ein Konto gibt, ist eine E-Mail mit einem Link unterwegs. Der Link gilt eine Stunde.';

  // The admin's address, at the root of the host whatever the site's base (the build puts it at
  // <output>/<admin>/): on the origin the host vouches for, else on that of the site's own address
  // (the site setting `url`), else none.
  async function adminLink(origin) {
    if (site.admin === false) return null;
    const dir = `/${site.admin ?? 'admin'}/`;
    const bytes = await storage.read((await storage.head(branch)).sha, `${site.contentDir}/settings/site.json`);
    if (origin) return `${origin}${dir}`;
    const url = (() => { try { return JSON.parse(decoder.decode(bytes)).url; } catch { return null; } })();
    return /^https?:\/\//.test(url ?? '') ? new URL(dir, url).href : null;
  }

  async function forgotPassword(body, { address, origin, waitUntil }) {
    if (!mail) return error(503, 'Diese Website verschickt keine E-Mails. Ein Administrator kann Ihnen ein neues Passwort geben.');
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return error(422, 'Bitte eine gültige E-Mail-Adresse angeben.');
    const attempt = await attempts.attempt([['reset', email], ...(addressKey(address) ? [['address', addressKey(address)]] : [])]);
    if (attempt.wait) return tooMany(attempt.wait, 'Anfragen');
    await attempt.failed();
    // The same reads with and without an account.
    const [{ users }, link] = await Promise.all([loadUsers(), adminLink(origin)]);
    const user = findUser(users, email);
    if (user && link) {
      // Even the token is made after the reply.
      const sending = (async () => {
        const token = await signToken(secret, { typ: 'reset', sub: user.email, stamp: await stampOf(user), exp: Math.floor(now() / 1000) + RESET_TTL });
        await mail.send({
          to: user.email, fromName: site.name,
          subject: `Neues Passwort für ${site.name ?? 'die Website'}`,
          text: `Hallo ${user.name ?? ''},\n\njemand, hoffentlich Sie, möchte ein neues Passwort für ${site.name ?? 'die Website'} festlegen. Mit diesem Link geht das, eine Stunde lang und nur einmal:\n\n${link}#passwort=${token}\n\nWenn Sie das nicht waren, können Sie diese E-Mail löschen. Ihr Passwort bleibt dann, wie es ist.\n`,
        });
      })().catch((e) => console.error('werft gateway: reset e-mail:', e.message));
      if (waitUntil) waitUntil(sending);
    } else if (user) {
      console.error('werft gateway: no address for a reset link; set the site setting url.');
    }
    return json({ message: SENT });
  }

  async function resetPassword(request, body) {
    const payload = await readToken(secret, body.token, now()).catch(() => null);
    const { users, sha: parent } = await loadUsers();
    const user = payload?.typ === 'reset' && findUser(users, payload.sub);
    if (!user || (await stampOf(user)) !== payload.stamp) return error(410, 'Dieser Link gilt nicht mehr. Bitte fordern Sie einen neuen an.');
    if (typeof body.password !== 'string' || body.password.length < 10) return error(422, 'Passwörter brauchen mindestens 10 Zeichen.');
    const updated = { ...user, password: await hashPassword(body.password, options.iterations) };
    try {
      await saveUsers(user, users.map((u) => (u === user ? updated : u)), `Neues Passwort: ${user.email}`, parent);
    } catch (e) {
      if (e.status === 409) return error(409, 'Der Stand hat sich inzwischen geändert. Bitte noch einmal versuchen.');
      throw e;
    }
    // With two-factor sign-in the link sets the password only; the code still earns the session.
    if (updated.totp) return json({ second_factor: true, ticket: await signToken(secret, { typ: 'mfa', sub: updated.email, stamp: await stampOf(updated), exp: Math.floor(now() / 1000) + 300 }) });
    const { body: tokens, headers } = await issueTokens(request, updated);
    return json({ ...tokens, user: publicUser(updated) }, 200, headers);
  }

  // ---- Preview links ----
  // A link to one page or post as saved, for people without an account: signed, expiring after 1
  // to 30 days, and listed in the sessions file until it expires or is revoked; a view checks the
  // list as it is now. Whoever may change the entry may share and revoke its links.
  const PREVIEW_DAYS = [1, 7, 30];
  const previewURL = async (id, link) => `${PREFIX}/preview/${await signToken(secret, { typ: 'preview', id, path: link.path, exp: link.exp })}`;

  async function mayChange(user, path) {
    if (!previewTarget(path, site)) return 'Vorschau-Links gibt es für Seiten und Beiträge.';
    const head = await storage.head(branch);
    const bytes = await storage.read(head.sha, path);
    if (!bytes) return 'Diesen Eintrag gibt es nicht (mehr). Bitte erst speichern.';
    const text = decoder.decode(bytes);
    const ownPostsOnly = ['author', 'contributor'].includes(user.role);
    const creator = ownPostsOnly ? await storage.creator(branch, path) : null;
    return denial(user, { operation: 'update', path, text, creator }, site);
  }

  async function previewsApi(request, url, user) {
    const body = request.method === 'POST' ? (await request.json()) ?? {} : {};
    const path = String(body.path ?? url.searchParams.get('path') ?? '').replace(/^\/+/, '');
    if (!options.render) return error(501, 'Diese Website zeigt keine Vorschau-Links.');
    const reason = await mayChange(user, path);
    if (reason) return error(403, reason);
    const list = async () => Promise.all(Object.entries((await loadSessions(true)).previews)
      .filter(([, link]) => link.path === path && link.exp * 1000 > now())
      .map(async ([id, link]) => ({ id, url: await previewURL(id, link), expires_at: new Date(link.exp * 1000).toISOString(), by: link.by })));
    if (request.method !== 'POST') return json({ previews: await list() });
    if (body.revoke !== undefined) {
      const id = String(body.revoke);
      if ((await loadSessions(true)).previews[id]?.path !== path) return error(404, 'Diesen Link gibt es nicht (mehr).');
      await endSessions(user, (next) => { delete next.previews[id]; }, `Vorschau-Link widerrufen: ${path}`);
    } else {
      const days = PREVIEW_DAYS.includes(Number(body.days)) ? Number(body.days) : 7;
      const id = base64url.encode(crypto.getRandomValues(new Uint8Array(12)));
      const link = { path, exp: Math.floor(now() / 1000) + days * 24 * 3600, by: user.email };
      await endSessions(user, (next) => { next.previews[id] = link; }, `Vorschau-Link: ${path}`);
    }
    return json({ previews: await list() });
  }

  // The page for a preview link; anything that does not work, the same "no longer valid" page.
  async function showPreview(encoded) {
    const gone = () => new Response('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Vorschau</title><body style="font:17px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px"><p lang="de">Dieser Vorschau-Link gilt nicht mehr.</p>', { status: 410, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
    let html;
    try {
      const payload = await readToken(secret, decodeURIComponent(encoded), now()).catch(() => null);
      const link = payload?.typ === 'preview' && (await loadSessions(true)).previews[payload.id];
      const target = link && link.path === payload.path && link.exp * 1000 > now() && options.render && previewTarget(link.path, site);
      if (!target) return gone();
      const head = await storage.head(branch);
      const tree = await treeAt(head.sha);
      const files = tree.filter((f) => f.path.startsWith(`${site.contentDir}/`));
      // Which media exist, for ctx.exists() (no sizes: like the editor's preview).
      const media = Object.fromEntries(tree.filter((f) => (site.mediaDirs ?? []).some((d) => f.path.startsWith(`${d}/`))).map((f) => [f.path, {}]));
      html = await renderPreview({
        site: options.render.site, theme: options.render.theme, target, files, media, now: new Date(now()),
        read: async (paths) => (await readMany(head.sha, paths)).map((b) => b && decoder.decode(b)),
      });
    } catch (e) {
      console.error('werft gateway: preview:', e);
      // The repository could not be read: try again later; anything else (a theme that fails): gone.
      if (e.github || e.status >= 500) return new Response('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Vorschau</title><body style="font:17px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px"><p lang="de">Die Vorschau ist gerade nicht erreichbar. Bitte in ein paar Minuten noch einmal versuchen.</p>', { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'retry-after': '60' } });
      return gone();
    }
    if (html == null) return gone();
    // The page runs in a sandbox with an origin of its own: whatever the entry's markup contains
    // cannot act on the admin's origin (its refresh cookie, its API). No referrer, so the token does
    // not travel to the hosts of the page's images or fonts.
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer', 'content-security-policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms' } });
  }

  async function usersApi(request, user) {
    if (user.role !== 'administrator') return error(403, 'Nur Administratoren verwalten Benutzer.');
    const { users, sha: parent } = await loadUsers();
    if (request.method === 'GET') return json({ users: users.map(publicUser), roles: ROLES });
    const body = await request.json();
    const email = String(body.email ?? '').trim();
    const existing = findUser(users, email);
    let next;
    if (body.action === 'signout') {
      if (!existing) return error(404, 'Unbekannter Benutzer.');
      try {
        await endSessions(user, (sessions) => { sessions.users[existing.email.toLowerCase()] = now(); }, `Überall abgemeldet: ${existing.email}`);
      } catch (e) {
        if (e.status === 409) return error(409, 'Gerade melden sich viele ab. Bitte noch einmal versuchen.');
        throw e;
      }
      return json({ users: users.map(publicUser) });
    }
    if (body.action === 'delete') {
      if (!existing) return error(404, 'Unbekannter Benutzer.');
      if (existing.email === user.email) return error(422, 'Sie können sich nicht selbst löschen.');
      next = users.filter((u) => u !== existing);
    } else if (body.action === 'two-factor-off') {
      // For someone who lost their phone and their recovery codes; ends their sessions.
      if (!existing?.totp) return error(404, 'Diese Person hat keine Zwei-Faktor-Anmeldung.');
      const { totp, recovery, ...rest } = existing;
      next = users.map((u) => (u === existing ? rest : u));
    } else {
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return error(422, 'Bitte eine gültige E-Mail-Adresse angeben.');
      if (body.role && !ROLES[body.role]) return error(422, 'Unbekannte Rolle.');
      if (!existing && !body.password) return error(422, 'Neue Benutzer brauchen ein Passwort.');
      if (body.password && String(body.password).length < 10) return error(422, 'Passwörter brauchen mindestens 10 Zeichen.');
      if (existing?.email === user.email && body.role && body.role !== 'administrator') return error(422, 'Sie können sich die Administratorrolle nicht selbst nehmen.');
      const updated = { ...existing, email: existing?.email ?? email, name: body.name ?? existing?.name ?? email, role: body.role ?? existing?.role ?? 'contributor' };
      if (body.password) updated.password = await hashPassword(String(body.password), options.iterations);
      next = existing ? users.map((u) => (u === existing ? updated : u)) : [...users, updated];
    }
    try {
      await saveUsers(user, next, `Benutzer ${body.action === 'delete' ? 'gelöscht' : body.action === 'two-factor-off' ? 'ohne Zwei-Faktor-Anmeldung' : existing ? 'geändert' : 'angelegt'}: ${email}`, parent);
    } catch (e) {
      if (e.status === 409) return error(409, 'Der Stand hat sich inzwischen geändert. Bitte neu laden und erneut versuchen.');
      throw e;
    }
    return json({ users: next.map(publicUser) });
  }

  // Due entries already handed to the host for a rebuild, so repeated calls (every admin page load)
  // do not start one build after another while the first runs. A rebuild that did not happen is
  // asked for again after RETRY_TICK.
  let ticked = { key: '', at: 0 };
  const RETRY_TICK = 15 * 60 * 1000;

  // Publishes due scheduled entries by asking the host to rebuild once an entry's publish date has
  // passed since the last build. Signed-in users and holders of options.tickKey may call it.
  async function tick(url) {
    const head = await storage.head(branch);
    const files = (await treeAt(head.sha)).filter((f) => f.path.startsWith(`${site.contentDir}/`));
    const texts = new Map((await readMany(head.sha, files.map((f) => f.path))).map((b, i) => [files[i].path, b && decoder.decode(b)]));
    const store = {
      list: async (dir) => files.filter((f) => f.path.startsWith(`${dir}/`)).map((f) => f.path.slice(dir.length + 1)),
      readText: async (p) => { if (texts.get(p) == null) throw Object.assign(new Error(p), { status: 404 }); return texts.get(p); },
    };
    const content = await loadContent({ site: { contentDir: site.contentDir, languages: site.languages }, theme: { postType: site.postType ? { name: site.postType } : undefined }, store });
    const entries = [content, ...Object.values(content.languages ?? {})].flatMap((c) => [...c.pages, ...(c.posts ?? [])]);
    const lastBuild = await options.lastBuild?.(url);
    const due = entries.filter((e) => e.publish_date && (e.status ?? 'published') === 'published'
      && Date.parse(e.publish_date) <= now() && (!lastBuild || Date.parse(e.publish_date) > Date.parse(lastBuild)));
    const next = entries.filter((e) => isScheduled(e, new Date(now()))).map((e) => e.publish_date).sort()[0] ?? null;
    const key = JSON.stringify([lastBuild, due.map((e) => e.slug)]);
    const pending = due.length > 0 && ticked.key === key && now() - ticked.at < RETRY_TICK;
    // onTick returns false when the host cannot rebuild on request.
    const rebuilt = due.length > 0 && !pending && !!onTick && (await onTick({ due: due.map((e) => e.slug) })) !== false;
    if (rebuilt) ticked = { key, at: now() };
    return json({ rebuilt, pending, due: due.map((e) => e.slug), next_publish: next, last_build: lastBuild ?? null });
  }

  const forms = submissions({ storage, branch, site, now, secret, mail, turnstileSecret: options.turnstileSecret, fetch: options.fetch });

  return async function handle(request, { address, origin, waitUntil } = {}) {
    const url = new URL(request.url);
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
    const path = url.pathname.slice(PREFIX.length);
    try {
      if (path === '/login/oauth/access_token' && request.method === 'POST') return await accessToken(request);
      if (path === '/session' && request.method === 'POST') return await session(request, (await request.json()) ?? {}, address);
      if (path === '/session' && request.method === 'DELETE') return await signOut(request);
      if (path.startsWith('/preview/') && request.method === 'GET') return await showPreview(path.slice(9));
      if (path === '/password/forgot' && request.method === 'POST') return await forgotPassword((await request.json()) ?? {}, { address, origin, waitUntil });
      if (path === '/password/reset' && request.method === 'POST') return await resetPassword(request, (await request.json()) ?? {});
      if (path === '/tick' && options.tickKey && url.searchParams.get('key')
        && (await sha256(url.searchParams.get('key'))) === (await sha256(options.tickKey))) return await tick(url);
      if (path.startsWith('/forms/')) return await forms.receive(request, url, decodeURIComponent(path.slice(7)));
      if (path === '/status') return json({ ok: true, storage: storage.kind, branch, has_users: (await loadUsers()).users.length > 0, mail: !!mail });
      const user = await authenticate(request);
      if (!user) return error(401, 'Bitte anmelden.');
      if (path === '/me/two-factor' && request.method === 'POST') return await twoFactorApi(request, user);
      if (mustUseTwoFactor(user) && path !== '/me') return json({ message: 'Bitte richten Sie zuerst die Zwei-Faktor-Anmeldung ein (Mein Konto).', code: 'two_factor_setup' }, 403);
      if (path === '/tick') return await tick(url);
      if (path === '/me' && request.method === 'POST') return await account(request, user);
      if (path === '/me') return json({ ...publicUser(user), two_factor_required: mustUseTwoFactor(user), two_factor_mandatory: mustUseTwoFactor({ ...user, totp: null }), recovery_left: user.totp ? (user.recovery ?? []).length : null, editable: editable(user.role), statuses: statuses(user.role), roles: ROLES });
      if (path === '/users') return await usersApi(request, user);
      if (path === '/previews') return await previewsApi(request, url, user);
      if (path === '/submissions') return await forms.api(request, user);
      if (path.startsWith('/api/v1/')) return await gitea(request, url, user, path.slice(7));
      return error(404, 'Not found');
    } catch (e) {
      if (e.status && e.status < 500) return error(e.status, e.message);
      console.error('werft gateway:', e);
      return error(500, 'Interner Fehler im Gateway.');
    }
  };
}
