// The werft gateway: the server half of the admin. It speaks the subset of the Gitea REST API that
// Sveltia CMS's Gitea backend uses, signs editors in with werft's own users and roles, and stores
// every change as a git commit through a storage driver (local git, GitHub). It only uses the Fetch
// API (Request/Response) and Web Crypto, so the same code runs on Node, Cloudflare and Deno.
//
//   /api/werft/login/oauth/authorize      sign-in page (OAuth 2 authorization code + PKCE)
//   /api/werft/login/oauth/access_token   token endpoint (code and refresh-token grants)
//   /api/werft/session                    sign-in with e-mail and password → tokens (admin page)
//   /api/werft/me, /api/werft/users       current user; user management (administrators)
//   /api/werft/tick                       publish scheduled entries that are due
//   /api/werft/api/v1/...                 Gitea API subset
import { USERS_FILE, base64url, hashPassword, verifyPassword, signToken, readToken, stampOf, parseUsers, serializeUsers, findUser, publicUser } from './auth.js';
import { ROLES, denial, classify, editable } from './roles.js';
import { loginPage } from './login-page.js';
import { loadContent, isScheduled } from '../lib/content.js';

const PREFIX = '/api/werft';
const ACCESS_TTL = 12 * 3600;
const REFRESH_TTL = 30 * 24 * 3600;
const CODE_TTL = 120;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', pdf: 'application/pdf', json: 'application/json', md: 'text/markdown', txt: 'text/plain', html: 'text/html', css: 'text/css', js: 'text/javascript' };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const error = (status, message) => json({ message }, status);
const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const numericId = (email) => [...email].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) || 1;
const avatar = (name) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#231f1b"/><text x="20" y="26" font-family="sans-serif" font-size="18" fill="#faf4e8" text-anchor="middle">${(name || '?').trim()[0].toUpperCase().replace(/[<&]/, '?')}</text></svg>`)}`;

async function sha256(text) {
  return base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

// options: { storage, secret, branch, site: { name, contentDir, postType, mediaDirs }, owner, repo,
//   onCommit?(commit), onTick?(), now?() }
export function createGateway(options) {
  const { storage, secret, branch = 'main', site, onCommit, onTick } = options;
  const owner = options.owner ?? 'werft';
  const repo = options.repo ?? 'site';
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

  // ---- OAuth (for Sveltia's own "Sign in" button) ----
  async function authorize(request, url) {
    const params = request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams;
    const query = Object.fromEntries(['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'response_type'].map((k) => [k, params.get(k) ?? '']));
    const redirect = (() => { try { return new URL(query.redirect_uri); } catch { return null; } })();
    // The CMS must live on the same origin as the gateway.
    if (!redirect || redirect.origin !== url.origin) return error(400, 'redirect_uri must be on this site.');
    if (request.method !== 'POST') return new Response(loginPage({ site: site.name, query }), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    const user = await signIn(params.get('email'), params.get('password'));
    if (!user) return new Response(loginPage({ site: site.name, query, email: params.get('email'), failed: true }), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const code = await signToken(secret, { typ: 'code', sub: user.email, stamp: await stampOf(user), challenge: query.code_challenge, redirect: query.redirect_uri, exp: Math.floor(now() / 1000) + CODE_TTL });
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', query.state);
    return Response.redirect(redirect.href, 302);
  }

  async function accessToken(request) {
    const type = request.headers.get('content-type') ?? '';
    const body = type.includes('json') ? await request.json() : Object.fromEntries(new URLSearchParams(await request.text()));
    if (body.grant_type === 'refresh_token') {
      const user = await userFromToken(body.refresh_token, 'refresh');
      return user ? json(await issueTokens(user)) : json({ error: 'invalid_grant' }, 400);
    }
    if (body.grant_type === 'authorization_code') {
      const payload = await readToken(secret, body.code, now());
      const user = payload?.typ === 'code' && findUser((await loadUsers()).users, payload.sub);
      const verified = user && (await stampOf(user)) === payload.stamp && payload.redirect === body.redirect_uri
        && (!payload.challenge || (await sha256(body.code_verifier ?? '')) === payload.challenge);
      return verified ? json(await issueTokens(user)) : json({ error: 'invalid_grant' }, 400);
    }
    return json({ error: 'unsupported_grant_type' }, 400);
  }

  // ---- Gitea API ----
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

  function profile(user) {
    return { id: numericId(user.email), login: user.email, login_name: user.email, full_name: user.name ?? user.email, email: user.email, avatar_url: avatar(user.name ?? user.email), html_url: '', is_admin: user.role === 'administrator', werft_role: user.role };
  }

  const repoInfo = (user, defaultBranch) => ({
    id: 1, name: repo, full_name: `${owner}/${repo}`, owner: { id: 1, login: owner }, private: true, empty: false, archived: false, fork: false,
    default_branch: defaultBranch, html_url: '', has_pull_requests: false,
    permissions: { admin: user.role === 'administrator', push: true, pull: true },
  });

  const commitURL = (sha) => `${PREFIX}/commit/${sha}`;

  async function changeFiles(user, body) {
    if ((body.branch ?? branch) !== branch || body.new_branch) return error(422, `Only the ${branch} branch can be changed.`);
    const head = await storage.head(branch);
    const files = await treeAt(head.sha);
    const blobOf = (p) => files.find((f) => f.path === p);
    const changes = [];
    for (const file of body.files ?? []) {
      const path = String(file.path ?? '').replace(/^\/+/, '');
      if (!path || path.split('/').some((s) => s === '..' || s === '.')) return error(422, `Invalid path ${file.path}`);
      if (!visible(path)) return error(403, 'Dieser Bereich ist geschützt.');
      const data = file.operation === 'delete' ? null : fromBase64(file.content ?? '');
      const source = file.from_path && file.from_path !== path ? file.from_path : path;
      const existing = blobOf(source);
      if (file.operation === 'create' && blobOf(path)) return error(422, `${path} already exists.`);
      if (file.operation !== 'create') {
        if (!existing) return error(404, `${source} does not exist.`);
        if (file.sha && file.sha !== existing.sha) return error(409, `${source} was changed by someone else.`);
      }
      const creator = file.operation === 'create' ? null : await storage.creator(branch, source);
      const old = existing && file.operation !== 'create' && classify(source, site) === 'post' ? decoder.decode(await storage.read(head.sha, source)) : '';
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
      commit: { sha: result.sha, created: result.date, html_url: commitURL(result.sha), message, parents: [{ sha: head.sha }] },
      files: (body.files ?? []).map((f) => (f.operation === 'delete' ? null : { path: f.path, sha: result.blobs[f.path] ?? '', type: 'file' })),
    }, 201);
  }

  const giteaCommit = (c) => ({
    sha: c.sha, url: commitURL(c.sha), html_url: commitURL(c.sha), created: c.date,
    commit: { message: c.message, author: { name: c.author.name, email: c.author.email, date: c.date }, committer: { name: c.author.name, email: c.author.email, date: c.date } },
    author: { login: c.author.email, avatar_url: avatar(c.author.name) },
  });

  async function gitea(request, url, user, rest) {
    const method = request.method;
    if (rest === '/version') return json({ version: '1.24.0' });
    if (rest === '/settings/api') return json({ max_response_items: 50, default_paging_num: 50, default_git_trees_per_page: 100000, default_max_blob_size: 10485760, default_max_response_size: 10485760 });
    if (rest === '/user') return json(profile(user));
    const match = rest.match(/^\/repos\/[^/]+\/[^/]+(\/.*)?$/);
    if (!match) return error(404, 'Not found');
    const sub = match[1] ?? '';
    const q = url.searchParams;
    if (!sub) return json(repoInfo(user, branch));
    if (sub.startsWith('/branches/')) {
      if (decodeURIComponent(sub.slice(10)) !== branch) return error(404, 'Branch not found');
      const head = await storage.head(branch);
      return json({ name: branch, commit: { id: head.sha, message: head.message, timestamp: head.date }, protected: false, user_can_push: true, user_can_merge: false });
    }
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
    if (sub.startsWith('/media/')) {
      const [ref, ...parts] = sub.slice(7).split('/');
      const path = parts.map(decodeURIComponent).join('/');
      const bytes = visible(path) && await storage.read(await resolveRef(decodeURIComponent(ref)), path);
      const type = MIME[path.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
      return bytes ? new Response(bytes, { headers: { 'content-type': type, 'cache-control': 'private, max-age=60' } }) : error(404, 'Not found');
    }
    if (sub === '/contents' && method === 'POST') return changeFiles(user, await request.json());
    if (sub === '/contents' || sub.startsWith('/contents/')) {
      const path = decodeURIComponent(sub.slice(10)).replace(/^\/+|\/+$/g, '');
      const sha = await resolveRef(q.get('ref'));
      const files = await treeAt(sha);
      const file = files.find((f) => f.path === path);
      if (file) return json({ name: path.split('/').pop(), path, sha: file.sha, type: 'file', size: file.size });
      const prefix = path ? `${path}/` : '';
      const entries = new Map();
      for (const f of files.filter((f) => f.path.startsWith(prefix))) {
        const [name, ...more] = f.path.slice(prefix.length).split('/');
        entries.set(name, more.length ? { name, path: prefix + name, type: 'dir', sha: '' } : { name, path: f.path, type: 'file', sha: f.sha, size: f.size });
      }
      return entries.size ? json([...entries.values()]) : error(404, 'Not found');
    }
    if (sub === '/commits') {
      const path = q.get('path') ?? '';
      if (path && !visible(path)) return json([]);
      const limit = Math.min(Number(q.get('limit') ?? 30), 100);
      return json((await storage.log({ branch, path, limit })).map(giteaCommit));
    }
    if (/^\/commits\/[^/]+\/status$/.test(sub)) return json({ state: '', statuses: [], total_count: 0 });
    if (sub === '/pulls' || sub.startsWith('/pulls')) return json([]);
    return error(404, 'Not found');
  }

  // ---- werft's own API ----
  async function saveUsers(admin, users, message) {
    const head = await storage.head(branch);
    const result = await storage.commit({ branch, parent: head.sha, message, author: { name: admin.name ?? admin.email, email: admin.email }, changes: [{ path: USERS_FILE, data: encoder.encode(serializeUsers(users)) }] });
    usersCache = { sha: null, users: [] };
    return result;
  }

  async function usersApi(request, user) {
    if (user.role !== 'administrator') return error(403, 'Nur Administratoren verwalten Benutzer.');
    const { users } = await loadUsers();
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
    await saveUsers(user, next, `Benutzer ${body.action === 'delete' ? 'gelöscht' : existing ? 'geändert' : 'angelegt'}: ${email}`);
    return json({ users: next.map(publicUser) });
  }

  // Publishes due scheduled entries by asking the host to rebuild. Anyone may call it: it only acts
  // when an entry's publish date has passed since the last build.
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
    if (due.length) await onTick?.({ due: due.map((e) => e.slug) });
    return json({ rebuilt: due.length > 0, due: due.map((e) => e.slug), next_publish: next, last_build: lastBuild ?? null });
  }

  return async function handle(request) {
    const url = new URL(request.url);
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
    const path = url.pathname.slice(PREFIX.length);
    try {
      if (path === '/login/oauth/authorize') return await authorize(request, url);
      if (path === '/login/oauth/access_token' && request.method === 'POST') return await accessToken(request);
      if (path === '/session' && request.method === 'POST') {
        const { email, password } = await request.json();
        const user = await signIn(email, password);
        return user ? json({ ...(await issueTokens(user)), user: publicUser(user) }) : error(401, 'E-Mail oder Passwort stimmt nicht.');
      }
      if (path === '/tick') return await tick(url);
      if (path === '/status') return json({ ok: true, storage: storage.kind, branch, has_users: (await loadUsers()).users.length > 0 });
      const user = await authenticate(request);
      if (!user) return error(401, 'Bitte anmelden.');
      if (path === '/me') return json({ ...publicUser(user), editable: editable(user.role), roles: ROLES });
      if (path === '/users') return await usersApi(request, user);
      if (path.startsWith('/api/v1/')) return await gitea(request, url, user, path.slice(7));
      return error(404, 'Not found');
    } catch (e) {
      if (e.status && e.status < 500) return error(e.status, e.message);
      console.error('werft gateway:', e);
      return error(500, 'Interner Fehler im Gateway.');
    }
  };
}
