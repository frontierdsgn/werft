// Page addresses: clean addresses by default (kontakt/ in kontakt/index.html), werft 0.6's with
// `urls: 'html'`, pages below a parent page, redirects from the old .html addresses, and links in
// the content written as "kontakt.html".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, html } from '../lib/index.js';
import { siteAddresses } from '../lib/content.js';
import { check } from '../lib/check.js';
import { renderPreview } from '../gateway/preview.js';

const memoryStore = (files) => ({
  list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).sort(),
  readText: async (path) => { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[path]; },
});
const json = (data) => JSON.stringify(data);
const page = (title, more = {}) => json({ title, status: 'published', sections: [], ...more });

const content = {
  'content/pages/index.json': page('Start', { sections: [{ type: 'text', body: '[Preise](preise.html#tabelle) [Kontakt](kontakt.html?von=start) ![Bild](assets/img/a.jpg)' }] }),
  'content/pages/kontakt.json': page('Kontakt', { sections: [{ type: 'text', body: '[Start](index.html) [Anker](#karte) [Fehlt](fehlt.html)' }] }),
  'content/pages/tagen.json': page('Tagen'),
  'content/pages/preise.json': page('Preise', { parent: 'tagen', sections: [{ type: 'text', body: '[Kontakt](kontakt.html) [Räume](raeume.html) ![Bild](assets/img/a.jpg)' }] }),
  'content/pages/raeume.json': page('Räume', { parent: 'preise' }),
  'content/pages/entwurf.json': json({ title: 'Entwurf', status: 'draft', parent: 'tagen' }),
  'content/pages/404.json': page('Nicht gefunden', { parent: 'tagen' }),
  'content/events/fest.json': json({ title: 'Fest', status: 'published' }),
  'content/settings/site.json': json({ title: 'Salon', url: 'https://salon.example/' }),
  'content/settings/menus.json': json({ main: { items: [{ label: 'Start', url: 'index.html' }, { label: 'Preise', url: 'preise.html' }] } }),
  'content/settings/redirects.json': json({ redirects: [{ from: '/alt.html', to: '/kontakt.html' }, { from: '/umzug/', to: '/tagen/' }, { from: '/kontakt.html', to: '/neu/' }] }),
  'assets/img/a.jpg': '',
};

const theme = {
  blocks: { text: { label: 'Text', fields: [], render: (s, ctx) => html`<section>${ctx.md(s.body)}</section>` } },
  menus: { main: 'Haupt' },
  postType: { name: 'events', label: 'Termine', singular: 'Termin', fields: [], url: (post) => `termine/${post.slug}.html` },
  renderPage: (p, ctx) => html`<link href="${ctx.url('assets/site.css')}"><nav>${ctx.menu('main').items.map((i) => html`<a href="${i.url}">${i.label}</a>`)}</nav><a href="${ctx.url('kontakt.html')}">K</a><a href="${ctx.postUrl(ctx.posts()[0])}">F</a>${ctx.blocks(p.sections)}`,
  renderPost: (post, ctx) => html`<h1>${post.title}</h1><a href="../kontakt.html">K</a><a href="${ctx.url('')}">S</a>`,
};

const built = async (site = {}, files = content) => {
  const result = await build({ site: { mediaDirs: ['assets/img'], ...site }, theme, store: memoryStore(files), now: new Date('2026-06-01'), media: {} });
  return { ...result, out: Object.fromEntries(result.files.map((f) => [f.path, f.text])) };
};

test('pages go to folders, below their parent page; the home page and 404.html stay at the top', async () => {
  const { out } = await built();
  assert.deepEqual(Object.keys(out).filter((p) => p.endsWith('.html')).sort(),
    ['404.html', 'index.html', 'kontakt/index.html', 'tagen/index.html', 'tagen/preise/index.html', 'tagen/preise/raeume/index.html', 'termine/fest/index.html']);
  const { out: old } = await built({ urls: 'html' });
  assert.deepEqual(Object.keys(old).filter((p) => p.endsWith('.html')).sort(),
    ['404.html', 'index.html', 'kontakt.html', 'tagen.html', 'tagen/preise.html', 'tagen/preise/raeume.html', 'termine/fest.html'], "urls: 'html' keeps .html, also for pages below a parent");
});

test('links written as kontakt.html lead to the page\'s address from every page', async () => {
  const { out } = await built();
  assert.equal(out['index.html'], '<link href="assets/site.css"><nav><a href="./">Start</a><a href="tagen/preise/">Preise</a></nav><a href="kontakt/">K</a><a href="termine/fest/">F</a>'
    + '<section><p><a href="tagen/preise/#tabelle">Preise</a> <a href="kontakt/?von=start">Kontakt</a> <img src="assets/img/a.jpg" alt="Bild"></p></section>');
  assert.equal(out['tagen/preise/index.html'], '<link href="../../assets/site.css"><nav><a href="../../">Start</a><a href="./">Preise</a></nav><a href="../../kontakt/">K</a><a href="../../termine/fest/">F</a>'
    + '<section><p><a href="../../kontakt/">Kontakt</a> <a href="raeume/">Räume</a> <img src="../../assets/img/a.jpg" alt="Bild"></p></section>', 'menus, Markdown, ctx.url(), ctx.postUrl() and media');
  assert.match(out['kontakt/index.html'], /<a href="..\/">Start<\/a> <a href="#karte">Anker<\/a> <a href="fehlt.html">Fehlt<\/a>/, 'anchors stay; a link to no page stays as written');
  assert.equal(out['termine/fest/index.html'], '<h1>Fest</h1><a href="../../kontakt/">K</a><a href="../../">S</a>', 'a post page: links relative to its old address');
  const { out: old } = await built({ urls: 'html' });
  assert.match(old['tagen/preise.html'], /<nav><a href="..\/index.html">Start<\/a><a href="preise.html">Preise<\/a><\/nav><a href="..\/kontakt.html">K<\/a>/);
  assert.match(old['index.html'], /<nav><a href="index.html">Start<\/a><a href="tagen\/preise.html">Preise<\/a><\/nav><a href="kontakt.html">K<\/a><a href="termine\/fest.html">F<\/a>/);
});

test('every published page and post redirects from its old .html address, on Cloudflare, Apache and Node', async () => {
  const { out, redirects } = await built();
  assert.deepEqual(redirects, [
    { from: '/alt.html', to: '/kontakt/' }, // a redirect to a page named as in the content
    { from: '/umzug/', to: '/tagen/' },
    { from: '/kontakt.html', to: '/neu/' }, // the site's own redirect wins
    { from: '/preise.html', to: '/tagen/preise/', status: 301 },
    { from: '/raeume.html', to: '/tagen/preise/raeume/', status: 301 },
    { from: '/tagen.html', to: '/tagen/', status: 301 },
    { from: '/termine/fest.html', to: '/termine/fest/', status: 301 },
    { from: '/umzug.html', to: '/tagen/', status: 301 }, // an old clean address takes its .html form along
  ]);
  assert.equal(out._redirects, `${redirects.map((r) => `${r.from} ${r.to} ${r.status ?? 301}`).join('\n')}\n`);
  assert.equal(out['.htaccess'], `${redirects.map((r) => `Redirect ${r.status ?? 301} ${r.from} ${r.to}`).join('\n')}\nErrorDocument 404 /404.html\n`);
  assert.deepEqual(JSON.parse(out['_werft/build.json']).redirects, redirects, 'werft serve reads them there');
  assert.deepEqual((await built({ urls: 'html' })).redirects, [{ from: '/alt.html', to: '/kontakt.html' }, { from: '/umzug/', to: '/tagen/' }, { from: '/kontakt.html', to: '/neu/' },
    { from: '/preise.html', to: '/tagen/preise.html', status: 301 }, { from: '/raeume.html', to: '/tagen/preise/raeume.html', status: 301 }], "urls: 'html': only pages below a parent moved");
  const below = await built({ base: 'salon' });
  assert.deepEqual(below.redirects.slice(3, 5), [{ from: '/salon/kontakt.html', to: '/salon/kontakt/', status: 301 }, { from: '/salon/preise.html', to: '/salon/tagen/preise/', status: 301 }], 'below a base path');
});

test('sitemap, feed, search index and canonical addresses use the clean addresses', async () => {
  const files = { ...content, 'content/pages/kontakt.json': page('Kontakt', { sections: [] }) };
  const t = { ...theme, search: true, renderPage: (p, ctx) => html`<head>${ctx.head()}</head><main>${p.title}</main>` };
  const { files: list } = await build({ site: {}, theme: t, store: memoryStore(files), now: new Date('2026-06-01'), media: {} });
  const out = Object.fromEntries(list.map((f) => [f.path, f.text]));
  assert.match(out['sitemap.xml'], /<loc>https:\/\/salon.example\/<\/loc><\/url><url><loc>https:\/\/salon.example\/kontakt\/<\/loc>.*<loc>https:\/\/salon.example\/tagen\/preise\/<\/loc>.*<loc>https:\/\/salon.example\/termine\/fest\/<\/loc>/);
  assert.match(out['feed.xml'], /<link>https:\/\/salon.example\/termine\/fest\/<\/link>/);
  assert.deepEqual(JSON.parse(out['_werft/search/de.json']).entries.map((e) => e.url), ['', 'kontakt/', 'tagen/preise/', 'tagen/preise/raeume/', 'tagen/', 'termine/fest/']);
  assert.match(out['tagen/preise/index.html'], /<link rel="canonical" href="https:\/\/salon.example\/tagen\/preise\/">.*<link rel="alternate" type="application\/rss\+xml" title="Salon: Termine" href="..\/..\/feed.xml">/);
});

test('werft check finds nothing wrong in a site with clean addresses', async () => {
  const { files, redirects } = await built({}, {
    ...content,
    'content/pages/index.json': page('Start', { sections: [{ type: 'text', body: '[Preise](preise.html) [Kontakt](kontakt.html?von=start) ![Bild](assets/img/a.jpg)' }] }),
    'content/pages/kontakt.json': page('Kontakt', { sections: [{ type: 'text', body: '[Start](index.html) [Alt](/alt.html) [Preise](/preise.html) [Umzug](/umzug.html)' }] }),
    'content/settings/redirects.json': json({ redirects: [{ from: '/alt.html', to: '/kontakt.html' }, { from: '/umzug/', to: '/tagen/' }] }),
  });
  const result = check({ files: [...files.map((f) => ({ path: f.path, size: f.text.length, text: f.text })), { path: 'assets/site.css', size: 1, text: '' }, { path: 'assets/img/a.jpg', size: 1 }], redirects });
  assert.deepEqual(result.findings, [], 'links to old .html addresses pass: they redirect');
});

test('the address of a page follows the default language\'s parent in every language', async () => {
  const files = {
    ...content,
    'content/en/pages/index.json': page('Home'),
    'content/en/pages/preise.json': page('Prices', { parent: 'something-else', sections: [{ type: 'text', body: '[Contact](kontakt.html) [Home](index.html)' }] }),
  };
  const { out } = await built({ languages: ['de', 'en'] }, files);
  assert.equal(out['en/tagen/preise/index.html'].match(/<section>.*<\/section>/)[0], '<section><p><a href="../../../kontakt/">Contact</a> <a href="../../">Home</a></p></section>', 'a page English lacks is the German one');
  const addresses = siteAddresses({ site: { languages: ['de', 'en'] }, content: { pages: [{ slug: 'a', parent: 'b' }, { slug: 'b', parent: 'a' }, { slug: 'c', parent: 'fehlt' }, { slug: 'd', parent: 'index' }] } });
  assert.deepEqual(['a', 'c', 'd'].map((slug) => addresses.page(slug, 'en').url), ['en/b/a/', 'en/c/', 'en/d/'], 'a loop, a missing parent and the home page as parent end the chain');
});

test('an address two entries or another folder of the site would share stops the build', async () => {
  await assert.rejects(built({}, { ...content, 'content/pages/termine.json': page('Termine'), 'content/pages/fest.json': page('Fest', { parent: 'termine' }) }), /the page "fest" and the Termin "fest" would both be written to termine\/fest\/index.html/);
  await assert.rejects(built({}, { ...content, 'content/pages/admin.json': page('Admin') }), /the page "admin" would be written to admin\/index.html, a folder the site needs/);
  await assert.rejects(built({ languages: ['de', 'en'] }, { ...content, 'content/pages/en.json': page('Englisch') }), /the page "en" would be written to en\/index.html/);
  assert.ok((await built({ urls: 'html' }, { ...content, 'content/pages/admin.json': page('Admin') })).out['admin.html']);
  await assert.rejects(built({ urls: 'pretty' }), /urls must be 'clean' or 'html'/);
});

test('a preview link renders a page below its parent from the page\'s folder', async () => {
  const files = Object.entries(content).map(([path]) => ({ path }));
  const read = async (paths) => paths.map((p) => content[p]);
  const out = await renderPreview({ site: { base: 'salon' }, theme, target: { kind: 'page', slug: 'entwurf' }, files, read, now: new Date('2026-06-01') });
  assert.match(out, /^<base href="\/salon\/tagen\/entwurf\/"><meta name="robots" content="noindex"><link href="..\/..\/assets\/site.css"><nav><a href="..\/..\/">Start<\/a>/);
});
