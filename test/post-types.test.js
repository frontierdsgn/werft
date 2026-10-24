// Several post types, taxonomies (categories, tags) with a listing page per term, and listings over
// several pages (ctx.paginate()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, html, fields } from '../lib/index.js';
import { schema } from '../lib/schema.js';
import { classify, denial } from '../gateway/roles.js';
import { gatewaySite } from '../gateway/core.js';
import { previewTarget, renderPreview } from '../gateway/preview.js';

const memoryStore = (files) => ({
  list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).sort(),
  readText: async (path) => { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[path]; },
});
const json = (data) => JSON.stringify(data);
const post = (title, date, more = {}) => json({ title, status: 'published', date, ...more });

const theme = {
  blocks: {
    news: { label: 'Neuigkeiten', fields: [], render: (s, ctx) => {
      const page = ctx.paginate(ctx.posts({ type: 'news' }), { perPage: 2 });
      return html`<ul>${page.items.map((p) => html`<li><a href="${ctx.postUrl(p)}">${p.title}</a> ${ctx.terms('kategorien', p).map((t) => html`<a href="${t.url}">${t.title}</a>`)}</li>`)}</ul><nav>${page.prev ? html`<a rel="prev" href="${page.prev}">‹</a>` : ''}${page.number}/${page.count}${page.next ? html`<a rel="next" href="${page.next}">›</a>` : ''}</nav>`;
    } },
    events: { label: 'Termine', fields: [], render: (s, ctx) => html`<ol>${ctx.posts({ type: 'events' }).map((p) => html`<li>${p.title}</li>`)}</ol>` },
  },
  postTypes: [
    { name: 'news', label: 'Neuigkeiten', singular: 'Neuigkeit', date: 'date', url: (p) => `neuigkeiten/${p.slug}.html`, fields: [fields.string('title', 'Titel'), fields.date('date', 'Datum'), fields.terms('kategorien', 'Kategorien'), fields.terms('schlagworte', 'Schlagworte')] },
    { name: 'events', label: 'Termine', singular: 'Termin', date: 'date', fields: [fields.string('title', 'Titel'), fields.terms('kategorien', 'Kategorien')] },
  ],
  taxonomies: [
    { name: 'kategorien', label: 'Kategorien', singular: 'Kategorie', url: (term) => `kategorie/${term.slug}.html` },
    { name: 'schlagworte', label: 'Schlagworte', singular: 'Schlagwort' },
  ],
  renderPage: (page, ctx) => html`<head>${ctx.head()}</head><h1>${page.title}</h1>${ctx.blocks(page.sections)}`,
  renderPost: (p, ctx) => html`<h1>${ctx.postType.singular}: ${p.title}</h1>${ctx.terms('schlagworte', p).map((t) => html`<a href="${t.url}">#${t.title}</a>`)}`,
  renderTerm: (term, ctx) => {
    const page = ctx.paginate(term.posts, { perPage: 2 });
    return html`<head>${ctx.head({ title: term.title })}</head><h1>${term.title}</h1><p>${term.description}</p><ul>${page.items.map((p) => html`<li>${p.title}</li>`)}</ul>${page.number}/${page.count}`;
  },
};

const content = {
  'content/pages/index.json': json({ title: 'Start', status: 'published', sections: [{ type: 'news' }, { type: 'events' }] }),
  'content/news/a.json': post('A', '2026-01-01', { kategorien: ['salon'], schlagworte: ['farbe'] }),
  'content/news/b.json': post('B', '2026-02-01', { kategorien: ['salon', 'team'] }),
  'content/news/c.json': post('C', '2026-03-01', { kategorien: ['salon'] }),
  'content/news/d.json': json({ title: 'D', status: 'draft', date: '2026-04-01', kategorien: ['salon'] }),
  'content/events/fest.json': post('Fest', '2026-07-01', { kategorien: ['salon'] }),
  'content/kategorien/salon.json': json({ title: 'Salon', description: 'Aus dem Salon' }),
  'content/kategorien/team.json': json({ title: 'Team' }),
  'content/kategorien/leer.json': json({ title: 'Leer' }),
  'content/schlagworte/farbe.json': json({ title: 'Farbe' }),
  'content/settings/site.json': json({ title: 'Salon', url: 'https://salon.example/' }),
};
const built = async (site = {}, files = content, t = theme) => {
  const result = await build({ site, theme: t, store: memoryStore(files), now: new Date('2026-06-01'), media: {} });
  return { ...result, out: Object.fromEntries(result.files.map((f) => [f.path, f.text])) };
};

test('a theme declares several post types; each has its posts, pages and listings', async () => {
  const { out } = await built();
  assert.deepEqual(Object.keys(out).filter((p) => p.endsWith('.html')).sort(), [
    '2/index.html', 'index.html', 'kategorie/salon/2/index.html', 'kategorie/salon/index.html', 'kategorie/team/index.html',
    'neuigkeiten/a/index.html', 'neuigkeiten/b/index.html', 'neuigkeiten/c/index.html', 'schlagworte/farbe/index.html',
  ], 'posts without url (events) have no pages; terms without public posts no listing');
  assert.match(out['index.html'], /<ol><li>Fest<\/li><\/ol>/, 'ctx.posts({ type })');
  assert.equal(out['neuigkeiten/a/index.html'], '<h1>Neuigkeit: A</h1><a href="../../schlagworte/farbe/">#Farbe</a>', 'ctx.postType and a post\'s terms with their listing pages');
});

test('a listing over several pages: ctx.paginate() writes page 2 and further at <address>2/', async () => {
  const { out } = await built();
  assert.match(out['index.html'], /<ul><li><a href="neuigkeiten\/c\/">C<\/a> <a href="kategorie\/salon\/">Salon<\/a><\/li><li><a href="neuigkeiten\/b\/">B<\/a> <a href="kategorie\/salon\/">Salon<\/a><a href="kategorie\/team\/">Team<\/a><\/li><\/ul><nav>1\/2<a rel="next" href="2\/">›<\/a><\/nav>/);
  assert.match(out['2/index.html'], /<ul><li><a href="..\/neuigkeiten\/a\/">A<\/a> <a href="..\/kategorie\/salon\/">Salon<\/a><\/li><\/ul><nav><a rel="prev" href="..\/">‹<\/a>2\/2<\/nav>/);
  assert.match(out['2/index.html'], /<link rel="canonical" href="https:\/\/salon.example\/2\/">/, 'each page names itself');
  const { out: old } = await built({ urls: 'html' });
  assert.match(old['index/2.html'], /<a rel="prev" href="..\/index.html">‹<\/a>2\/2/, "urls: 'html'");
  assert.match(old['index.html'], /<a rel="next" href="index\/2.html">/);
});

test('a term\'s listing page lists its public posts of every post type', async () => {
  const { out, files } = await built();
  assert.match(out['kategorie/salon/index.html'], /<title>Salon<\/title>.*<h1>Salon<\/h1><p>Aus dem Salon<\/p><ul><li>C<\/li><li>B<\/li><\/ul>1\/2/s);
  assert.match(out['kategorie/salon/2/index.html'], /<ul><li>A<\/li><li>Fest<\/li><\/ul>2\/2/, 'news first, then events; drafts left out');
  assert.match(out['sitemap.xml'], /<loc>https:\/\/salon.example\/kategorie\/salon\/<\/loc>/);
  assert.doesNotMatch(out['sitemap.xml'], /\/2\//, 'further pages are not in the sitemap');
  assert.ok(!files.some((f) => f.path.includes('leer')), 'no listing for a term without posts');
});

test('the editor gets a collection per post type and per taxonomy', () => {
  const { collections } = schema({ site: {}, theme });
  assert.deepEqual(collections.filter((c) => c.folder).map((c) => c.folder), ['content/pages', 'content/news', 'content/events', 'content/kategorien', 'content/schlagworte', 'content/patterns']);
  assert.deepEqual(collections.find((c) => c.name === 'news').fields.find((f) => f.name === 'kategorien'), { name: 'kategorien', label: 'Kategorien', widget: 'relation', collection: 'kategorien', multiple: true, taxonomy: 'kategorien', required: false });
  assert.deepEqual(schema({ site: {}, theme, editable: ['post'] }).collections.map((c) => c.name), ['news', 'events'], 'authors see the post types, not the terms');
});

test('roles: posts of every type are posts; terms are content for editors and administrators', () => {
  const site = gatewaySite({ languages: ['de', 'en'] }, theme);
  assert.deepEqual([site.postTypes, site.taxonomies], [['news', 'events'], ['kategorien', 'schlagworte']]);
  assert.deepEqual(['content/news/a.json', 'content/events/fest.json', 'content/en/events/fest.json', 'content/kategorien/salon.json', 'content/en/schlagworte/farbe.json'].map((p) => classify(p, site)), ['post', 'post', 'post', 'content', 'content']);
  const author = { email: 'a@test', role: 'author' };
  const editor = { email: 'e@test', role: 'editor' };
  assert.equal(denial(author, { operation: 'create', path: 'content/events/neu.json', text: '{}' }, site), null, 'an author writes posts of any type');
  assert.ok(denial(author, { operation: 'create', path: 'content/kategorien/neu.json', text: '{}' }, site), 'but adds no terms');
  assert.equal(denial(editor, { operation: 'create', path: 'content/kategorien/neu.json', text: '{}' }, site), null);
  assert.equal(classify('content/events/x.json', { postType: 'events' }), 'post', 'a site with one postType as before');
});

test('preview links show posts of every type', async () => {
  const site = { languages: ['de', 'en'] };
  assert.deepEqual(previewTarget('content/en/events/fest.json', gatewaySite(site, theme)), { kind: 'post', slug: 'fest', lang: 'en', type: 'events' });
  const files = Object.keys(content).map((path) => ({ path }));
  const out = await renderPreview({ site: {}, theme, target: { kind: 'post', type: 'news', slug: 'd' }, files, read: async (paths) => paths.map((p) => content[p]), now: new Date('2026-06-01') });
  assert.match(out, /^<base href="\/neuigkeiten\/d\/"><meta name="robots" content="noindex"><h1>Neuigkeit: D<\/h1>/, 'a draft of the second-named type');
});

test('languages: a language shows the default language\'s posts of a type until it has its own; terms are translated', async () => {
  const files = {
    ...content,
    'content/en/pages/index.json': json({ title: 'Home', status: 'published', sections: [{ type: 'news' }, { type: 'events' }] }),
    'content/en/events/party.json': post('Party', '2026-07-01'),
    'content/en/kategorien/salon.json': json({ title: 'Salon (en)' }),
  };
  const { out } = await built({ languages: ['de', 'en'] }, files);
  assert.match(out['en/index.html'], /<a href="..\/neuigkeiten\/c\/">C<\/a> <a href="kategorie\/salon\/">Salon \(en\)<\/a>/, 'German news, English term');
  assert.match(out['en/index.html'], /<ol><li>Party<\/li><\/ol>/, 'own events');
  assert.ok(!out['en/neuigkeiten/c/index.html'], 'shared news are published once');
});

test('a theme names either postType or postTypes, with names of their own', async () => {
  await assert.rejects(built({}, content, { ...theme, postType: theme.postTypes[0] }), /either postType or postTypes/);
  await assert.rejects(built({}, content, { ...theme, taxonomies: [{ name: 'news' }] }), /the name "news" is taken/);
  await assert.rejects(built({}, content, { ...theme, taxonomies: [{ name: 'pages' }] }), /the name "pages" is taken/);
  await assert.rejects(built({ languages: ['de', 'en'] }, content, { ...theme, taxonomies: [{ name: 'en' }] }), /the language "en"/);
});
