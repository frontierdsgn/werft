// What the theme writes into <head> with werft's helpers: ctx.head() for the title, description,
// canonical address, link preview and the other languages of an entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, createContext, html } from '../lib/index.js';

const memoryStore = (files) => ({
  list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).sort(),
  readText: async (path) => { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[path]; },
});
const json = (data) => JSON.stringify(data);
const NOW = new Date('2026-06-01T00:00:00Z');
const theme = {
  blocks: {},
  postType: { name: 'news', label: 'News', singular: 'News', fields: [], url: (post) => `news/${post.slug}.html` },
  renderPage: (page, ctx) => html`<head>${ctx.head()}</head>`,
  renderPost: (post, ctx) => html`<head>${ctx.head({ description: post.teaser })}</head>`,
};
const built = async (site, files, t = theme) => {
  const result = await build({ site, theme: t, store: memoryStore(files), now: NOW, media: { 'assets/img/teilen.jpg': { width: 1200, height: 630 } } });
  return Object.fromEntries(result.files.map((f) => [f.path, f.text]));
};

test('ctx.head() writes title, description, canonical address and link preview', async () => {
  const out = await built({ mediaDirs: ['assets/img'] }, {
    'content/settings/site.json': json({ title: 'Salon', title_suffix: '| Salon', url: 'https://salon.example', share_image: 'assets/img/teilen.jpg' }),
    'content/pages/index.json': json({ title: 'Start', seo: { title: 'Salon am Fluss', description: 'Haare & mehr' } }),
    'content/pages/kontakt.json': json({ title: 'Kontakt', seo: { noindex: true, image: 'https://cdn.example/k.png' } }),
    'content/news/neu.json': json({ title: 'Neu <da>', teaser: 'Ab Juni' }),
  });
  assert.equal(out['index.html'], '<head><title>Salon am Fluss | Salon</title><meta name="description" content="Haare &amp; mehr">'
    + '<link rel="canonical" href="https://salon.example/"><meta property="og:type" content="website"><meta property="og:site_name" content="Salon">'
    + '<meta property="og:title" content="Salon am Fluss"><meta property="og:description" content="Haare &amp; mehr"><meta property="og:url" content="https://salon.example/">'
    + '<meta property="og:image" content="https://salon.example/assets/img/teilen.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'
    + '<meta name="twitter:card" content="summary_large_image"></head>');
  assert.equal(out['kontakt.html'], '<head><title>Kontakt | Salon</title><meta name="robots" content="noindex">'
    + '<link rel="canonical" href="https://salon.example/kontakt.html"><meta property="og:type" content="website"><meta property="og:site_name" content="Salon">'
    + '<meta property="og:title" content="Kontakt"><meta property="og:url" content="https://salon.example/kontakt.html">'
    + '<meta property="og:image" content="https://cdn.example/k.png"><meta name="twitter:card" content="summary_large_image"></head>');
  assert.match(out['news/neu.html'], /<title>Neu &lt;da&gt; \| Salon<\/title><meta name="description" content="Ab Juni">.*<meta property="og:type" content="article">.*<meta property="og:url" content="https:\/\/salon.example\/news\/neu.html">/);
});

test('ctx.head() without a site address leaves out what needs one', async () => {
  const out = await built({}, {
    'content/settings/site.json': json({ title: 'Salon', search_visibility: 'noindex', share_image: 'assets/img/teilen.jpg' }),
    'content/pages/index.json': json({ title: 'Start' }),
  });
  assert.equal(out['index.html'], '<head><title>Start</title><meta name="robots" content="noindex"><meta property="og:type" content="website">'
    + '<meta property="og:site_name" content="Salon"><meta property="og:title" content="Start"><meta name="twitter:card" content="summary"></head>');
});

test('ctx.head() names the versions of an entry in other languages', async () => {
  const out = await built({ languages: ['de', 'en', 'fr'], base: '' }, {
    'content/settings/site.json': json({ title: 'Salon', url: 'https://salon.example/' }),
    'content/pages/index.json': json({ title: 'Start' }),
    'content/pages/kontakt.json': json({ title: 'Kontakt' }),
    'content/en/pages/kontakt.json': json({ title: 'Contact' }),
    'content/fr/pages/kontakt.json': json({ title: 'Contact', status: 'draft' }),
  });
  const links = (text) => [...text.matchAll(/<link rel="(?:alternate|canonical)"[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(links(out['en/kontakt.html']), [
    '<link rel="canonical" href="https://salon.example/en/kontakt.html">',
    '<link rel="alternate" hreflang="de" href="https://salon.example/kontakt.html">',
    '<link rel="alternate" hreflang="en" href="https://salon.example/en/kontakt.html">',
    '<link rel="alternate" hreflang="x-default" href="https://salon.example/kontakt.html">',
  ]);
  // A page in one language only names no other version.
  assert.deepEqual(links(out['index.html']), ['<link rel="canonical" href="https://salon.example/">']);
  // The addresses come from the default language's `url`; a noindex version is not named.
  const again = await built({ languages: ['de', 'en'] }, {
    'content/settings/site.json': json({ title: 'Salon', url: 'https://salon.example/' }),
    'content/en/settings/site.json': json({ url: 'https://salon.example/en/' }),
    'content/pages/kontakt.json': json({ title: 'Kontakt' }),
    'content/en/pages/kontakt.json': json({ title: 'Contact' }),
    'content/pages/team.json': json({ title: 'Team' }),
    'content/en/pages/team.json': json({ title: 'Team', seo: { noindex: true } }),
  });
  assert.deepEqual(links(again['en/kontakt.html']).slice(0, 2), ['<link rel="canonical" href="https://salon.example/en/kontakt.html">', '<link rel="alternate" hreflang="de" href="https://salon.example/kontakt.html">']);
  assert.deepEqual(links(again['team.html']), ['<link rel="canonical" href="https://salon.example/team.html">']);
});

test('a post names its versions in other languages by their own addresses', async () => {
  const out = await built({ languages: ['de', 'en'] }, {
    'content/settings/site.json': json({ title: 'Salon', url: 'https://salon.example/' }),
    'content/news/neu.json': json({ title: 'Neu' }),
    'content/en/news/neu.json': json({ title: 'New' }),
  }, { ...theme, renderPost: (post, ctx) => html`${ctx.head()}${ctx.translations.map((t) => html`<a href="${t.url}">${t.lang}</a>`)}` });
  assert.match(out['news/neu.html'], /<link rel="alternate" hreflang="en" href="https:\/\/salon.example\/en\/news\/neu.html">.*<a href="neu.html">de<\/a><a href="..\/en\/news\/neu.html">en<\/a>$/);
});

test('ctx.head() takes a picture as image and keeps an absolute image without a site address', () => {
  const content = { pages: [{ slug: 'a', title: '' }], posts: [], patterns: [], forms: [], settings: { title: 'S', title_suffix: '| S' }, menus: {}, redirects: [] };
  const ctx = createContext({ site: {}, theme: { blocks: {} }, content }).for(content.pages[0]);
  const out = ctx.head({ image: { src: 'https://cdn.example/a.jpg', alt: 'Ein Bild' } }).value;
  assert.match(out, /^<title>S<\/title>/, 'an untitled page gets the site name once');
  const empty = createContext({ site: {}, theme: { blocks: {} }, content: { ...content, settings: { share_image: 'https://cdn.example/s.jpg' } } }).for(content.pages[0]);
  assert.match(empty.head({ image: { src: '', alt: '' } }).value, /<meta property="og:image" content="https:\/\/cdn.example\/s.jpg">/, 'an empty picture falls through');
  assert.match(out, /<meta property="og:image" content="https:\/\/cdn.example\/a.jpg"><meta property="og:image:alt" content="Ein Bild"><meta name="twitter:card" content="summary_large_image">/);
});

test('ctx.head() options replace what the entry gives', () => {
  const content = { pages: [{ slug: 'a', title: 'A', seo: { description: 'x' } }], posts: [], patterns: [], forms: [], settings: { title: 'S' }, menus: {}, redirects: [] };
  const ctx = createContext({ site: {}, theme: { blocks: {} }, content }).for(content.pages[0]);
  assert.equal(ctx.head({ title: 'B', description: 'y', type: 'profile' }).value, '<title>B</title><meta name="description" content="y"><meta property="og:type" content="profile">'
    + '<meta property="og:site_name" content="S"><meta property="og:title" content="B"><meta property="og:description" content="y"><meta name="twitter:card" content="summary">');
});
