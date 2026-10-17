// The werft gateway: the server half of the admin. It signs editors in with werft's own users and
// roles, serves the site's files to the editor and stores every change as a git commit through a
// storage driver (local git, GitHub). Its file API follows the shape of Gitea's REST API. It only
// uses the Fetch API (Request/Response) and Web Crypto, so the same code runs on Node, Cloudflare
// and Deno.
//
//   /api/werft/session                    sign-in with e-mail and password → tokens
//   /api/werft/login/oauth/access_token   renews tokens (refresh-token grant)
//   /api/werft/me, /api/werft/users       current user; user management (administrators)
//   /api/werft/tick                       publish scheduled entries that are due
//   /api/werft/forms/<form>               form submissions from visitors (see submissions.js)
//   /api/werft/submissions                read and delete them (administrators and editors)
//   /api/werft/api/v1/repos/<o>/<r>/...   files, commits and saves (git/trees, file-contents, raw,
//                                         contents, commits)
import { USERS_FILE, base64url, hashPassword, verifyPassword, signToken, readToken, stampOf, parseUsers, serializeUsers, findUser, publicUser } from './auth.js';
import { ROLES, denial, classify, editable, statuses } from './roles.js';
import { submissions } from './submissions.js';
import { loadContent, isScheduled } from '../lib/content.js';

const PREFIX = '/api/werft';
const ACCESS_TTL = 12 * 3600;
const REFRESH_TTL = 30 * 24 * 3600;

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
export const gatewaySite = (site, theme) => ({ name: site.name, contentDir: site.contentDir ?? site.content ?? 'content', postType: theme.postType?.name, mediaDirs: site.mediaDirs ?? [] });

// options: { storage, secret, branch, site: { name, contentDir, postType, mediaDirs },
//   onCommit?(commit), onTick?(), tickKey?, maxFiles? (per save), now?(),
//   turnstileSecret? (forms need Cloudflare Turnstile), fetch? (for Turnstile) }
export function createGateway(options) {
  const { storage, secret, branch = 'main', site, onCommit, onTick } = options;
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

  async function issueTokens(user) {
    const stamp = await stampOf(user);
    const t = Math.floor(now() / 1000);
    return {
      access_token: await signToken(secret, { typ: 'access', sub: user.email, stamp, exp: t + ACCESS_TTL }),
      refresh_token: await signToken(secret, { typ: 'refresh', sub: user.email, stamp, exp: t + REFRESH_TTL }),
      token_type: 'bearer',
      expires_in: ACCESS_TTL,
    };
  }

  async function userFromToken(token, typ = 'access') {
    const payload = await readToken(secret, token, now());
    if (payload?.typ !== typ) return null;
    const user = findUser((await loadUsers()).users, payload.sub);
    return user && (await stampOf(user)) === payload.stamp ? { ...user, payload } : null;
  }

  async function authenticate(request) {
    const header = request.headers.get('authorization') ?? '';
    const token = header.replace(/^(token|bearer)\s+/i, '');
    return token ? userFromToken(token) : null;
  }

  async function signIn(email, password) {
    const user = findUser((await loadUsers()).users, email);
    // Hash anyway when the user is unknown, so timing does not reveal which e-mails exist.
    const ok = await verifyPassword(password ?? '', user?.password ?? 'pbkdf2-sha256$1000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    return ok && user ? user : null;
  }

  // Renews the tokens of a session (OAuth 2 refresh-token grant).
  async function accessToken(request) {
    const type = request.headers.get('content-type') ?? '';
    const body = type.includes('json') ? await request.json() : Object.fromEntries(new URLSearchParams(await request.text()));
    if (body.grant_type !== 'refresh_token') return json({ error: 'unsupported_grant_type' }, 400);
    const user = await userFromToken(body.refresh_token, 'refresh');
    return user ? json(await issueTokens(user)) : json({ error: 'invalid_grant' }, 400);
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

  async function usersApi(request, user) {
    if (user.role !== 'administrator') return error(403, 'Nur Administratoren verwalten Benutzer.');
    const { users, sha: parent } = await loadUsers();
    if (request.method === 'GET') return json({ users: users.map(publicUser), roles: ROLES });
    const body = await request.json();
    const email = String(body.email ?? '').trim();
    const existing = findUser(users, email);
    let next;
    if (body.action === 'delete') {
      if (!existing) return error(404, 'Unbekannter Benutzer.');
      if (existing.email === user.email) return error(422, 'Sie können sich nicht selbst löschen.');
      next = users.filter((u) => u !== existing);
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
      await saveUsers(user, next, `Benutzer ${body.action === 'delete' ? 'gelöscht' : existing ? 'geändert' : 'angelegt'}: ${email}`, parent);
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
    const content = await loadContent({ site: { contentDir: site.contentDir }, theme: { postType: site.postType ? { name: site.postType } : undefined }, store });
    const entries = [...content.pages, ...content.posts];
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

  const forms = submissions({ storage, branch, site, now, turnstileSecret: options.turnstileSecret, fetch: options.fetch });

  return async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
    const path = url.pathname.slice(PREFIX.length);
    try {
      if (path === '/login/oauth/access_token' && request.method === 'POST') return await accessToken(request);
      if (path === '/session' && request.method === 'POST') {
        const { email, password } = await request.json();
        const user = await signIn(email, password);
        return user ? json({ ...(await issueTokens(user)), user: publicUser(user) }) : error(401, 'E-Mail oder Passwort stimmt nicht.');
      }
      if (path === '/tick' && options.tickKey && url.searchParams.get('key')
        && (await sha256(url.searchParams.get('key'))) === (await sha256(options.tickKey))) return await tick(url);
      if (path.startsWith('/forms/')) return await forms.receive(request, url, decodeURIComponent(path.slice(7)));
      if (path === '/status') return json({ ok: true, storage: storage.kind, branch, has_users: (await loadUsers()).users.length > 0 });
      const user = await authenticate(request);
      if (!user) return error(401, 'Bitte anmelden.');
      if (path === '/tick') return await tick(url);
      if (path === '/me') return json({ ...publicUser(user), editable: editable(user.role), statuses: statuses(user.role), roles: ROLES });
      if (path === '/users') return await usersApi(request, user);
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
