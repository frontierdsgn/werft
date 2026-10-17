// Gateway contract: sign-in, the file API the editor uses, conflicts and role checks, against
// each storage: a throwaway git repository and an in-memory GitHub.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../gateway/core.js';
import { gitStorage } from '../gateway/storage/git.js';
import { githubStorage } from '../gateway/storage/github.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { fakeGitHub } from './fake-github.js';

const ORIGIN = 'https://site.test';
const API = `${ORIGIN}/api/werft/api/v1/repos/werft/site`;
const b64 = (text) => Buffer.from(text).toString('base64');

// The repository: the site lives in site/, next to a file the gateway must neither show nor lose.
async function repoFiles() {
  const users = [
    { email: 'admin@test', name: 'Ada', role: 'administrator', password: await hashPassword('admin-password', 1000) },
    { email: 'author@test', name: 'Aut', role: 'author', password: await hashPassword('author-password', 1000) },
    { email: 'contrib@test', name: 'Con', role: 'contributor', password: await hashPassword('contrib-password', 1000) },
  ];
  return {
    'site/.werft/users.json': serializeUsers(users),
    'site/content/pages/index.json': '{"title":"Start","status":"published"}\n',
    'site/content/events/a.json': '{"title":"A","status":"published"}\n',
    'site/content/settings/site.json': '{"title":"Site"}\n',
    'outside.txt': 'not part of the site\n',
  };
}

const storages = {
  async git(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-gw-'));
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
    const git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'admin@test', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'admin@test' } });
    git('init', '--quiet', '-b', 'main');
    git('add', '.');
    git('commit', '--quiet', '-m', 'init');
    return { storage: await gitStorage(path.join(root, 'site')), outside: () => fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), working: (rel) => (fs.existsSync(path.join(root, 'site', rel)) ? fs.readFileSync(path.join(root, 'site', rel), 'utf8') : null) };
  },
  async github(files) {
    const hub = fakeGitHub();
    hub.seed(files);
    return { storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', dir: 'site', api: hub.api, fetch: hub.fetch }), outside: () => hub.fileAt('main', 'outside.txt'), working: (rel) => hub.fileAt('main', `site/${rel}`) };
  },
};

for (const [kind, setup] of Object.entries(storages)) describe(`gateway on ${kind} storage`, () => {
let gateway, store;
const commits = [];
const ticks = [];

before(async () => {
  store = await setup(await repoFiles());
  gateway = createGateway({
    storage: store.storage, secret: 'x'.repeat(32), branch: 'main', iterations: 1000,
    site: { name: 'Test', contentDir: 'content', postType: 'events', mediaDirs: ['assets/img'] },
    onCommit: (c) => commits.push(c),
    onTick: ({ due }) => { ticks.push(due); },
    lastBuild: () => '2026-01-01T00:00:00Z',
    now: () => Date.parse('2026-06-01T00:00:00Z'),
  });
});

async function call(url, { token, method = 'GET', body } = {}) {
  const response = await gateway(new Request(url.startsWith('http') ? url : `${API}${url}`, {
    method, headers: { ...(token && { authorization: `token ${token}` }), ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body),
  }));
  const type = response.headers.get('content-type') ?? '';
  return { status: response.status, data: type.includes('json') ? await response.json() : await response.text() };
}

const signIn = async (email, password) => (await call(`${ORIGIN}/api/werft/session`, { method: 'POST', body: { email, password } })).data.access_token;

test('signs in with the right password only', async () => {
  assert.equal((await call(`${ORIGIN}/api/werft/session`, { method: 'POST', body: { email: 'admin@test', password: 'wrong' } })).status, 401);
  assert.ok(await signIn('admin@test', 'admin-password'));
  assert.equal((await call('')).status, 401);
});

test('lists the site directory without the users file', async () => {
  const token = await signIn('admin@test', 'admin-password');
  const { data } = await call('/git/trees/main?recursive=1', { token });
  const paths = data.tree.map((e) => e.path).sort();
  assert.deepEqual(paths, ['content/events/a.json', 'content/pages/index.json', 'content/settings/site.json']);
  const contents = await call('/file-contents?ref=main', { token, method: 'POST', body: { files: ['content/pages/index.json', '.werft/users.json'] } });
  assert.equal(Buffer.from(contents.data[0].content, 'base64').toString(), '{"title":"Start","status":"published"}\n');
  assert.equal(contents.data[1], null);
  assert.equal((await call('/raw/.werft/users.json?ref=main', { token })).status, 404);
});

test('commits a change, then refuses a stale one', async () => {
  const token = await signIn('admin@test', 'admin-password');
  const { data: { tree } } = await call('/git/trees/main?recursive=1', { token });
  const file = tree.find((e) => e.path === 'content/pages/index.json');
  const update = (text) => call('/contents', { token, method: 'POST', body: { branch: 'main', message: 'Edit start', files: [{ operation: 'update', path: 'content/pages/index.json', content: b64(text), sha: file.sha }] } });
  const first = await update('{"title":"Neu","status":"published"}\n');
  assert.equal(first.status, 201);
  assert.equal(store.working('content/pages/index.json'), '{"title":"Neu","status":"published"}\n');
  assert.equal(commits.at(-1).author, 'admin@test');
  assert.equal((await update('{"title":"Alt"}\n')).status, 409);
  const { data: log } = await call('/commits?sha=main&path=content/pages/index.json&limit=100', { token });
  assert.deepEqual(log.map((c) => c.commit.message), ['Edit start', 'init']);
});

test('moves and deletes files', async () => {
  const token = await signIn('admin@test', 'admin-password');
  const created = await call('/contents', { token, method: 'POST', body: { branch: 'main', message: 'add', files: [{ operation: 'create', path: 'content/pages/alt.json', content: b64('{"title":"Alt"}') }] } });
  const moved = await call('/contents', { token, method: 'POST', body: { branch: 'main', message: 'rename', files: [{ operation: 'update', path: 'content/pages/neu.json', from_path: 'content/pages/alt.json', content: b64('{"title":"Neu"}'), sha: created.data.files[0].sha }] } });
  assert.equal(moved.status, 201);
  assert.equal(store.working('content/pages/alt.json') ?? null, null, 'the old name is gone');
  const deleted = await call('/contents', { token, method: 'POST', body: { branch: 'main', message: 'remove', files: [{ operation: 'delete', path: 'content/pages/neu.json', sha: moved.data.files[0].sha }] } });
  assert.equal(deleted.status, 201);
  const { data } = await call('/git/trees/main?recursive=1', { token });
  assert.ok(!data.tree.some((e) => e.path.startsWith('content/pages/neu')));
  assert.equal(store.outside(), 'not part of the site\n');
});

test('applies WordPress-style roles', async () => {
  const author = await signIn('author@test', 'author-password');
  const contrib = await signIn('contrib@test', 'contrib-password');
  const create = (token, path, text) => call('/contents', { token, method: 'POST', body: { branch: 'main', message: 'x', files: [{ operation: 'create', path, content: b64(text) }] } });
  assert.equal((await create(author, 'content/pages/neu.json', '{}')).status, 403, 'authors cannot create pages');
  assert.equal((await create(author, 'content/events/b.json', '{"title":"B","status":"published"}')).status, 201, 'authors publish their own posts');
  const entryOf = async (path) => (await call('/git/trees/main?recursive=1', { token: author })).data.tree.find((e) => e.path === path);
  const a = await entryOf('content/events/a.json');
  const edit = await call('/contents', { token: author, method: 'POST', body: { branch: 'main', message: 'x', files: [{ operation: 'update', path: 'content/events/a.json', content: b64('{}'), sha: a.sha }] } });
  assert.equal(edit.status, 403, "authors cannot edit someone else's post");
  const b = await entryOf('content/events/b.json');
  const rename = await call('/contents', { token: author, method: 'POST', body: { branch: 'main', message: 'x', files: [{ operation: 'update', from_path: 'content/events/b.json', path: 'content/events/a.json', content: b64('{"title":"B"}'), sha: b.sha }] } });
  assert.equal(rename.status, 422, "renaming onto someone else's post does not replace it");
  assert.equal(store.working('content/events/a.json'), '{"title":"A","status":"published"}\n');
  assert.equal((await create(contrib, 'content/events/c.json', '{"title":"C","status":"published"}')).status, 403, 'contributors cannot publish');
  assert.equal((await create(contrib, 'content/events/c.json', '{"title":"C","status":"pending"}')).status, 201, 'contributors submit for review');
  assert.equal((await create(contrib, 'assets/img/x.png', 'x')).status, 403, 'contributors cannot upload');
  assert.deepEqual((await call(`${ORIGIN}/api/werft/me`, { token: contrib })).data.statuses, ['draft', 'pending'], 'the admin offers contributors only what they may save');
  assert.deepEqual((await call(`${ORIGIN}/api/werft/me`, { token: author })).data.statuses, ['draft', 'pending', 'published']);
  assert.equal((await create(author, 'assets/img/photo.jpg', 'x')).status, 201, 'authors upload images');
  for (const name of ['evil.html', 'evil.svg', 'evil.js', 'evil.jpg.html']) {
    assert.equal((await create(author, `assets/img/${name}`, '<script>alert(1)</script>')).status, 403, `no ${name} as media`);
  }
});

test('lets administrators manage users and revokes tokens of changed users', async () => {
  const admin = await signIn('admin@test', 'admin-password');
  const contrib = await signIn('contrib@test', 'contrib-password');
  assert.equal((await call(`${ORIGIN}/api/werft/users`, { token: contrib })).status, 403);
  const changed = await call(`${ORIGIN}/api/werft/users`, { token: admin, method: 'POST', body: { email: 'contrib@test', password: 'a-new-password' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('', { token: contrib })).status, 401, 'old token no longer works');
  assert.ok(await signIn('contrib@test', 'a-new-password'));
});

test('a user change based on an outdated list fails instead of undoing another', async () => {
  const admin = await signIn('admin@test', 'admin-password');
  const users = `${ORIGIN}/api/werft/users`;
  await call(users, { token: admin, method: 'POST', body: { email: 'temp@test', password: 'temp-password', role: 'author' } });
  // A reads the users, then waits for its body while B deletes the account.
  let send;
  const body = new ReadableStream({ start: (c) => { send = () => { c.enqueue(new TextEncoder().encode(JSON.stringify({ email: 'temp@test', name: 'Renamed' }))); c.close(); }; } });
  const slow = gateway(new Request(users, { method: 'POST', headers: { authorization: `token ${admin}`, 'content-type': 'application/json' }, body, duplex: 'half' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call(users, { token: admin, method: 'POST', body: { action: 'delete', email: 'temp@test' } })).status, 200);
  send();
  assert.equal((await slow).status, 409);
  assert.ok(!(await call(users, { token: admin })).data.users.some((u) => u.email === 'temp@test'), 'the deleted account stays deleted');
});

test('asks for a rebuild when a scheduled entry falls due', async () => {
  const token = await signIn('admin@test', 'admin-password');
  const add = (slug, date) => call('/contents', { token, method: 'POST', body: { branch: 'main', message: 'plan', files: [{ operation: 'create', path: `content/events/${slug}.json`, content: b64(JSON.stringify({ title: slug, status: 'published', publish_date: date })) }] } });
  await add('later', '2026-09-01T10:00:00Z');
  assert.equal((await call(`${ORIGIN}/api/werft/tick`)).status, 401, 'not for anonymous callers');
  let { data } = await call(`${ORIGIN}/api/werft/tick`, { token });
  assert.deepEqual([data.rebuilt, data.due, data.next_publish], [false, [], '2026-09-01T10:00:00Z']);
  await add('due', '2026-05-31T10:00:00Z');
  await add('old', '2025-12-31T10:00:00Z');
  ({ data } = await call(`${ORIGIN}/api/werft/tick`, { token }));
  assert.deepEqual([data.rebuilt, data.due], [true, ['due']], 'only entries due since the last build');
  assert.deepEqual(ticks.at(-1), ['due']);
  ({ data } = await call(`${ORIGIN}/api/werft/tick`, { token }));
  assert.deepEqual([data.rebuilt, data.pending, ticks.length], [false, true, 1], 'no second rebuild while the first runs');
});

test('renews a session with its refresh token only', async () => {
  const { data: session } = await call(`${ORIGIN}/api/werft/session`, { method: 'POST', body: { email: 'admin@test', password: 'admin-password' } });
  const renew = (body) => call(`${ORIGIN}/api/werft/login/oauth/access_token`, { method: 'POST', body: { client_id: 'werft', ...body } });
  const renewed = await renew({ grant_type: 'refresh_token', refresh_token: session.refresh_token });
  assert.equal(renewed.status, 200);
  assert.equal((await call(`${ORIGIN}/api/werft/me`, { token: renewed.data.access_token })).data.email, 'admin@test');
  assert.equal((await renew({ grant_type: 'refresh_token', refresh_token: session.access_token })).status, 400, 'an access token is no refresh token');
  assert.equal((await renew({ grant_type: 'authorization_code', code: 'x' })).status, 400);
});
});
