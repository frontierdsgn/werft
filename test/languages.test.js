// Sites in several languages (`languages` in werft.config.js): content per language, output
// paths, the theme API for the entry's language, the sitemap, the admin schema and the gateway's
// checks for content/<lang>/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, createContext, html } from '../lib/index.js';
import { schema } from '../lib/schema.js';
import { deepMerge, differences } from '../lib/content.js';
import { createGateway, gatewaySite } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { fakeGitHub } from './fake-github.js';

const memoryStore = (files) => ({
  list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).sort(),
  readText: async (path) => { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[path]; },
});
const json = (data) => JSON.stringify(data);

// A small site with every kind of content.
const defaultContent = {
  'content/pages/index.json': json({ title: 'Start', status: 'published', sections: [
    { type: 'text', body: '**Hallo** [Kontakt](kontakt.html) ![Fähre](assets/img/a.jpg)' },
    { type: 'pattern', pattern: 'anfahrt' },
    { type: 'form', form: 'anfrage' },
  ] }),
  'content/pages/kontakt.json': json({ title: 'Kontakt', status: 'published', sections: [{ type: 'text', body: 'Telefon' }] }),
  'content/pages/geheim.json': json({ title: 'Geheim', status: 'published', seo: { noindex: true }, sections: [] }),
  'content/pages/entwurf.json': json({ title: 'Entwurf', status: 'draft', sections: [] }),
  'content/patterns/anfahrt.json': json({ title: 'Anfahrt', sections: [{ type: 'text', body: 'Mit der Fähre' }] }),
  'content/patterns/hinweis.json': json({ title: 'Hinweis', sections: [{ type: 'text', body: 'Geöffnet' }] }),
  'content/forms/anfrage.json': json({ title: 'Anfrage', button: 'Senden' }),
  'content/events/konzert.json': json({ title: 'Konzert', status: 'published', date: '2026-07-01' }),
  'content/settings/site.json': json({ title: 'Salon', url: 'https://salon.example/', phone: '0123', footer: { text: 'Am Fluss', links: [{ label: 'Impressum', url: 'impressum.html' }] } }),
  'content/settings/menus.json': json({ main: { label: 'Haupt', items: [{ label: 'Start', url: 'index.html' }, { label: 'Kontakt', url: 'kontakt.html' }] }, footer: { label: 'Fuß', items: [{ label: 'Impressum', url: 'impressum.html' }] } }),
  'content/settings/redirects.json': json({ redirects: [{ from: '/alt.html', to: '/kontakt.html' }] }),
};

const theme = {
  blocks: {
    text: { label: 'Text', fields: [], render: (s, ctx) => html`<section>${ctx.md(s.body)}</section>` },
    form: { label: 'Formular', fields: [], render: (s, ctx) => html`<form>${ctx.form(s.form)?.button}</form>` },
  },
  menus: { main: 'Hauptmenü', footer: 'Fußzeile' },
  formFields: [],
  postType: { name: 'events', label: 'Termine', singular: 'Termin', fields: [], date: 'date', url: (post) => `termine/${post.slug}.html` },
  renderPost: (post, ctx) => html`<title>${post.title} | ${ctx.settings.title}</title>`,
  renderPage: (page, ctx) => html`<!doctype html><html lang="${ctx.settings.lang ?? 'de'}"><title>${page.title} | ${ctx.settings.title}</title>
    <nav>${ctx.menu('main').items.map((i) => html`<a href="${i.url}">${i.label}</a>`)}</nav>${ctx.blocks(page.sections)}
    <ul>${ctx.posts().map((p) => html`<li>${p.title}</li>`)}</ul><footer>${ctx.settings.footer.text} ${ctx.settings.phone} ${ctx.menu('footer').items.map((i) => i.label)}</footer></html>`,
};

const NOW = new Date('2026-06-01T00:00:00Z');
const built = async (site, files, t = theme) => {
  const result = await build({ site, theme: t, store: memoryStore(files), now: NOW, media: {} });
  return Object.fromEntries(result.files.map((f) => [f.path, f.text]));
};

test('a site without languages builds as before', async () => {
  // Recorded with werft 0.5.0 before languages existed.
  const out = await built({ name: 'S' }, defaultContent);
  assert.deepEqual(out, GOLDEN);
});

const GOLDEN = {
  'geheim.html': '<!doctype html><html lang="de"><title>Geheim | Salon</title><nav><a href="index.html">Start</a><a href="kontakt.html">Kontakt</a></nav><ul><li>Konzert</li></ul><footer>Am Fluss 0123 Impressum</footer></html>',
  'index.html': '<!doctype html><html lang="de"><title>Start | Salon</title><nav><a href="index.html">Start</a><a href="kontakt.html">Kontakt</a></nav><section><p><strong>Hallo</strong> <a href="kontakt.html">Kontakt</a> <img src="assets/img/a.jpg" alt="Fähre"></p></section><section><p>Mit der Fähre</p></section><form>Senden</form><ul><li>Konzert</li></ul><footer>Am Fluss 0123 Impressum</footer></html>',
  'kontakt.html': '<!doctype html><html lang="de"><title>Kontakt | Salon</title><nav><a href="index.html">Start</a><a href="kontakt.html">Kontakt</a></nav><section><p>Telefon</p></section><ul><li>Konzert</li></ul><footer>Am Fluss 0123 Impressum</footer></html>',
  'termine/konzert.html': '<title>Konzert | Salon</title>',
  'robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://salon.example/sitemap.xml\n',
  'sitemap.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://salon.example/</loc></url><url><loc>https://salon.example/kontakt.html</loc></url><url><loc>https://salon.example/termine/konzert.html</loc></url></urlset>\n',
  _redirects: '/alt.html /kontakt.html 301\n',
  '.htaccess': 'Redirect 301 /alt.html /kontakt.html\n',
  '_werft/build.json': '{"built_at":"2026-06-01T00:00:00.000Z","next_publish":null,"redirects":[{"from":"/alt.html","to":"/kontakt.html"}]}',
  '_werft/media.json': '{}',
};

// The same site in German and English. English has its own home page, settings that only hold
// what differs, its own main menu and its own pattern "anfahrt"; the rest comes from German.
const english = {
  ...defaultContent,
  'content/en/pages/index.json': json({ title: 'Home', status: 'published', sections: [
    { type: 'text', body: '**Hello** [Contact](kontakt.html) ![Ferry](assets/img/a.jpg)' },
    { type: 'pattern', pattern: 'anfahrt' },
    { type: 'pattern', pattern: 'hinweis' },
    { type: 'form', form: 'anfrage' },
  ] }),
  'content/en/pages/nur-englisch.json': json({ title: 'Only English', status: 'published', sections: [] }),
  'content/en/patterns/anfahrt.json': json({ title: 'Directions', sections: [{ type: 'text', body: 'By ferry' }] }),
  'content/en/settings/site.json': json({ footer: { text: 'By the river' } }),
  'content/en/settings/menus.json': json({ main: { label: 'Main', items: [{ label: 'Home', url: 'index.html' }] } }),
};
const site = { name: 'S', languages: ['de', 'en'], mediaDirs: ['assets/img'] };

// A theme that uses the language API: assets and the language switcher through ctx.url and
// ctx.translations.
const switching = {
  ...theme,
  renderPage: (page, ctx) => html`<html lang="${ctx.lang}"><link href="${ctx.url('assets/css/site.css')}">
    <p>${ctx.languages.join(',')} ${ctx.translations.map((t) => html`<a href="${t.url}"${t.current ? html` aria-current="true"` : ''}${t.exists ? '' : html` data-missing`}>${t.lang}</a>`)}</p>${theme.renderPage(page, ctx)}</html>`,
};

test('each language is built: the default at the root, the others below their code', async () => {
  const out = await built(site, english);
  const pages = Object.keys(out).filter((p) => p.endsWith('.html')).sort();
  assert.deepEqual(pages, ['en/index.html', 'en/nur-englisch.html', 'geheim.html', 'index.html', 'kontakt.html', 'termine/konzert.html'], 'shared posts are published once, in German');
  const home = out['en/index.html'];
  assert.match(home, /<html lang="en">/, 'settings.lang is the language');
  assert.match(home, /<title>Home \| Salon<\/title>/, 'site settings come from German unless English has them');
  assert.match(home, /<footer>By the river 0123 Impressum<\/footer>/, 'English settings are laid over German ones; the footer menu is the German one');
  assert.match(home, /<nav><a href="index.html">Home<\/a><\/nav>/, 'the English main menu replaces the German one');
  assert.match(home, /<section><p>By ferry<\/p><\/section><section><p>Geöffnet<\/p><\/section>/, 'a pattern in English, else in German');
  assert.match(home, /<form>Senden<\/form>/, 'a form not translated comes from German');
  assert.match(home, /<a href="..\/kontakt.html">Contact<\/a> <img src="..\/assets\/img\/a.jpg" alt="Ferry">/, 'a page English lacks is the German one, media lead to the root');
  assert.match(home, /<ul><li>Konzert<\/li><\/ul>/, 'without own posts the German ones');
  assert.equal(out['index.html'], GOLDEN['index.html'], 'the default language is built as before');
});

test('a language with its own posts shows only those', async () => {
  const out = await built(site, { ...english, 'content/en/events/concert.json': json({ title: 'Concert', status: 'published', date: '2026-07-01' }) });
  assert.match(out['en/index.html'], /<ul><li>Concert<\/li><\/ul>/);
  assert.ok(out['en/termine/concert.html'] && !out['en/termine/konzert.html']);
});

test('ctx.url and ctx.translations work from every page', async () => {
  const out = await built(site, english, switching);
  assert.match(out['index.html'], /<link href="assets\/css\/site.css"><p>de,en <a href=".\/" aria-current="true">de<\/a><a href="en\/">en<\/a><\/p>/);
  assert.match(out['kontakt.html'], /<a href="kontakt.html" aria-current="true">de<\/a><a href="en\/" data-missing>en<\/a>/, 'no English page: the English home page');
  assert.match(out['en/index.html'], /<link href="..\/assets\/css\/site.css"><p>de,en <a href="..\/">de<\/a><a href=".\/" aria-current="true">en<\/a><\/p>/);
  assert.match(out['en/nur-englisch.html'], /<a href="..\/" data-missing>de<\/a><a href="nur-englisch.html" aria-current="true">en<\/a>/);
  const ctx = createContext({ site, theme, content: { pages: [{ slug: 'p' }], posts: [], patterns: [], forms: [], settings: {}, menus: {}, redirects: [], languages: { en: {} } }, lang: 'en' }).for({ slug: 'p' });
  assert.deepEqual(['assets/a.jpg', 'en/b.html', '', 'https://x.test/', '#top', '/abs'].map(ctx.url), ['../assets/a.jpg', 'b.html', '../', 'https://x.test/', '#top', '/abs']);
});

test('without languages, ctx.lang is the site setting and there is nothing to switch', () => {
  const content = { pages: [], posts: [], patterns: [], forms: [], settings: { lang: 'fr' }, menus: {}, redirects: [] };
  const ctx = createContext({ site: {}, theme, content }).for({ slug: 'p' });
  assert.deepEqual([ctx.lang, ctx.languages, ctx.translations, ctx.url('assets/a.jpg')], ['fr', [], [], 'assets/a.jpg']);
  assert.equal(createContext({ site: {}, theme, content: { ...content, settings: {} } }).lang, 'de');
});

test('links to pages a language lacks lead to the default language\'s page', async () => {
  const linking = {
    ...theme,
    renderPage: (page, ctx) => html`<nav>${['main', 'footer'].flatMap((m) => ctx.menu(m).items).map((i) => html`<a href="${i.url}">${i.label}</a>`)}</nav>
      ${ctx.blocks(page.sections)}<footer>${ctx.settings.footer.links.map((l) => html`<a href="${l.url}">${l.label}</a>`)}</footer>
      <p>${ctx.posts().map((p) => html`<a href="${ctx.postUrl(p)}">${p.title}</a>`)}</p>`,
  };
  const out = await built(site, {
    ...english,
    'content/pages/impressum.json': json({ title: 'Impressum', status: 'published', sections: [] }),
    'content/settings/site.json': json({ title: 'Salon', footer: { text: 'Am Fluss', links: [{ label: 'Impressum', url: 'impressum.html#anbieter' }] } }),
    'content/en/pages/index.json': json({ title: 'Home', status: 'published', sections: [
      { type: 'text', body: '[Contact](kontakt.html?von=en) [Only English](nur-englisch.html) [Top](#top) [Home](./) [Nowhere](fehlt.html) [Web](https://x.test/impressum.html)' },
    ] }),
  }, linking);
  const home = out['en/index.html'];
  assert.match(home, /<nav><a href="index.html">Home<\/a><a href="..\/impressum.html">Impressum<\/a><\/nav>/, 'English main menu; the German footer menu leads to German pages');
  assert.match(home, /<a href="..\/kontakt.html\?von=en">Contact<\/a> <a href="nur-englisch.html">Only English<\/a> <a href="#top">Top<\/a> <a href=".\/">Home<\/a> <a href="fehlt.html">Nowhere<\/a> <a href="https:\/\/x.test\/impressum.html">Web<\/a>/);
  assert.match(home, /<footer><a href="..\/impressum.html#anbieter">Impressum<\/a><\/footer>/, 'inherited settings too');
  assert.match(home, /<p><a href="..\/termine\/konzert.html">Konzert<\/a><\/p>/, 'shared posts link to their German page');
  assert.match(out['impressum.html'], /<a href="impressum.html#anbieter">/, 'the default language is left as it is');
});

test('post pages of a language lead to the default language\'s pages it lacks, too', async () => {
  // A post page one folder down links to pages as "../<page>".
  const posting = {
    ...theme,
    renderPost: (post, ctx) => html`<title>${post.title}</title><nav>${['main', 'footer'].flatMap((m) => ctx.menu(m).items).map((i) => html`<a href="../${i.url}">${i.label}</a>`)}</nav><a href="../nur-englisch.html#x">E</a>`,
  };
  const out = await built(site, {
    ...english,
    'content/pages/impressum.json': json({ title: 'Impressum', status: 'published', sections: [] }),
    'content/en/events/concert.json': json({ title: 'Concert', status: 'published', date: '2026-07-01' }),
  }, posting);
  assert.equal(out['en/termine/concert.html'], '<title>Concert</title><nav><a href="../index.html">Home</a><a href="../../impressum.html">Impressum</a></nav><a href="../nur-englisch.html#x">E</a>');
});

test('a language\'s own posts count once one of them is public', async () => {
  const draft = { ...english, 'content/en/events/concert.json': json({ title: 'Concert', status: 'draft', date: '2026-07-01' }) };
  let out = await built(site, draft);
  assert.match(out['en/index.html'], /<ul><li>Konzert<\/li><\/ul>/, 'a draft changes nothing on the public site');
  assert.ok(!out['en/termine/concert.html'] && !out['en/termine/konzert.html']);
  const scheduled = { ...english, 'content/en/events/concert.json': json({ title: 'Concert', status: 'published', publish_date: '2026-06-02T00:00:00Z' }) };
  out = await built(site, scheduled);
  assert.match(out['en/index.html'], /<ul><li>Konzert<\/li><\/ul>/, 'nor does a post that is not due');
  assert.equal(JSON.parse(out['_werft/build.json']).next_publish, '2026-06-02T00:00:00.000Z', 'it is rebuilt when due');
});

test('a site below a base path keeps its languages below it', async () => {
  const out = await built({ ...site, base: 'salon' }, english, switching);
  assert.ok(out['salon/en/index.html'] && out['salon/index.html']);
  assert.match(out['salon/en/index.html'], /<link href="..\/assets\/css\/site.css">/);
});

test('the editor stores in a language\'s settings only what differs from the default language', () => {
  const base = { title: 'Salon', phone: '0123', footer: { text: 'Am Fluss', links: [{ label: 'Impressum' }] }, tagline: 'Am Wasser' };
  const saved = { footer: { text: 'By the river' } };
  // What the editor shows and changes: the English settings complete.
  const shown = deepMerge(base, saved);
  assert.deepEqual(shown, { title: 'Salon', phone: '0123', footer: { text: 'By the river', links: [{ label: 'Impressum' }] }, tagline: 'Am Wasser' });
  assert.deepEqual(differences(shown, base, saved), saved, 'unchanged: the file stays as it is');
  shown.footer.links[0].label = 'Imprint';
  delete shown.tagline;
  const next = differences(shown, base, saved);
  assert.deepEqual(next, { footer: { text: 'By the river', links: [{ label: 'Imprint' }] }, tagline: null }, 'a changed list is kept whole; a removed text is null');
  assert.deepEqual(deepMerge(base, next), shown, 'null removes the value');
  assert.deepEqual(deepMerge(base, JSON.parse('{"__proto__": {"x": 1}, "constructor": 2}')), base, 'no keys that reach the prototype');
  // Menus are replaced per location.
  assert.deepEqual(differences({ main: { items: [1] }, footer: { items: [2] } }, { main: { items: [9] }, footer: { items: [2] } }, null, 1), { main: { items: [1] } });
});

test('the sitemap lists every language and names the versions of a page', async () => {
  const out = await built(site, english);
  const map = out['sitemap.xml'];
  assert.match(map, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9" xmlns:xhtml="http:\/\/www.w3.org\/1999\/xhtml">/);
  assert.match(map, /<url><loc>https:\/\/salon.example\/<\/loc><xhtml:link rel="alternate" hreflang="de" href="https:\/\/salon.example\/"\/><xhtml:link rel="alternate" hreflang="en" href="https:\/\/salon.example\/en\/"\/><\/url>/);
  assert.match(map, /<url><loc>https:\/\/salon.example\/kontakt.html<\/loc><\/url>/, 'a page in one language has no alternates');
  assert.match(map, /<url><loc>https:\/\/salon.example\/en\/nur-englisch.html<\/loc><\/url>/);
  assert.match(map, /<url><loc>https:\/\/salon.example\/termine\/konzert.html<\/loc><\/url>/, 'a shared post is German only');
  assert.doesNotMatch(map, /en\/termine/);
  assert.equal(out['robots.txt'], GOLDEN['robots.txt']);
});

test('languages must be language codes', async () => {
  await assert.rejects(built({ languages: 'de' }, defaultContent), /languages must list/);
  await assert.rejects(built({ languages: ['de', '../x'] }, defaultContent), /languages must list/);
  await assert.rejects(built({ languages: ['de', 'en', 'EN'] }, defaultContent), /languages must list/, 'codes differing only in case are one language');
  await assert.rejects(built({ languages: ['de', 'en'] }, defaultContent, { ...theme, postType: { ...theme.postType, name: 'en' } }), /post type/);
});

test('the admin schema of a language edits that language\'s files', () => {
  const files = (lang) => {
    const { collections } = schema({ site, theme, lang });
    return [...collections.filter((c) => c.folder).map((c) => c.folder), ...collections.find((c) => c.name === 'settings').files.map((f) => f.file)];
  };
  assert.deepEqual(files('de'), ['content/pages', 'content/events', 'content/patterns', 'content/forms', 'content/settings/site.json', 'content/settings/menus.json', 'content/settings/redirects.json']);
  assert.deepEqual(files('en'), ['content/en/pages', 'content/en/events', 'content/en/patterns', 'content/en/forms', 'content/en/settings/site.json', 'content/en/settings/menus.json', 'content/settings/redirects.json'], 'redirects are shared');
  const settings = (s) => schema({ site: s, theme }).collections.find((c) => c.name === 'settings').files[0].fields.map((f) => f.name);
  assert.ok(settings({}).includes('lang'));
  assert.ok(!settings(site).includes('lang'), 'the language of each version comes from werft.config.js');
});

test('the gateway treats content/<lang>/ like the default language\'s content', async () => {
  const people = { admin: 'administrator', editor: 'editor', author: 'author', contrib: 'contributor' };
  const users = await Promise.all(Object.entries(people).map(async ([name, role]) => ({ email: `${name}@test`, name, role, password: await hashPassword(`${name}-password`, 1000) })));
  const hub = fakeGitHub();
  hub.seed({
    '.werft/users.json': serializeUsers(users),
    'content/pages/index.json': '{"title":"Start","status":"published"}\n',
    'content/en/pages/index.json': '{"title":"Home","status":"published"}\n',
    'content/en/forms/feedback.json': '{"title":"Feedback"}\n',
  });
  let clock = Date.parse('2026-06-01T00:00:00Z');
  const ticks = [];
  const gateway = createGateway({
    storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch: hub.fetch }),
    secret: 'x'.repeat(32), branch: 'main', iterations: 1000, now: () => clock,
    site: gatewaySite({ ...site, name: 'S' }, theme),
    onTick: ({ due }) => { ticks.push(due); }, lastBuild: () => '2026-01-01T00:00:00Z',
  });
  const call = async (url, { token, method = 'GET', body } = {}) => {
    const response = await gateway(new Request(`https://site.test/api/werft${url}`, { method, headers: { ...(token && { authorization: `token ${token}` }), ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) }));
    return { status: response.status, data: await response.json() };
  };
  const tokens = {};
  for (const name of Object.keys(people)) tokens[name] = (await call('/session', { method: 'POST', body: { email: `${name}@test`, password: `${name}-password` } })).data.access_token;
  const create = (who, path, data) => call('/api/v1/repos/werft/site/contents', { token: tokens[who], method: 'POST', body: { branch: 'main', message: 'x', files: [{ operation: 'create', path, content: Buffer.from(JSON.stringify(data)).toString('base64') }] } });
  const expect = [
    ['editor', 'content/en/pages/kontakt.json', 201], ['editor', 'content/en/patterns/a.json', 201], ['editor', 'content/en/forms/b.json', 201],
    ['editor', 'content/en/settings/site.json', 403], ['editor', 'content/en/settings/menus.json', 403], ['admin', 'content/en/settings/site.json', 201],
    ['author', 'content/en/pages/neu.json', 403], ['author', 'content/en/events/b.json', 201],
    ['contrib', 'content/en/events/c.json', 403], ['editor', 'content/fr/pages/x.json', 403],
  ];
  for (const [who, path, status] of expect) assert.equal((await create(who, path, { title: 'T', status: 'published' })).status, status, `${who} ${path}`);
  assert.equal((await create('contrib', 'content/en/events/d.json', { title: 'D', status: 'pending' })).status, 201, 'contributors submit English posts for review');

  // A form that exists only in English takes submissions too.
  const sent = await gateway(new Request('https://site.test/api/werft/forms/feedback', { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams({ text: 'Nice' }) }));
  assert.equal(sent.status, 201);
  const { data } = await call('/submissions', { token: tokens.admin });
  assert.deepEqual(data.forms.map((f) => [f.slug, f.title, f.submissions.length]), [['b', 'T', 0], ['feedback', 'Feedback', 1]]);
  const page = await gateway(new Request('https://site.test/api/werft/forms/feedback', { method: 'POST', headers: { referer: 'https://site.test/en/kontakt.html' }, body: new URLSearchParams({ text: 'Again' }) }));
  assert.match(await page.text(), /<html lang="en">.*<main lang="de"><p>Vielen Dank/s, 'the thank-you page takes the form page\'s language, its German text is marked');

  // A scheduled English page asks for a rebuild once it is due.
  await create('admin', 'content/en/pages/later.json', { title: 'Later', status: 'published', publish_date: '2026-06-01T06:00:00Z' });
  clock = Date.parse('2026-06-01T07:00:00Z');
  assert.deepEqual((await call('/tick', { token: tokens.admin })).data.due, ['later']);
});
