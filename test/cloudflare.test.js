// The Cloudflare Pages adapter: configuration from the environment, the GitHub storage below the
// site directory, the deployed build as "last build", the deploy hook for scheduled entries, and
// GitHub access through a GitHub App or a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { pagesFunction } from '../adapters/cloudflare.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { fakeGitHub } from './fake-github.js';

const site = { name: 'Test', content: 'content', base: 'sub' };
const theme = { postType: { name: 'events' } };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const appEnv = { GITHUB_TOKEN: '', GITHUB_APP_ID: 'Iv23liwerft', GITHUB_APP_PRIVATE_KEY: keys.privateKey };

async function setup(env = {}) {
  const hub = fakeGitHub({ api: 'https://api.github.com', workflows: { 'gate.yml': true, 'build.yml': false, 'locked.yml': 'forbidden' }, ...(env.GITHUB_APP_ID && { app: { id: env.GITHUB_APP_ID, slug: 'werft', publicKey: keys.publicKey } }) });
  hub.seed({
    'web/.werft/users.json': serializeUsers([{ email: 'admin@test', name: 'Ada', role: 'administrator', password: await hashPassword('admin-password', 1000) }]),
    'web/content/events/due.json': JSON.stringify({ title: 'Due', status: 'published', publish_date: '2020-01-02T00:00:00Z' }),
  });
  const hooks = [];
  const request = (url, init) => (url.startsWith(hub.api) ? hub.fetch(url, init) : (hooks.push(url), new Response('{}')));
  const assets = { fetch: async (url) => (new URL(url).pathname === '/sub/_werft/build.json' ? Response.json({ built_at: '2020-01-01T00:00:00Z' }) : new Response('', { status: 404 })) };
  const fullEnv = { WERFT_SECRET: 's'.repeat(32), GITHUB_TOKEN: 't', WERFT_REPO: `${hub.owner}/${hub.repo}`, WERFT_DIR: 'web', ASSETS: assets, ...env };
  // Each instance starts with empty caches, like a new Workers isolate.
  const instance = () => {
    const onRequest = pagesFunction({ site, theme, fetch: request });
    return (path, init) => onRequest({ request: new Request(`https://x.pages.dev${path}`, init), env: fullEnv });
  };
  return { call: instance(), instance, hooks, hub };
}

test('signs in against the users file in the site directory', async () => {
  const { call } = await setup();
  const response = await call('/api/werft/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test', password: 'admin-password' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.role, 'administrator');
});

test('calls the deploy hook when a scheduled entry is due, if there is one', async () => {
  const withHook = await setup({ WERFT_DEPLOY_HOOK: 'https://api.cloudflare.test/hook', WERFT_TICK_KEY: 'k'.repeat(32) });
  assert.equal((await withHook.call(`/api/werft/tick?key=${'x'.repeat(32)}`)).status, 401, 'a wrong key does not count');
  assert.equal((await (await withHook.call(`/api/werft/tick?key=${'k'.repeat(32)}`)).json()).rebuilt, true);
  assert.deepEqual(withHook.hooks, ['https://api.cloudflare.test/hook']);
  const without = await setup({ WERFT_TICK_KEY: 'k'.repeat(32) });
  const result = await (await without.call(`/api/werft/tick?key=${'k'.repeat(32)}`)).json();
  assert.deepEqual([result.rebuilt, result.due], [false, ['due']]);
});

test('counts failed sign-ins in the WERFT_KV namespace, by the client address Cloudflare sends', async () => {
  const kv = new Map();
  const WERFT_KV = {
    get: async (key, type) => (kv.has(key) ? (type === 'json' ? JSON.parse(kv.get(key).value) : kv.get(key).value) : null),
    put: async (key, value, { expirationTtl }) => { assert.ok(expirationTtl >= 60); kv.set(key, { value }); },
    delete: async (key) => { kv.delete(key); },
  };
  const { instance } = await setup({ WERFT_KV });
  const signIn = (call, password, ip) => call('/api/werft/session', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ email: `guess-${Math.random()}@test`, password }) });
  for (let i = 0; i < 20; i++) assert.equal((await signIn(instance(), 'wrong', '198.51.100.7')).status, 401);
  assert.equal((await signIn(instance(), 'wrong', '198.51.100.7')).status, 429, 'a new isolate knows the count');
  assert.equal((await signIn(instance(), 'wrong', '203.0.113.9')).status, 401);
});

test('a reset link uses the address the request came to and is sent through waitUntil', async () => {
  const { hub } = await setup();
  hub.seed({ 'web/.werft/users.json': serializeUsers([{ email: 'ada@example.org', name: 'Ada', role: 'administrator', password: await hashPassword('admin-password', 1000) }]) });
  const onRequest = pagesFunction({ site, theme, fetch: (url, init) => hub.fetch(url, init) });
  const env = { WERFT_SECRET: 's'.repeat(32), GITHUB_TOKEN: 't', WERFT_REPO: `${hub.owner}/${hub.repo}`, WERFT_DIR: 'web', WERFT_MAIL: 'log', WERFT_MAIL_FROM: 'werft@example.org' };
  const request = new Request('https://x.pages.dev/api/werft/password/forgot', { method: 'POST', headers: { 'content-type': 'application/json', host: 'evil.test' }, body: JSON.stringify({ email: 'ada@example.org' }) });
  const tasks = [];
  // Called as a method of the context, as Cloudflare's waitUntil needs.
  const context = { request, env, waitUntil(promise) { assert.equal(this, context); tasks.push(promise); } };
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(String(line));
  try {
    assert.equal((await onRequest(context)).status, 200);
    assert.equal(tasks.length, 1, 'the e-mail goes out after the reply');
    await Promise.all(tasks);
  } finally {
    console.log = log;
  }
  assert.match(logged.join('\n'), /https:\/\/x\.pages\.dev\/admin\/#passwort=/);
  assert.ok(!logged.join('\n').includes('evil.test'));
});

test('on a gated site, a due entry starts the deploy workflow, once the app may', async () => {
  const env = { ...appEnv, WERFT_DEPLOY_WORKFLOW: 'gate.yml', WERFT_DEPLOY_HOOK: 'https://api.cloudflare.test/hook', WERFT_TICK_KEY: 'k'.repeat(32) };
  const { call, hub, hooks } = await setup(env);
  const tick = async () => { const r = await call(`/api/werft/tick?key=${'k'.repeat(32)}`); return { status: r.status, ...(await r.json()) }; };
  const error = console.error;
  console.error = () => {};
  try {
    const refused = await tick();
    assert.deepEqual([refused.status, refused.rebuilt, refused.due], [502, false, ['due']]);
    assert.match(refused.error, /^Veröffentlichen nach Zeitplan: Die GitHub App hat die Berechtigung „Actions: Read and write“ noch nicht/, 'says what is missing');
    assert.deepEqual([hub.dispatches, hooks], [[], []], 'and neither starts the workflow nor falls back to the hook');
  } finally { console.error = error; }
  const { access_token: token } = await (await call('/api/werft/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test', password: 'admin-password' }) })).json();
  assert.ok(token, 'signing in (through the contents token) keeps working meanwhile');

  hub.grant({ contents: 'write', actions: 'write' });
  const started = await tick();
  assert.deepEqual([started.status, started.rebuilt, hub.dispatches], [200, true, [{ workflow: 'gate.yml', ref: 'main' }]]);
  assert.deepEqual(hooks, [], 'the deploy hook, which bypasses the gate, is not used');
});

test('says why the deploy workflow cannot be started', async () => {
  const error = console.error;
  console.error = () => {};
  try {
    for (const [workflow, message] of [['build.yml', /ihm fehlt der Auslöser workflow_dispatch, oder den Branch main gibt es nicht/], ['deploy.yml', /Den Workflow deploy\.yml gibt es im Repository nicht/], ['locked.yml', /Die Berechtigung „Actions: Read and write“ für das Repository fehlt/]]) {
      const { call, hub } = await setup({ WERFT_DEPLOY_WORKFLOW: workflow, WERFT_TICK_KEY: 'k'.repeat(32) });
      const result = await (await call(`/api/werft/tick?key=${'k'.repeat(32)}`)).json();
      assert.match(result.error, message);
      assert.deepEqual(hub.dispatches, []);
    }
    const { call, hub } = await setup({ WERFT_DEPLOY_WORKFLOW: 'gate.yml', WERFT_TICK_KEY: 'k'.repeat(32) });
    assert.equal((await (await call(`/api/werft/tick?key=${'k'.repeat(32)}`)).json()).rebuilt, true, 'a token with the permission starts it');
    assert.deepEqual(hub.dispatches, [{ workflow: 'gate.yml', ref: 'main' }]);
    // Its gate fails, so the entry stays due: the same commit is not started again.
    const realNow = Date.now;
    Date.now = () => realNow() + 20 * 60 * 1000;
    try { assert.equal((await (await call(`/api/werft/tick?key=${'k'.repeat(32)}`)).json()).rebuilt, true); } finally { Date.now = realNow; }
    assert.equal(hub.dispatches.length, 1, 'one start per commit');
  } finally { console.error = error; }
});

test('explains missing configuration', async () => {
  const { call } = await setup({ WERFT_REPO: '' });
  const response = await call('/api/werft/status');
  assert.equal(response.status, 500);
  assert.match((await response.json()).message, /WERFT_REPO/);
});

test('saves through the GitHub App as its bot, with the editor as author', async () => {
  const { call, hub } = await setup(appEnv);
  const { access_token: token } = await (await call('/api/werft/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test', password: 'admin-password' }) })).json();
  const saved = await call('/api/werft/api/v1/repos/werft/site/contents', {
    method: 'POST', headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ branch: 'main', message: 'edit', files: [{ operation: 'create', path: 'content/pages/a.json', content: Buffer.from('{"title":"A","status":"published"}').toString('base64') }] }),
  });
  assert.equal(saved.status, 201);
  assert.equal(hub.fileAt('main', 'web/content/pages/a.json'), '{"title":"A","status":"published"}');
  const { author, committer } = hub.headCommit('main');
  assert.deepEqual([author.name, author.email], ['Ada', 'admin@test']);
  assert.deepEqual([committer.name, committer.email], ['werft[bot]', '9000+werft[bot]@users.noreply.github.com']);
  assert.deepEqual([...hub.tokens.values()].map(({ repositories, permissions }) => ({ repositories, permissions })), [{ repositories: [hub.repo], permissions: { contents: 'write' } }], 'one token for the whole session, limited to the repository');
});

test('the GitHub App takes over from a token that is still set', async () => {
  const { call } = await setup({ ...appEnv, GITHUB_TOKEN: 'old' });
  assert.equal((await call('/api/werft/status')).status, 200);
});

test('a save stays within the free plan limit of 50 outgoing requests', async () => {
  // With the GitHub App: a new isolate first needs three requests for its token.
  const { call, instance, hub } = await setup(appEnv);
  const { access_token: token } = await (await call('/api/werft/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test', password: 'admin-password' }) })).json();
  const upload = (n) => instance()('/api/werft/api/v1/repos/werft/site/contents', {
    method: 'POST', headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
    // Binary files: each needs its own request to GitHub.
    body: JSON.stringify({ branch: 'main', message: 'upload', files: Array.from({ length: n }, (_, i) => ({ operation: 'create', path: `assets/img/${n}-${i}.jpg`, content: Buffer.from([0xff, 0xd8, i]).toString('base64') })) }),
  });
  const before = hub.requests.length;
  assert.equal((await upload(30)).status, 201);
  const used = hub.requests.length - before;
  assert.ok(used <= 50, `${used} requests`);
  const refused = await upload(31);
  assert.equal(refused.status, 413);
  assert.match((await refused.json()).message, /höchstens 30/);
});
