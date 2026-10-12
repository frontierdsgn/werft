// The static build: files it writes beside the pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../lib/build.js';

const memoryStore = (files) => ({
  list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
  readText: async (path) => { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[path]; },
});

test('redirects with * work on Cloudflare and on Apache', async () => {
  const redirects = [
    { from: '/alt.html', to: '/neu.html' },
    { from: '/classic/*', to: 'https://salon.example/:splat', status: 302 },
  ];
  const store = memoryStore({ 'content/settings/redirects.json': JSON.stringify({ redirects }) });
  const { files } = await build({ site: {}, theme: { renderPage: () => ({ value: '' }) }, store, media: {} });
  const text = (path) => files.find((f) => f.path === path).text;
  assert.equal(text('_redirects'), '/alt.html /neu.html 301\n/classic/* https://salon.example/:splat 302\n');
  assert.equal(text('.htaccess'), 'Redirect 301 /alt.html /neu.html\nRedirectMatch 302 ^/classic/(.*)$ https://salon.example/$1\n');
});
