// Preview links: a signed, expiring, revocable link that shows one page or post as saved, drafts
// included, to someone without an account, through the gateway's public API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { fakeGitHub } from './fake-github.js';

const ORIGIN = 'https://site.test';
const day = 24 * 3600 * 1000;
const theme = {
  blocks: {},
  postType: { name: 'events', label: 'Termine', url: (post) => `termine/${post.slug}.html` },
  renderPage: (page, ctx) => ctx.html`<html><head><title>${page.title}</title><link rel="stylesheet" href="${ctx.url('assets/site.css')}"></head><body><header>Kopf</header><h1>${page.title}</h1><a href="${ctx.url('kontakt.html')}">K</a>${ctx.exists('assets/img/a.jpg') ? 'IMG' : 'NOIMG'}${ctx.raw(page.html ?? '')}${ctx.posts().map((p) => ctx.html`<p>${p.title}</p>`)}</body></html>`,
  renderPost: (post, ctx) => ctx.html`<html><head><title>${post.title}</title></head><body><h1>${post.title}</h1></body></html>`,
};
const site = { name: 'Test', contentDir: 'content', base: 'sub', languages: ['de', 'en'], mediaDirs: ['assets/img'], theme: './theme/index.js' };

async function setup({ withRender = true, renderTheme = theme } = {}) {
  const hub = fakeGitHub();
  const down = { now: false };
  const users = [
    { email: 'ed@test', name: 'Ed', role: 'editor', password: await hashPassword('editor-password', 1000) },
    { email: 'con@test', name: 'Con', role: 'contributor', password: await hashPassword('contrib-password', 1000) },
  ];
  hub.seed({
    '.werft/users.json': serializeUsers(users),
    'content/pages/index.json': JSON.stringify({ title: 'Start', status: 'published' }),
    'content/pages/neu.json': JSON.stringify({ title: 'Neue Seite', status: 'draft', html: '<img src=x onerror="fetch(\'/api/werft/users\')">' }),
    'assets/img/a.jpg': 'jpeg',
    'content/pages/kontakt.json': JSON.stringify({ title: 'Kontakt', status: 'published' }),
    'content/en/pages/kontakt.json': JSON.stringify({ title: 'Contact', status: 'draft' }),
    'content/en/pages/neu.json': JSON.stringify({ title: 'New page', status: 'draft', html: '<a href="kontakt.html">contact</a>' }),
    'content/events/fest.json': JSON.stringify({ title: 'Sommerfest', status: 'draft' }),
    'content/settings/site.json': JSON.stringify({ title: 'Test' }),
  });
  const clock = { t: Date.parse('2026-06-01T00:00:00Z') };
  const make = () => createGateway({
    storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch: (...args) => (down.now ? Promise.resolve(new Response('{}', { status: 502 })) : hub.fetch(...args)) }),
    secret: 'x'.repeat(32), now: () => clock.t,
    site: { name: 'Test', contentDir: 'content', postType: 'events', languages: ['de', 'en'], base: 'sub', mediaDirs: ['assets/img'] },
    render: withRender ? { site, theme: renderTheme } : undefined,
  });
  const gateway = make();
  const call = async (path, { token, method = 'GET', body, on = gateway } = {}) => {
    const response = await on(new Request(`${ORIGIN}${path}`, { method, headers: { ...(token && { authorization: `token ${token}` }), ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) }));
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, headers: response.headers, data: type.includes('json') ? await response.json() : await response.text() };
  };
  const signIn = async (email, password) => (await call('/api/werft/session', { method: 'POST', body: { email, password } })).data.access_token;
  return { call, signIn, clock, make, down };
}

test('a link shows a draft to someone without an account, marked noindex', async () => {
  const { call, signIn } = await setup();
  const ed = await signIn('ed@test', 'editor-password');
  const created = await call('/api/werft/previews', { token: ed, method: 'POST', body: { path: 'content/pages/neu.json', days: 7 } });
  assert.equal(created.status, 200);
  const [link] = created.data.previews;
  assert.deepEqual([link.by, link.expires_at], ['ed@test', '2026-06-08T00:00:00.000Z']);
  const page = await call(link.url);
  assert.equal(page.status, 200);
  assert.match(page.data, /<h1>Neue Seite<\/h1>/);
  assert.match(page.data, /<head><base href="\/sub\/neu\/"><meta name="robots" content="noindex">/, 'the page\'s own folder');
  assert.match(page.data, /<header>Kopf<\/header>/, 'nothing lands in <header>');
  assert.match(page.data, /IMG/, 'the media that exist are known');
  assert.deepEqual([page.headers.get('x-robots-tag'), page.headers.get('referrer-policy'), page.headers.get('cache-control')], ['noindex', 'no-referrer', 'no-store']);
  // The entry's markup is shown as the site would, but in a sandbox with an origin of its own, so
  // a script in a draft cannot use the admin's cookie or API.
  assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /allow-same-origin/);
  assert.equal((await call('/api/werft/previews?path=content/pages/neu.json', { token: ed })).data.previews[0].url, link.url, 'the editor lists it again');
});

test('posts and other languages render like the build, from their folder', async () => {
  const { call, signIn } = await setup();
  const ed = await signIn('ed@test', 'editor-password');
  const urlOf = async (path) => (await call('/api/werft/previews', { token: ed, method: 'POST', body: { path } })).data.previews[0].url;
  const post = await call(await urlOf('content/events/fest.json'));
  assert.match(post.data, /<base href="\/sub\/termine\/fest\/">.*<h1>Sommerfest<\/h1>/s);
  const english = await call(await urlOf('content/en/pages/neu.json'));
  assert.match(english.data, /<base href="\/sub\/en\/neu\/">.*<h1>New page<\/h1>/s);
  assert.match(english.data, /href="\.\.\/\.\.\/assets\/site\.css"/, 'relative addresses work from the page\'s folder');
  assert.match(english.data, /<a href="\.\.\/\.\.\/kontakt\/">contact<\/a>/, 'a page the language has only as a draft links to the default language, as on the site');
});

test('a link stops working when it expires or is revoked, and a forged one never works', async () => {
  const { call, signIn, clock, make } = await setup();
  const ed = await signIn('ed@test', 'editor-password');
  const create = async (days) => (await call('/api/werft/previews', { token: ed, method: 'POST', body: { path: 'content/pages/neu.json', days } })).data.previews;
  const [day1] = await create(1);
  clock.t += day + 1000;
  assert.equal((await call(day1.url)).status, 410, 'expired');
  assert.equal((await call('/api/werft/previews?path=content/pages/neu.json', { token: await signIn('ed@test', 'editor-password') })).data.previews.length, 0, 'an expired link is not listed');

  const token = await signIn('ed@test', 'editor-password');
  const [link] = (await call('/api/werft/previews', { token, method: 'POST', body: { path: 'content/pages/neu.json', days: 30 } })).data.previews;
  const other = make();
  assert.equal((await call(link.url, { on: other })).status, 200);
  const revoked = await call('/api/werft/previews', { token, method: 'POST', body: { path: 'content/pages/neu.json', revoke: link.id } });
  assert.deepEqual(revoked.data.previews, []);
  assert.equal((await call(link.url)).status, 410, 'revoked');
  assert.equal((await call(link.url, { on: other })).status, 410, 'at once in another process too');
  const [body, signature] = link.url.split('/').pop().split('.');
  const forged = JSON.parse(Buffer.from(body, 'base64url'));
  forged.path = 'content/pages/index.json';
  assert.equal((await call(`/api/werft/preview/${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`)).status, 410);
});

test('a broken link or a failing theme shows the "no longer valid" page; no links without a renderer', async () => {
  const { call } = await setup();
  assert.equal((await call('/api/werft/preview/%E0')).status, 410);
  assert.equal((await call('/api/werft/preview/abc.def')).status, 410);
  const failing = await setup({ renderTheme: { ...theme, renderPage: () => { throw new Error('theme bug'); } } });
  const ed = await failing.signIn('ed@test', 'editor-password');
  const [link] = (await failing.call('/api/werft/previews', { token: ed, method: 'POST', body: { path: 'content/pages/neu.json' } })).data.previews;
  const logged = [];
  const error = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.equal((await failing.call(link.url)).status, 410);
    assert.match(logged.join('\n'), /preview:.*theme bug/, 'the error is logged');
    failing.down.now = true;
    const outage = await failing.call(link.url);
    assert.deepEqual([outage.status, outage.headers.get('retry-after')], [503, '60'], 'GitHub not answering is no dead link');
    assert.match(outage.data, /gerade nicht erreichbar/);
  } finally { console.error = error; }
  const bare = await setup({ withRender: false });
  assert.equal((await bare.call('/api/werft/previews', { token: await bare.signIn('ed@test', 'editor-password'), method: 'POST', body: { path: 'content/pages/neu.json' } })).status, 501);
});

test('only who may change an entry shares it, and only pages and posts', async () => {
  const { call, signIn } = await setup();
  const con = await signIn('con@test', 'contrib-password');
  assert.equal((await call('/api/werft/previews?path=content/pages/neu.json')).status, 401);
  assert.equal((await call('/api/werft/previews', { token: con, method: 'POST', body: { path: 'content/pages/neu.json' } })).status, 403, 'contributors change only their own posts');
  assert.equal((await call('/api/werft/previews', { token: con, method: 'POST', body: { path: 'content/events/fest.json' } })).status, 403, 'nor posts someone else began');
  const ed = await signIn('ed@test', 'editor-password');
  for (const path of ['content/settings/site.json', '.werft/users.json', 'content/pages/gibtsnicht.json']) {
    assert.equal((await call('/api/werft/previews', { token: ed, method: 'POST', body: { path } })).status, 403, path);
  }
});
