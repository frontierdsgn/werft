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
  const onRequest = pagesFunction({ site, theme, fetch: request });
  const assets = { fetch: async (url) => (new URL(url).pathname === '/sub/_werft/build.json' ? Response.json({ built_at: '2020-01-01T00:00:00Z' }) : new Response('', { status: 404 })) };
  const fullEnv = { WERFT_SECRET: 's'.repeat(32), GITHUB_TOKEN: 't', WERFT_REPO: `${hub.owner}/${hub.repo}`, WERFT_DIR: 'web', ASSETS: assets, ...env };
  const call = (path, init) => onRequest({ request: new Request(`https://x.pages.dev${path}`, init), env: fullEnv });
  return { call, hooks };
}

test('signs in against the users file in the site directory', async () => {
  const { call } = await setup();
  const response = await call('/api/werft/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test', password: 'admin-password' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.role, 'administrator');
});

test('calls the deploy hook when a scheduled entry is due, if there is one', async () => {
  const withHook = await setup({ WERFT_DEPLOY_HOOK: 'https://api.cloudflare.test/hook' });
  assert.equal((await (await withHook.call('/api/werft/tick')).json()).rebuilt, true);
  assert.deepEqual(withHook.hooks, ['https://api.cloudflare.test/hook']);
  const without = await setup();
  const result = await (await without.call('/api/werft/tick')).json();
  assert.deepEqual([result.rebuilt, result.due], [false, ['due']]);
});

test('explains missing configuration', async () => {
  const { call } = await setup({ WERFT_REPO: '' });
  const response = await call('/api/werft/status');
  assert.equal(response.status, 500);
  assert.match((await response.json()).message, /WERFT_REPO/);
});
