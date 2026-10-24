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
    + '<meta name="twitter:card" content="summary_large_image"><link rel="alternate" type="application/rss+xml" title="Salon: News" href="feed.xml"></head>');
  assert.equal(out['kontakt.html'], '<head><title>Kontakt | Salon</title><meta name="robots" content="noindex">'
    + '<link rel="canonical" href="https://salon.example/kontakt.html"><meta property="og:type" content="website"><meta property="og:site_name" content="Salon">'
    + '<meta property="og:title" content="Kontakt"><meta property="og:url" content="https://salon.example/kontakt.html">'
    + '<meta property="og:image" content="https://cdn.example/k.png"><meta name="twitter:card" content="summary_large_image"><link rel="alternate" type="application/rss+xml" title="Salon: News" href="feed.xml"></head>');
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
  const links = (text) => [...text.matchAll(/<link rel="(?:alternate" hreflang|canonical)[^>]*>/g)].map((m) => m[0]);
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

test('a page with the slug 404 builds to 404.html, noindex, out of the sitemap, for every host', async () => {
  const files = {
    'content/settings/site.json': json({ title: 'Salon', url: 'https://salon.example/' }),
    'content/settings/redirects.json': json({ redirects: [{ from: '/alt.html', to: '/neu.html' }] }),
    'content/pages/index.json': json({ title: 'Start' }),
    'content/pages/404.json': json({ title: 'Nicht gefunden' }),
    'content/en/pages/404.json': json({ title: 'Not found' }),
  };
  const page = { ...theme, renderPage: (p, ctx) => html`<head>${ctx.head()}</head><a href="${ctx.url('')}">Start</a>` };
  const out = await built({ languages: ['de', 'en'] }, files, page);
  assert.match(out['404.html'], /^<head><base href="\/"><title>Nicht gefunden<\/title><meta name="robots" content="noindex">.*<a href=".\/">Start<\/a>$/);
  assert.match(out['en/404.html'], /^<head><base href="\/en\/"><title>Not found<\/title><meta name="robots" content="noindex">.*<a href="..\/">Start<\/a>$/);
  assert.doesNotMatch(out['sitemap.xml'], /404/);
  const searched = await built({}, files, { ...page, search: true });
  assert.ok(searched['_werft/search/de.json'] && !searched['_werft/search/de.json'].includes('Nicht gefunden'), 'nor in the site search');
  assert.doesNotMatch(out['404.html'], /canonical|og:url|hreflang/);
  assert.match(out['index.html'], /^<head><title>Start<\/title><link/, 'other pages get no <base>');
  assert.equal(out['.htaccess'], 'Redirect 301 /alt.html /neu.html\nErrorDocument 404 /404.html\n');
  assert.equal(out['en/.htaccess'], 'ErrorDocument 404 /en/404.html\n');
  // Below a base path, without redirects.
  delete files['content/settings/redirects.json'];
  const below = await built({ base: 'salon' }, files, page);
  assert.match(below['salon/404.html'], /^<head><base href="\/salon\/">/);
  assert.equal(below['salon/.htaccess'], 'ErrorDocument 404 /salon/404.html\n');
  assert.equal(below['.htaccess'], undefined);
  const slash = await built({ base: '/salon' }, files, page);
  assert.equal(slash['salon/.htaccess'], 'ErrorDocument 404 /salon/404.html\n', 'a base path with a leading slash');
});

test('the site icon appears on every page and in the web manifest', async () => {
  const files = {
    'content/settings/site.json': json({ title: 'Salon', icon: 'assets/img/icon.png' }),
    'content/pages/index.json': json({ title: 'Start' }),
    'content/en/pages/index.json': json({ title: 'Home' }),
    'content/news/neu.json': json({ title: 'Neu' }),
  };
  const result = await build({ site: { languages: ['de', 'en'], mediaDirs: ['assets/img'] }, theme, store: memoryStore(files), now: NOW, media: { 'assets/img/icon.png': { width: 512, height: 512 } } });
  const out = Object.fromEntries(result.files.map((f) => [f.path, f.text]));
  const tags = '<link rel="icon" href="assets/img/icon.png" type="image/png" sizes="512x512"><link rel="apple-touch-icon" href="assets/img/icon.png"><link rel="manifest" href="manifest.webmanifest"></head>';
  assert.ok(out['index.html'].endsWith(tags));
  assert.ok(out['en/index.html'].endsWith(tags.replace(/href="/g, 'href="../')));
  assert.ok(out['news/neu.html'].endsWith(tags.replace(/href="/g, 'href="../')));
  assert.deepEqual(JSON.parse(out['manifest.webmanifest']), { name: 'Salon', start_url: './', display: 'browser', icons: [{ src: 'assets/img/icon.png', sizes: '512x512', type: 'image/png' }] });
  // Without an icon: no tags and no manifest.
  const plain = await built({}, { 'content/pages/index.json': json({ title: 'Start' }) });
  assert.doesNotMatch(plain['index.html'], /icon|manifest/);
  assert.equal(plain['manifest.webmanifest'], undefined);
});

test('the site icon works below a base path, on the not-found page and as the editor stores it', async () => {
  const { schema } = await import('../lib/schema.js');
  const files = {
    'content/settings/site.json': json({ title: 'Salon', icon: '/salon/assets/img/icon.png' }),
    'content/en/settings/site.json': json({ icon: 'assets/img/other.png' }),
    'content/pages/index.json': json({ title: 'Start' }),
    'content/pages/404.json': json({ title: 'Nicht gefunden' }),
    'content/en/pages/404.json': json({ title: 'Not found' }),
  };
  const site = { base: 'salon', languages: ['de', 'en'], mediaDirs: ['assets/img'] };
  const result = await build({ site, theme, store: memoryStore(files), now: NOW, media: { 'assets/img/icon.png': { width: 512, height: 512 } } });
  const out = Object.fromEntries(result.files.map((f) => [f.path, f.text]));
  assert.match(out['salon/index.html'], /<link rel="icon" href="assets\/img\/icon.png" type="image\/png" sizes="512x512">/);
  assert.match(out['salon/404.html'], /^<head><base href="\/salon\/">.*<link rel="icon" href="assets\/img\/icon.png"/);
  // The default language's icon serves every language; other languages' settings do not offer one.
  assert.match(out['salon/en/404.html'], /^<head><base href="\/salon\/en\/">.*<link rel="icon" href="..\/assets\/img\/icon.png"/);
  assert.equal(JSON.parse(out['salon/manifest.webmanifest']).icons[0].src, 'assets/img/icon.png');
  const settings = (lang) => schema({ site, theme, lang }).collections.find((c) => c.name === 'settings').files.find((f) => f.name === 'site').fields.map((f) => f.name);
  assert.ok(settings('de').includes('icon'));
  assert.ok(!settings('en').includes('icon'));
  // An SVG icon: no size, and no home-screen icon.
  const svg = await built({}, { 'content/settings/site.json': json({ icon: 'assets/img/icon.svg' }), 'content/pages/index.json': json({ title: 'Start' }) });
  assert.match(svg['index.html'], /<link rel="icon" href="assets\/img\/icon.svg" type="image\/svg\+xml"><link rel="manifest" href="manifest.webmanifest">/);
  assert.equal(JSON.parse(svg['manifest.webmanifest']).name, undefined);
});

test('the build writes an RSS feed of the newest posts per language, and ctx.head() links it', async () => {
  const files = {
    'content/settings/site.json': json({ title: 'Salon', url: 'https://salon.example/' }),
    'content/pages/index.json': json({ title: 'Start' }),
    'content/en/pages/index.json': json({ title: 'Home' }),
    'content/fr/pages/index.json': json({ title: 'Accueil' }),
    'content/news/alt.json': json({ title: 'Alt', publish_date: '2026-01-02T10:00:00.000Z', date: '2027-03-01' }),
    'content/news/neu.json': json({ title: 'Neu & frisch\u000b', publish_date: '2026-05-01T08:00:00.000Z', teaser: 'Ab <Juni> & 10&euro;' }),
    'content/news/datum.json': json({ title: 'Nur Datum', date: '2026-03-01' }),
    'content/news/versteckt.json': json({ title: 'Versteckt', publish_date: '2026-05-02T08:00:00.000Z', seo: { noindex: true } }),
    'content/news/geplant.json': json({ title: 'Geplant', publish_date: '2026-12-01T08:00:00.000Z' }),
    'content/news/entwurf.json': json({ title: 'Entwurf', status: 'draft' }),
    'content/en/news/new.json': json({ title: 'New', publish_date: '2026-05-01T08:00:00.000Z' }),
  };
  const feedTheme = { ...theme, postType: { ...theme.postType, label: 'Neuigkeiten', date: 'date', feed: { title: (lang) => (lang === 'en' ? 'Salon: News' : undefined), description: (post, ctx) => post.teaser && `${post.teaser} (${ctx.lang}, ${ctx.url('')})` } } };
  const out = await built({ languages: ['de', 'en', 'fr'] }, files, feedTheme);
  // Newest first by publish date (else the post type's date); drafts, scheduled and noindex posts
  // left out; descriptions are text inside HTML; characters XML does not allow are dropped.
  assert.equal(out['feed.xml'], '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Salon: Neuigkeiten</title>'
    + '<link>https://salon.example/</link><description>Salon: Neuigkeiten</description><language>de</language>'
    + '<atom:link href="https://salon.example/feed.xml" rel="self" type="application/rss+xml"/>'
    + '<item><title>Neu &amp; frisch</title><link>https://salon.example/news/neu.html</link><guid isPermaLink="true">https://salon.example/news/neu.html</guid>'
    + '<pubDate>Fri, 01 May 2026 08:00:00 GMT</pubDate><description>Ab &amp;lt;Juni&amp;gt; &amp;amp; 10&amp;amp;euro; (de, ../)</description></item>'
    + '<item><title>Nur Datum</title><link>https://salon.example/news/datum.html</link><guid isPermaLink="true">https://salon.example/news/datum.html</guid>'
    + '<pubDate>Sun, 01 Mar 2026 00:00:00 GMT</pubDate></item>'
    + '<item><title>Alt</title><link>https://salon.example/news/alt.html</link><guid isPermaLink="true">https://salon.example/news/alt.html</guid>'
    + '<pubDate>Fri, 02 Jan 2026 10:00:00 GMT</pubDate></item></channel></rss>\n');
  assert.match(out['en/feed.xml'], /<title>Salon: News<\/title>.*<language>en<\/language><atom:link href="https:\/\/salon.example\/en\/feed.xml".*<item><title>New<\/title><link>https:\/\/salon.example\/en\/news\/new.html<\/link>/);
  // French shows the German posts and links their feed, by its title.
  assert.equal(out['fr/feed.xml'], undefined);
  const link = (text) => text.match(/<link rel="alternate" type="application\/rss\+xml"[^>]*>/)?.[0];
  assert.equal(link(out['index.html']), '<link rel="alternate" type="application/rss+xml" title="Salon: Neuigkeiten" href="feed.xml">');
  assert.equal(link(out['en/index.html']), '<link rel="alternate" type="application/rss+xml" title="Salon: News" href="feed.xml">');
  assert.equal(link(out['fr/index.html']), '<link rel="alternate" type="application/rss+xml" title="Salon: Neuigkeiten" href="../feed.xml">');
  // Posts without pages of their own link to the home page.
  const { renderPost, ...listOnly } = feedTheme;
  const list = await built({}, { ...files, 'content/settings/site.json': json({ title: 'Salon', url: 'https://salon.example/salon/' }) }, listOnly);
  assert.match(list['feed.xml'], /<item><title>Neu &amp; frisch<\/title><link>https:\/\/salon.example\/salon\/<\/link><guid isPermaLink="false">https:\/\/salon.example\/salon\/#neu<\/guid>/);
  // No feed and no link without a site address, on a site hidden from search engines, without
  // public posts, or with feed: false.
  for (const [why, more, t] of [
    ['no address', { 'content/settings/site.json': json({ title: 'Salon' }) }, feedTheme],
    ['noindex', { 'content/settings/site.json': json({ title: 'Salon', url: 'https://salon.example/', search_visibility: 'noindex' }) }, feedTheme],
    ['no posts', Object.fromEntries(Object.keys(files).filter((f) => f.includes('/news/')).map((f) => [f, json({ status: 'draft' })])), feedTheme],
    ['off', {}, { ...feedTheme, postType: { ...feedTheme.postType, feed: false } }],
  ]) {
    const none = await built({}, { ...files, ...more }, t);
    assert.equal(none['feed.xml'], undefined, why);
    assert.equal(link(none['index.html']), undefined, why);
  }
});

test('ctx.head() writes the organization the site settings describe as JSON-LD on the home page', async () => {
  const { fields } = await import('../lib/index.js');
  const withOrg = { ...theme, settingsFields: [fields.organization()] };
  const files = {
    'content/settings/site.json': json({
      title: 'Salon', url: 'https://salon.example/', icon: 'assets/img/icon.png',
      organization: { type: 'LocalBusiness', street: 'Am Fluss 1', postal_code: '12345', city: 'Ort', country: 'DE', phone: '0123 456', email: '', hours: [
        { days: 'Montag bis Freitag', opens: '09:00', closes: '18:00' }, { days: 'Samstag', opens: '10:00', closes: '</script>' }, { days: 'Sonntag', opens: '', closes: '' },
      ] },
    }),
    'content/pages/index.json': json({ title: 'Start' }),
    'content/pages/kontakt.json': json({ title: 'Kontakt' }),
  };
  const out = await built({}, files, withOrg);
  const script = out['index.html'].match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1];
  assert.doesNotMatch(script, /<\//, 'no text ends the script early');
  assert.deepEqual(JSON.parse(script), {
    '@context': 'https://schema.org', '@type': 'LocalBusiness', name: 'Salon', url: 'https://salon.example/',
    logo: 'https://salon.example/assets/img/icon.png', telephone: '0123 456',
    address: { '@type': 'PostalAddress', streetAddress: 'Am Fluss 1', postalCode: '12345', addressLocality: 'Ort', addressCountry: 'DE' },
    openingHoursSpecification: [
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '09:00', closes: '18:00' },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Saturday'], opens: '10:00', closes: '</script>' },
    ],
  });
  assert.doesNotMatch(out['kontakt.html'], /ld\+json/, 'only on the home page');
  // Without the field in the theme, the settings are not read.
  assert.doesNotMatch((await built({}, files))['index.html'], /ld\+json/);
});
