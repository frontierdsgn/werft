// Site search: the index per language the build writes, the search box `ctx.search()` renders, and
// the script _werft/search.js, run here against a small stand-in for the browser's document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../lib/index.js';
import { find, pageText } from '../lib/search.js';

const memoryStore = (files) => ({
  list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).sort(),
  readText: async (path) => { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[path]; },
});
const json = (data) => JSON.stringify(data);

const content = {
  'content/pages/index.json': json({ title: 'Start', status: 'published', sections: [{ type: 'text', body: 'Willkommen im **Salon** am Fluss.' }] }),
  'content/pages/kontakt.json': json({ title: 'Kontakt', status: 'published', sections: [{ type: 'text', body: 'Rufen Sie an: Café & Fähre' }] }),
  'content/pages/danke.json': json({ title: 'Danke', status: 'published', seo: { noindex: true }, sections: [{ type: 'text', body: 'Fähre' }] }),
  'content/pages/entwurf.json': json({ title: 'Entwurf', status: 'draft', sections: [{ type: 'text', body: 'Fähre' }] }),
  'content/events/konzert.json': json({ name: 'Konzert am Fluss', status: 'published', date: '2026-07-01' }),
  'content/en/pages/index.json': json({ title: 'Home', status: 'published', sections: [{ type: 'text', body: 'Welcome to the ferry.' }] }),
};

const theme = {
  search: true,
  postType: { name: 'events', url: (post) => `termine/${post.slug}.html` },
  blocks: { text: { label: 'Text', fields: [], render: (section, ctx) => ctx.html`<div>${ctx.md(section.body)}</div>` } },
  renderPage: (page, ctx) => ctx.html`<html><head><title>${page.title} | Salon</title><script>var x = "Fähre";</script></head>
    <body><nav><a href="kontakt.html">Kontakt</a></nav>${ctx.search()}<main><h1>${page.title}</h1>${ctx.blocks(page.sections)}</main><footer>Impressum</footer></body></html>`,
  renderPost: (post, ctx) => ctx.html`<main><h1>${post.name}</h1><p>Am ${post.date}</p></main>`,
};

const built = async (site, overrides = {}) => {
  const { files } = await build({ site, theme: { ...theme, ...overrides }, store: memoryStore(content), media: {}, now: new Date('2026-01-01') });
  return Object.fromEntries(files.map((f) => [f.path, f.text]));
};

test('the build writes a search index per language with the text of each public page and post', async () => {
  const files = await built({ languages: ['de', 'en'] });
  const de = JSON.parse(files['_werft/search/de.json']);
  assert.equal(de.lang, 'de');
  assert.deepEqual(de.entries, [
    { url: '', title: 'Start', text: 'Start Willkommen im Salon am Fluss.' },
    { url: 'kontakt.html', title: 'Kontakt', text: 'Kontakt Rufen Sie an: Café & Fähre' },
    // A post without a `title` is named by its first heading.
    { url: 'termine/konzert.html', title: 'Konzert am Fluss', text: 'Konzert am Fluss Am 2026-07-01' },
  ]);
  // The other language: its own pages, below its code, and the default language's posts it shows.
  assert.deepEqual(JSON.parse(files['_werft/search/en.json']).entries, [
    { url: 'en/', title: 'Home', text: 'Home Welcome to the ferry.' },
    { url: 'termine/konzert.html', title: 'Konzert am Fluss', text: 'Konzert am Fluss Am 2026-07-01' },
  ]);
  assert.match(files['_werft/search.js'], /^\/\/ werft site search/);
  // ASCII only: a host may serve it without a charset.
  assert.match(files['_werft/search.js'], /^[\x00-\x7f]*$/);

  // The box on each page points at its language's index and the script, relative to the page.
  assert.match(files['index.html'], /<search class="werft-search" hidden><form data-werft-search="_werft\/search\/de.json" data-empty="Nichts gefunden.">/);
  assert.match(files['en/index.html'], /data-werft-search="\.\.\/_werft\/search\/en.json"/);
  assert.match(files['en/index.html'], /<script src="\.\.\/_werft\/search.js" defer><\/script>/);
});

test('a site below a base path and in one language gets one index at its base', async () => {
  const files = await built({ base: 'salon' });
  assert.deepEqual(Object.keys(files).filter((p) => p.includes('search')), ['salon/_werft/search.js', 'salon/_werft/search/de.json']);
  assert.deepEqual(JSON.parse(files['salon/_werft/search/de.json']).entries.map((e) => e.url), ['', 'kontakt.html', 'termine/konzert.html']);
});

test('without `search` in the theme nothing is written and ctx.search() says what is missing', async () => {
  const files = await built({}, { search: undefined, renderPage: (page, ctx) => ctx.html`<main>${page.title}</main>` });
  assert.deepEqual(Object.keys(files).filter((p) => p.includes('search')), []);
  await assert.rejects(built({}, { search: undefined }), /ctx.search\(\) needs `search: true` in the theme/);
});

test('the searched text leaves out what is not the page\'s content', () => {
  assert.equal(pageText('<p>Eins <b>zwei</b>&nbsp;drei &amp; &#x2013; &#252;</p><!-- vier --><style>p{}</style><svg><text>fünf</text></svg>'), 'Eins zwei drei & – ü');
  assert.equal(pageText('<header>Kopf</header><main id="m"><p>Inhalt</p></main><footer>Fuß</footer>'), 'Inhalt');
  assert.equal(pageText('<head><title>T</title></head><body><nav>Menü</nav><search>Suche</search>Text</body>'), 'Text');
});

test('a search matches every word, ignores case and accents, and ranks title matches first', () => {
  const entries = [
    { url: 'a.html', title: 'Anfahrt', text: 'Mit der Fähre über den Fluss, dann zu Fuß.' },
    { url: 'b.html', title: 'Fähre', text: 'Fahrplan der Fähre.' },
    { url: 'c.html', title: 'Kontakt', text: 'Telefon' },
  ];
  assert.deepEqual(find(entries, 'FAHRE').map((r) => r.url), ['b.html', 'a.html']);
  assert.deepEqual(find(entries, 'fähre fluss').map((r) => r.url), ['a.html']);
  assert.deepEqual(find(entries, '  '), []);
  assert.deepEqual(find(entries, 'fähre', 1).map((r) => r.url), ['b.html']);
  const long = { url: 'd.html', title: 'Lang', text: Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ') };
  assert.equal(find([long], 'w20')[0].snippet, `… ${Array.from({ length: 30 }, (_, i) => `w${i + 12}`).join(' ')} …`);
  assert.equal(find([long], 'lang')[0].snippet, `${Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')} …`);
});

// Just enough of a document for _werft/search.js.
function fakeElement(tag) {
  const listeners = {};
  return {
    tag, children: [], attributes: {}, hidden: false, textContent: '', value: '',
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    dispatch(type) { return Promise.all((listeners[type] ?? []).map((fn) => fn({ preventDefault() {} }))); },
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
  };
}

test('the script lists the results while the visitor types, linked from the page they are on', async () => {
  const files = await built({ languages: ['de', 'en'] });
  const box = fakeElement('search');
  box.hidden = true;
  const form = fakeElement('form');
  form.attributes = { 'data-werft-search': '../_werft/search/de.json', 'data-empty': 'Nichts gefunden.' };
  form.parentElement = box;
  const input = fakeElement('input');
  const list = fakeElement('ul');
  form.querySelector = (selector) => ({ input, ul: list })[selector];
  const requests = [];
  const index = { entries: [{ url: 'kontakt.html', title: 'Kontakt <b>', text: 'Café & Fähre' }, { url: 'javascript:alert(1).html', title: 'Fähre', text: '' }] };
  const run = new Function('document', 'location', 'fetch', files['_werft/search.js']);
  const document = { querySelectorAll: () => [form], createElement: fakeElement };
  const fetch = async (url) => { requests.push(url.href); return { ok: true, json: async () => index }; };
  run(document, { href: 'https://salon.example/en/index.html' }, fetch);
  run(document, { href: 'https://salon.example/en/index.html' }, fetch); // a second box's script binds nothing twice
  assert.equal(box.hidden, false);

  await input.dispatch('focus');
  input.value = 'fahre';
  await input.dispatch('input');
  assert.deepEqual(requests, ['https://salon.example/_werft/search/de.json']);
  // A slug that looks like a scheme stays a file below the site's root.
  assert.deepEqual(list.children.map((item) => item.children[0].href), ['https://salon.example/javascript:alert(1).html', 'https://salon.example/kontakt.html']);
  const [, item] = list.children;
  const [link, snippet] = item.children;
  assert.equal(link.textContent, 'Kontakt <b>');
  assert.equal(snippet.textContent, 'Café & Fähre');

  input.value = 'nichts';
  await form.dispatch('submit');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].textContent, 'Nichts gefunden.');
  input.value = '';
  await input.dispatch('input');
  assert.deepEqual(list.children, []);
});
