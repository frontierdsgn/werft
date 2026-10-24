// The static build: files it writes beside the pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, createContext } from '../lib/build.js';

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

test('posts come newest first by the theme\'s date field, undated posts last by slug', async () => {
  const post = (slug, date) => ({ slug, title: slug, status: 'published', ...(date && { date }) });
  const content = {
    pages: [], patterns: [], forms: [], settings: {}, menus: {}, redirects: [],
    posts: [post('a-old', '2024-01-01'), post('z-none'), post('b-new', '2026-03-01'), post('c-german', '15.06.2025'), post('m-none')],
  };
  const slugs = (theme) => createContext({ site: {}, theme, content }).posts().map((p) => p.slug);
  assert.deepEqual(slugs({ postType: { name: 'events', date: 'date' } }), ['b-new', 'c-german', 'a-old', 'm-none', 'z-none']);
  // A list the editor picked keeps its order.
  assert.deepEqual(createContext({ site: {}, theme: { postType: { date: 'date' } }, content }).posts({ slugs: ['a-old', 'b-new'] }).map((p) => p.slug), ['a-old', 'b-new']);
});

test('without a date field posts are ordered by their publish date', async () => {
  const content = {
    pages: [], patterns: [], forms: [], settings: {}, menus: {}, redirects: [],
    posts: [{ slug: 'a', publish_date: '2025-02-01T09:00:00.000Z' }, { slug: 'b', publish_date: '2025-03-01T09:00:00.000Z' }],
  };
  assert.deepEqual(createContext({ site: {}, theme: { postType: { name: 'news' } }, content, now: new Date('2026-01-01') }).posts().map((p) => p.slug), ['b', 'a']);
});

test('ctx.url() gives theme files a content hash, so a changed file gets a new address', async () => {
  const site = (css) => ({
    ...memoryStore({ 'content/pages/index.json': '{"title":"Start"}', 'content/en/pages/index.json': '{"title":"Home"}', 'theme/static/assets/css/site.css': css, 'theme/static/assets/js/site.js': 'x' }),
    readBytes: async (path) => new TextEncoder().encode({ 'theme/static/assets/css/site.css': css, 'theme/static/assets/js/site.js': 'x' }[path]),
  });
  const theme = {
    staticDir: 'theme/static',
    renderPage: (page, ctx) => ({ value: [ctx.url('assets/css/site.css'), ctx.url('assets/js/site.js?defer#top'), ctx.url('assets/img/a.jpg'), ctx.url('kontakt.html')].join(' ') }),
  };
  const page = async (css, path = 'index.html') => (await build({ site: { languages: ['de', 'en'] }, theme, store: site(css), media: {} })).files.find((f) => f.path === path).text;
  const [css, js, media, link] = (await page('body{}')).split(' ');
  assert.match(css, /^assets\/css\/site\.css\?v=[0-9a-f]{10}$/);
  assert.match(js, /^assets\/js\/site\.js\?defer&v=[0-9a-f]{10}#top$/);
  assert.deepEqual([media, link], ['assets/img/a.jpg', 'kontakt.html'], 'other addresses stay as they are');
  assert.equal((await page('body{}')).split(' ')[0], css, 'the same file keeps its address');
  assert.notEqual((await page('body{color:red}')).split(' ')[0], css);
  assert.equal((await page('body{}', 'en/index.html')).split(' ')[0], `../${css}`);
});
