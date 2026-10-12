// The Cloudflare Pages adapter: configuration from the environment, the GitHub storage below the
// site directory, the deployed build as "last build" and the deploy hook for scheduled entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagesFunction } from '../adapters/cloudflare.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { fakeGitHub } from './fake-github.js';

const site = { name: 'Test', content: 'content', base: 'sub' };
const theme = { postType: { name: 'events' } };

async function setup(env = {}) {
  const hub = fakeGitHub({ api: 'https://api.github.com' });
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

test('explains missing configuration', async () => {
  const { call } = await setup({ WERFT_REPO: '' });
  const response = await call('/api/werft/status');
  assert.equal(response.status, 500);
  assert.match((await response.json()).message, /WERFT_REPO/);
});

test('a save stays within the free plan limit of 50 outgoing requests', async () => {
  const { call, instance, hub } = await setup();
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
