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
    'site/content/forms/newsletter.json': '{"title":"Newsletter"}\n',
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
    // Whether a commit the branch leads to has a file with this text.
    const reachable = (branch, text) => { try { return git('log', '-p', '--format=', branch, '--').toString().includes(text); } catch { return false; } };
    return { storage: await gitStorage(path.join(root, 'site')), outside: () => fs.readFileSync(path.join(root, 'outside.txt'), 'utf8'), working: (rel) => (fs.existsSync(path.join(root, 'site', rel)) ? fs.readFileSync(path.join(root, 'site', rel), 'utf8') : null), reachable };
  },
  async github(files) {
    const hub = fakeGitHub();
    hub.seed(files);
    return { storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', dir: 'site', api: hub.api, fetch: hub.fetch }), outside: () => hub.fileAt('main', 'outside.txt'), working: (rel) => hub.fileAt('main', `site/${rel}`), reachable: (branch, text) => [...hub.history(branch)].some((t) => t.includes(text)) };
  },
};

for (const [kind, setup] of Object.entries(storages)) describe(`gateway on ${kind} storage`, () => {
let gateway, store;
let clock = Date.parse('2026-06-01T00:00:00Z');
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
    now: () => clock,
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
  assert.deepEqual(paths, ['content/events/a.json', 'content/forms/newsletter.json', 'content/pages/index.json', 'content/settings/site.json']);
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

// A session as the admin holds it: the access token, and the refresh cookie the browser sends back.
async function session(email, password) {
  const response = await gateway(new Request(`${ORIGIN}/api/werft/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }));
  const setCookie = response.headers.get('set-cookie');
  return { ...(await response.json()), setCookie, cookie: setCookie.split(';')[0] };
}
const renew = (cookie, body = {}, on = gateway) => on(new Request(`${ORIGIN}/api/werft/login/oauth/access_token`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: 'werft', ...body }) }));
const endSession = (token, body = {}) => gateway(new Request(`${ORIGIN}/api/werft/session`, { method: 'DELETE', headers: { authorization: `token ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));

test('renews a session with its refresh cookie only', async () => {
  const s = await session('admin@test', 'admin-password');
  assert.equal(s.refresh_token, undefined, 'scripts never see the refresh token');
  assert.match(s.setCookie, /^werft_refresh=[^;]+; Path=\/api\/werft\/; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure$/);
  const renewed = await renew(s.cookie);
  assert.equal(renewed.status, 200);
  assert.match(renewed.headers.get('set-cookie'), /^werft_refresh=/);
  assert.equal((await call(`${ORIGIN}/api/werft/me`, { token: (await renewed.json()).access_token })).data.email, 'admin@test');
  assert.equal((await renew(null, { refresh_token: s.cookie.slice('werft_refresh='.length) })).status, 200, 'a werft 0.5 refresh token from the body still works');
  assert.equal((await renew(`werft_refresh=${s.access_token}`)).status, 400, 'an access token is no refresh token');
  assert.equal((await call(`${ORIGIN}/api/werft/login/oauth/access_token`, { method: 'POST', body: { grant_type: 'authorization_code', code: 'x' } })).status, 400);
});

test('sign-out ends the session on the server, without a commit to the site', async () => {
  const before = commits.length;
  const mainHead = (await store.storage.head('main')).sha;
  const a = await session('author@test', 'author-password');
  const b = await session('author@test', 'author-password');
  const ended = await endSession(a.access_token);
  assert.equal(ended.status, 200);
  assert.match(ended.headers.get('set-cookie'), /^werft_refresh=; .*Max-Age=0/);
  assert.equal((await renew(a.cookie)).status, 400, 'the signed-out refresh token is refused');
  assert.equal((await call(`${ORIGIN}/api/werft/me`, { token: a.access_token })).status, 401, 'and its access token');
  assert.equal((await renew(b.cookie)).status, 200, 'other sessions go on');
  const fresh = createGateway({ storage: store.storage, secret: 'x'.repeat(32), site: { name: 'Test', contentDir: 'content' }, now: () => clock });
  assert.equal((await renew(a.cookie, {}, fresh)).status, 400, 'another process reads the list');
  assert.deepEqual([commits.length, (await store.storage.head('main')).sha], [before, mainHead], 'no commit on the site branch, no rebuild');
  assert.ok(!store.working('.werft/sessions.json') && store.reachable('werft-sessions', '"ended"'), 'the list is on its own branch');
});

test('a renewal racing "everywhere" does not outlive it', async () => {
  const s = await session('author@test', 'author-password');
  const signedInAt = clock;
  clock += 1000;
  const raced = await renew(s.cookie);
  const racedCookie = raced.headers.get('set-cookie').split(';')[0];
  // "Everywhere" picked its time before that renewal and lands after it.
  clock = signedInAt + 200;
  const other = await session('author@test', 'author-password');
  clock = signedInAt + 500;
  assert.equal((await endSession(other.access_token, { everywhere: true })).status, 200);
  clock = signedInAt + 2000;
  assert.equal((await renew(racedCookie)).status, 400, 'the renewed session began before, so it ended too');
});

test('a sign-out that cannot be recorded says so and clears the cookie', async () => {
  const failing = createGateway({ storage: { ...store.storage, commit: async () => { throw new Error('down'); } }, secret: 'x'.repeat(32), site: { name: 'Test', contentDir: 'content' }, now: () => clock });
  const s = await session('admin@test', 'admin-password');
  const response = await failing(new Request(`${ORIGIN}/api/werft/session`, { method: 'DELETE', headers: { authorization: `token ${s.access_token}` } }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).message, /Abmeldung hat nicht geklappt/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
});

test('signs a user out everywhere, by themselves or by an administrator', async () => {
  const one = await session('contrib@test', 'a-new-password');
  const two = await session('contrib@test', 'a-new-password');
  assert.equal((await endSession(one.access_token, { everywhere: true })).status, 200);
  assert.equal((await renew(two.cookie)).status, 400, 'the other session ended too');
  assert.equal((await call(`${ORIGIN}/api/werft/me`, { token: two.access_token })).status, 401);
  clock += 1000;
  const again = await session('contrib@test', 'a-new-password');
  assert.equal((await renew(again.cookie)).status, 200, 'signing in again works');

  const admin = await signIn('admin@test', 'admin-password');
  assert.equal((await call(`${ORIGIN}/api/werft/users`, { token: again.access_token, method: 'POST', body: { action: 'signout', email: 'admin@test' } })).status, 403, 'only administrators sign others out');
  assert.equal((await call(`${ORIGIN}/api/werft/users`, { token: admin, method: 'POST', body: { action: 'signout', email: 'contrib@test' } })).status, 200);
  assert.equal((await renew(again.cookie)).status, 400);
  assert.equal((await call(`${ORIGIN}/api/werft/me`, { token: admin })).status, 200, 'the administrator stays signed in');
  clock += 1000;
});

test('every role changes its own name and password, and no one else\'s', async () => {
  const admin = await signIn('admin@test', 'admin-password');
  for (const role of ['editor', 'author', 'contributor']) {
    const email = `own-${role}@test`;
    await call(`${ORIGIN}/api/werft/users`, { token: admin, method: 'POST', body: { email, name: 'Own', password: 'first-password', role } });
    const me = (body, token) => call(`${ORIGIN}/api/werft/me`, { token, method: 'POST', body });
    const other = await session(email, 'first-password');
    const token = await signIn(email, 'first-password');
    assert.equal((await me({ name: 'Neu' }, token)).data.name, 'Neu');
    assert.equal((await call(`${ORIGIN}/api/werft/me`, { token })).data.name, 'Neu', 'a new name keeps the session');
    for (const body of [{ email: 'admin@test', password: 'taken-over-1' }, { role: 'administrator' }, { name: 'X', email: 'author@test' }]) {
      assert.equal((await me(body, token)).status, 403, `refused: ${JSON.stringify(body)}`);
    }
    assert.equal((await me({ password: 'short', current_password: 'first-password' }, token)).status, 422);
    assert.equal((await me({ password: 'second-password', current_password: 'wrong' }, token)).status, 422, 'the current password is needed');
    const changed = await gateway(new Request(`${ORIGIN}/api/werft/me`, { method: 'POST', headers: { authorization: `token ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'second-password', current_password: 'first-password' }) }));
    assert.equal(changed.status, 200);
    assert.match(changed.headers.get('set-cookie'), /^werft_refresh=[^;]+;/, 'this session goes on with a new cookie');
    assert.equal((await call(`${ORIGIN}/api/werft/me`, { token: (await changed.json()).access_token })).data.email, email);
    assert.equal((await renew(other.cookie)).status, 400, 'other sessions end');
    assert.equal((await call(`${ORIGIN}/api/werft/session`, { method: 'POST', body: { email, password: 'first-password' } })).status, 401);
    assert.ok(await signIn(email, 'second-password'));
  }
  const users = (await call(`${ORIGIN}/api/werft/users`, { token: admin })).data.users;
  assert.deepEqual(users.filter((u) => ['admin@test', 'author@test'].includes(u.email)).map((u) => [u.name, u.role]), [['Ada', 'administrator'], ['Aut', 'author']]);
  assert.ok(await signIn('admin@test', 'admin-password'), 'the administrator\'s password is unchanged');
});

test('guessing the current password counts against the session, not guesses elsewhere', async () => {
  const admin = await signIn('admin@test', 'admin-password');
  await call(`${ORIGIN}/api/werft/users`, { token: admin, method: 'POST', body: { email: 'guessed@test', name: 'G', password: 'first-password', role: 'author' } });
  const token = await signIn('guessed@test', 'first-password');
  for (let i = 0; i < 5; i++) await call(`${ORIGIN}/api/werft/session`, { method: 'POST', body: { email: 'guessed@test', password: `elsewhere-${i}` } });
  const me = (body) => call(`${ORIGIN}/api/werft/me`, { token, method: 'POST', body });
  assert.equal((await me({ password: 'second-password', current_password: 'first-password' })).status, 200, 'the account is locked for sign-ins, not for its own session');
  clock += 60 * 60 * 1000;
  const session2 = await signIn('guessed@test', 'second-password');
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await call(`${ORIGIN}/api/werft/me`, { token: session2, method: 'POST', body: { password: 'third-password', current_password: `guess-${i}` } })).status);
  assert.deepEqual(statuses, [422, 422, 422, 422, 422, 429]);
  clock += 60 * 60 * 1000;
});

test('a change to the own account keeps a newer password and needs a valid session', async () => {
  const admin = await signIn('admin@test', 'admin-password');
  const users = `${ORIGIN}/api/werft/users`;
  await call(users, { token: admin, method: 'POST', body: { email: 'raced@test', name: 'R', password: 'first-password', role: 'author' } });
  const token = await signIn('raced@test', 'first-password');
  const me = (body) => call(`${ORIGIN}/api/werft/me`, { token, method: 'POST', body });
  assert.equal((await me({ name: 'R' })).status, 200, 'nothing to change, nothing committed');
  for (const body of [{ name: '  ' }, { name: { x: 1 } }, { password: { length: 20 } }]) assert.equal((await me(body)).status, 422, JSON.stringify(body));
  // The request is signed in, then waits for its body while an administrator sets a new password.
  let send;
  const body = new ReadableStream({ start: (c) => { send = () => { c.enqueue(new TextEncoder().encode(JSON.stringify({ name: 'Renamed' }))); c.close(); }; } });
  const slow = gateway(new Request(`${ORIGIN}/api/werft/me`, { method: 'POST', headers: { authorization: `token ${token}`, 'content-type': 'application/json' }, body, duplex: 'half' }));
  await new Promise((r) => setTimeout(r, 50));
  await call(users, { token: admin, method: 'POST', body: { email: 'raced@test', password: 'admin-set-password' } });
  send();
  assert.equal((await slow).status, 401, 'the session ended with the new password');
  assert.equal((await call(`${ORIGIN}/api/werft/session`, { method: 'POST', body: { email: 'raced@test', password: 'first-password' } })).status, 401);
  assert.ok(await signIn('raced@test', 'admin-set-password'), 'the administrator\'s password stays');
});

test('keeps form submissions where only administrators and editors read them', async () => {
  const send = (form, fields, headers = {}) => gateway(new Request(`${ORIGIN}/api/werft/forms/${form}`, { method: 'POST', headers: { referer: 'https://elsewhere.test/kontakt.html', ...headers }, body: new URLSearchParams(fields) }));
  const built = commits.length;
  const sent = await send('newsletter', [['email', 'a@b.test'], ['themen', 'Konzerte'], ['themen', 'Ausstellungen'], ['_gotcha', '']]);
  assert.equal(sent.status, 201);
  assert.match(await sent.text(), /angekommen.*href="https:\/\/elsewhere\.test\/kontakt\.html"/s, 'a thank-you page that leads back to the form');
  const onward = await send('newsletter', [['email', 'c@d.test'], ['_redirect', '/danke.html']]);
  assert.equal(onward.headers.get('location'), 'https://elsewhere.test/danke.html', 'on to the page on the site the form was on');
  assert.equal((await send('newsletter', [['email', 'x@y.test'], ['_redirect', '//evil.test/']])).status, 201, 'no redirect to another host');
  assert.equal((await send('newsletter', [['email', 'bot@spam.test'], ['_gotcha', 'http://spam.test']])).status, 200, 'bots are told it worked');
  assert.equal((await send('fehlt', [['email', 'a@b.test']])).status, 404, 'only forms the site defines');
  assert.equal((await send('..%2F..%2F.werft%2Fusers', [['email', 'a@b.test']])).status, 404);
  assert.equal((await send('newsletter', [['email', 'x'.repeat(20001)]])).status, 413);
  const asScript = await send('newsletter', [['email', 'e@f.test']], { accept: 'application/json' });
  assert.deepEqual([asScript.status, await asScript.json()], [201, { ok: true }]);
  assert.equal(commits.length, built, 'a submission asks for no rebuild');
  assert.ok(!store.reachable('main', 'a@b.test'), 'kept beside the site, not in its history');
  assert.ok(store.reachable('werft-submissions', 'a@b.test'));

  const admin = await signIn('admin@test', 'admin-password');
  const author = await signIn('author@test', 'author-password');
  assert.equal((await call(`${ORIGIN}/api/werft/submissions`, { token: author })).status, 403);
  assert.equal((await call(`${ORIGIN}/api/werft/submissions`)).status, 401);
  const { data } = await call(`${ORIGIN}/api/werft/submissions`, { token: admin });
  const [form] = data.forms;
  assert.deepEqual([form.slug, form.title], ['newsletter', 'Newsletter']);
  assert.deepEqual(form.submissions.map((s) => s.fields.email).sort(), ['a@b.test', 'c@d.test', 'e@f.test', 'x@y.test']);
  assert.deepEqual(form.submissions.find((s) => s.fields.email === 'a@b.test').fields, { email: 'a@b.test', themen: ['Konzerte', 'Ausstellungen'] }, 'repeated names as a list, "_" fields left out');
  const { data: tree } = await call('/git/trees/main?recursive=1', { token: admin });
  assert.ok(!tree.tree.some((e) => e.path.startsWith('.werft')), 'not in the file API');

  const gone = form.submissions.find((s) => s.fields.email === 'c@d.test').id;
  assert.equal((await call(`${ORIGIN}/api/werft/submissions`, { token: admin, method: 'POST', body: { delete: ['newsletter/../../.werft/users'] } })).status, 404);
  const after = await call(`${ORIGIN}/api/werft/submissions`, { token: admin, method: 'POST', body: { delete: [gone] } });
  assert.deepEqual(after.data.forms[0].submissions.map((s) => s.fields.email).sort(), ['a@b.test', 'e@f.test', 'x@y.test']);
  assert.ok(!store.reachable('werft-submissions', 'c@d.test'), 'a deleted submission is in no commit of the branch');
  assert.ok(store.reachable('werft-submissions', 'a@b.test'));
  assert.equal((await call(`${ORIGIN}/api/werft/submissions`, { token: admin, method: 'POST', body: { delete: [gone] } })).status, 404);
  const rest = after.data.forms[0].submissions.map((s) => s.id);
  const none = await call(`${ORIGIN}/api/werft/submissions`, { token: admin, method: 'POST', body: { delete: rest } });
  assert.deepEqual(none.data.forms, [{ slug: 'newsletter', title: 'Newsletter', submissions: [] }]);
  assert.ok(!store.reachable('werft-submissions', 'a@b.test'), 'nothing left: the branch is gone');
  assert.equal((await send('newsletter', [['email', 'g@h.test']], { accept: 'application/json' })).status, 201, 'and is made again by the next one');
});

test('takes at most 60 submissions of a form an hour', async () => {
  const send = (email) => gateway(new Request(`${ORIGIN}/api/werft/forms/newsletter`, { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams({ email }) }));
  clock += 2 * 3600 * 1000;
  for (let i = 0; i < 60; i++) assert.equal((await send(`n${i}@test`)).status, 201);
  const refused = await send('late@test');
  assert.equal(refused.status, 429);
  clock += 3600 * 1000 - 1000;
  assert.equal((await send('later@test')).status, 429, 'the hour is not over yet');
  clock += 1000;
  assert.equal((await send('next@test')).status, 201, 'an hour after the first');
});

test('with a Turnstile secret, takes only submissions Turnstile confirms', async () => {
  const checks = [];
  const guarded = createGateway({
    storage: store.storage, secret: 'x'.repeat(32), branch: 'main', now: () => clock, turnstileSecret: 'ts-secret',
    site: { name: 'Test', contentDir: 'content', mediaDirs: [] },
    fetch: async (url, init) => { checks.push([url, Object.fromEntries(init.body)]); return Response.json({ success: init.body.get('response') === 'good' }); },
  });
  const send = (fields) => guarded(new Request(`${ORIGIN}/api/werft/forms/newsletter`, { method: 'POST', headers: { accept: 'application/json', 'cf-connecting-ip': '192.0.2.7' }, body: new URLSearchParams(fields) }));
  assert.equal((await send({ email: 'robot@test' })).status, 403, 'without the widget');
  assert.equal((await send({ email: 'robot@test', 'cf-turnstile-response': 'bad' })).status, 403);
  assert.equal((await send({ email: 'human@test', 'cf-turnstile-response': 'good' })).status, 201);
  assert.deepEqual(checks.at(-1), ['https://challenges.cloudflare.com/turnstile/v0/siteverify', { secret: 'ts-secret', response: 'good', remoteip: '192.0.2.7' }]);
  const admin = await signIn('admin@test', 'admin-password');
  const { data } = await call(`${ORIGIN}/api/werft/submissions`, { token: admin });
  assert.deepEqual(data.forms[0].submissions.find((s) => s.fields.email === 'human@test').fields, { email: 'human@test' }, 'the token is not stored');
  assert.ok(!data.forms[0].submissions.some((s) => s.fields.email === 'robot@test'));
});
});
