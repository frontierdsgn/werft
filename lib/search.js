// Site search without an external service. With `search: true` in the theme, the build writes one
// index per language, _werft/search/<lang>.json, and the script _werft/search.js; `ctx.search()`
// renders the search box that uses them. The visitor's browser loads the index on first use and
// searches it itself, so it works the same on every host.
import { html } from './html.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? m;
  try { return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))); } catch { return m; }
});
const textOf = (s) => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// The text a visitor reads on a rendered page: its <main> (else its <body>), without the head,
// scripts, styles, navigation and search boxes.
export function pageText(page) {
  let s = String(page).replace(/<!--[\s\S]*?-->/g, ' ');
  const part = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(s) ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(s);
  if (part) s = part[1];
  return textOf(s.replace(/<(head|title|script|style|noscript|template|svg|nav|search)\b[\s\S]*?<\/\1\s*>/gi, ' '));
}

// Collects the built pages of each language; `files()` returns the index files and the script.
// An entry with `seo.noindex` is left out, as in the sitemap. `sharePosts(lang, from, type)`: the
// language shows the posts of a type of the language `from` (the default), so its index lists them too.
export function searchIndex(theme, base = '') {
  const languages = new Map();
  const posts = new Map();
  const shared = [];
  const list = (map, lang) => (map.has(lang) ? map : map.set(lang, [])).get(lang);
  return {
    add(lang, entry, file, kind = 'page', type = '') {
      if (!theme.search || entry.seo?.noindex) return;
      const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(file.text) ?? /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(file.text);
      const title = entry.title || (heading && textOf(heading[1])) || entry.slug;
      const url = file.path.slice(base.length).replace(/(^|\/)index\.html$/, '$1');
      const item = { url, title, text: pageText(file.text) };
      list(languages, lang).push(item);
      if (kind === 'post') list(posts, `${lang}\0${type}`).push(item);
    },
    sharePosts: (lang, from, type = '') => shared.push([lang, `${from}\0${type}`]),
    files() {
      if (!theme.search) return [];
      for (const [lang, from] of shared) list(languages, lang).push(...(posts.get(from) ?? []));
      return [
        { path: `${base}_werft/search.js`, text: SCRIPT },
        ...[...languages].map(([lang, entries]) => ({ path: `${base}_werft/search/${lang}.json`, text: JSON.stringify({ lang, entries }) })),
      ];
    },
  };
}

// The search box for ctx.search(): `url` is the page's ctx.url. It stays hidden until the script
// runs, so a visitor without JavaScript sees no box that does nothing.
export function searchBox(url, lang, { label = 'Suche', placeholder = '', empty = 'Nichts gefunden.' } = {}) {
  return html`<search class="werft-search" hidden><form data-werft-search="${url(`_werft/search/${lang}.json`)}" data-empty="${empty}">
    <label><span>${label}</span> <input type="search" name="q" autocomplete="off" placeholder="${placeholder}"></label>
    <ul aria-live="polite"></ul></form></search><script src="${url('_werft/search.js')}" defer></script>`;
}

// The entries matching every word of the query, best first: a word in the title counts more than
// one in the text. Case and accents are ignored. Each result has a snippet around the first match.
export function find(entries, query, limit = 10) {
  const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  if (find.cache?.entries !== entries) find.cache = { entries, folded: entries.map((e) => ({ title: fold(e.title), text: fold(e.text) })) };
  const scored = [];
  find.cache.folded.forEach((f, i) => {
    let score = 0;
    for (const term of terms) {
      const inTitle = f.title.includes(term);
      if (!inTitle && !f.text.includes(term)) return;
      score += (inTitle ? 10 : 0) + Math.min(f.text.split(term).length - 1, 5);
    }
    scored.push({ i, score });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).slice(0, limit).map(({ i }) => {
    const { url, title, text } = entries[i];
    const words = text.split(' ');
    const at = Math.max(0, fold(text).split(' ').findIndex((w) => terms.some((t) => w.includes(t))));
    const start = Math.max(0, at - 8);
    const snippet = (start ? '\u2026 ' : '') + words.slice(start, start + 30).join(' ') + (start + 30 < words.length ? ' \u2026' : '');
    return { url, title, snippet };
  });
}

// The browser half, written to _werft/search.js as `(client)(find)`: binds every search box on the
// page, loads its index on first use and lists the results while the visitor types.
function client(find) {
  for (const form of document.querySelectorAll('form[data-werft-search]')) {
    if (form.werftSearch) continue;
    form.werftSearch = true;
    const input = form.querySelector('input');
    const list = form.querySelector('ul');
    // Against the page's <base> where it has one (the not-found page, shown at any address).
    const address = new URL(form.getAttribute('data-werft-search'), document.baseURI);
    const root = new URL('../../', address);
    let index;
    const load = () => (index ??= fetch(address).then((r) => (r.ok ? r.json() : { entries: [] })).catch(() => ({ entries: [] })));
    const show = async () => {
      const query = input.value;
      const { entries } = await load();
      if (input.value !== query) return;
      const items = find(entries, query).map((r) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        const snippet = document.createElement('p');
        // Always a path below the site's root: a slug such as "javascript:x" stays a file name.
        const href = new URL(`./${r.url}`, root);
        if (href.origin !== root.origin) return null;
        link.href = href.href;
        link.textContent = r.title;
        snippet.textContent = r.snippet;
        item.append(link, snippet);
        return item;
      }).filter(Boolean);
      if (!items.length && query.trim()) {
        items.push(document.createElement('li'));
        items[0].textContent = form.getAttribute('data-empty');
      }
      list.replaceChildren(...items);
    };
    input.addEventListener('focus', load);
    input.addEventListener('input', show);
    form.addEventListener('submit', (event) => { event.preventDefault(); show(); });
    form.parentElement.hidden = false;
    if (input.value) show();
  }
}

// ASCII only, so it reads the same whatever charset a host serves it with.
const SCRIPT = `// werft site search (lib/search.js)\n(${client})(${find});\n`;
