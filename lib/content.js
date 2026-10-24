// Content model shared by every werft site. Content lives as JSON files in the site's content
// directory; the theme decides how it looks.
//
//   content/pages/<slug>.json      pages, rendered to <slug>.html (index → index.html)
//   content/<posts>/<slug>.json    posts of each of the theme's post types (e.g. events)
//   content/<taxonomy>/<slug>.json terms of the theme's taxonomies (e.g. categories)
//   content/patterns/<id>.json     synced patterns: sections reused on several pages
//   content/forms/<id>.json        form definitions
//   content/settings/site.json     site settings (core fields + theme fields)
//   content/settings/menus.json    one entry per menu location the theme declares
//   content/settings/redirects.json
//
// A site in several languages (`languages: ['de', 'en']` in werft.config.js, the first is the
// default) keeps the default language's content there and each other language's in content/<lang>/,
// laid out the same way (pages, patterns, forms, posts, settings/site.json, settings/menus.json).
// Redirects and media are shared.

export const STATUSES = ['draft', 'pending', 'published'];

export const isPublic = (entry, now = new Date()) =>
  (entry.status ?? 'published') === 'published' &&
  (!entry.publish_date || Date.parse(entry.publish_date) <= now.getTime());

export const isScheduled = (entry, now = new Date()) =>
  (entry.status ?? 'published') === 'published' && !!entry.publish_date && Date.parse(entry.publish_date) > now.getTime();

// The date of a post as a timestamp, NaN without one. The date is the field the theme names in
// `postType.date`, else `publish_date`. Dates are stored as ISO strings ("2026-11-14"); the German
// "14.11.2026" that werft 0.1.0 stored is read too.
export function postDate(entry, field = 'publish_date') {
  const value = entry[field];
  if (typeof value !== 'string' || !value) return NaN;
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
  return german ? Date.UTC(+german[3], german[2] - 1, +german[1]) : Date.parse(value);
}

// Newest first; posts without a date follow, by slug.
export function sortPosts(posts, field) {
  const keyed = posts.map((post) => ({ post, time: postDate(post, field) }));
  return keyed.sort((a, b) => {
    const [x, y] = [Number.isNaN(a.time), Number.isNaN(b.time)];
    if (x !== y) return x ? 1 : -1;
    if (!x && a.time !== b.time) return b.time - a.time;
    return a.post.slug < b.post.slug ? -1 : a.post.slug > b.post.slug ? 1 : 0;
  }).map((k) => k.post);
}

const slugOf = (path) => path.split('/').pop().replace(/\.json$/, '');

// A JSON.parse reviver. The admin stores a picked file as its address on the site
// ("/classic/assets/img/a.jpg"), other content holds it relative to the site ("assets/img/a.jpg").
// Pages are written at the site's base, so themes always get the relative form.
export function mediaPaths(site) {
  const root = site.base ? `/${site.base.replace(/^\/+|\/+$/g, '')}/` : '/';
  const prefixes = (site.mediaDirs ?? []).map((dir) => `${root}${dir}/`);
  return (key, value) => (typeof value === 'string' && prefixes.some((p) => value.startsWith(p)) ? value.slice(root.length) : value);
}

async function loadFolder(store, dir, revive) {
  const paths = (await store.list(dir)).filter((p) => p.endsWith('.json'));
  const entries = await Promise.all(paths.map(async (p) => ({ ...JSON.parse(await store.readText(`${dir}/${p}`), revive), slug: slugOf(p) })));
  return entries.sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

async function loadFile(store, path, fallback, revive) {
  try { return JSON.parse(await store.readText(path), revive); } catch (error) {
    if (error.code === 'ENOENT' || error.status === 404) return fallback;
    throw error;
  }
}

// The languages werft.config.js declares, the default first; empty for a site in one language.
// Codes differing only in case name the same language (and one folder on many file systems).
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
export function siteLanguages(site = {}) {
  const list = site.languages ?? [];
  if (!Array.isArray(list) || list.some((l) => typeof l !== 'string' || !LANGUAGE.test(l)) || new Set(list.map((l) => l.toLowerCase())).size !== list.length) {
    throw new Error(`werft.config.js: languages must list distinct language codes, the default first, e.g. ['de', 'en'] (got ${JSON.stringify(list)}).`);
  }
  return list;
}

// The content directory of a language: the default language's is the content directory itself.
export const languageDir = (contentDir, languages, lang) => (languages.includes(lang) && lang !== languages[0] ? `${contentDir}/${lang}` : contentDir);

// The theme's post types: `postTypes` (a list), or the one `postType` of earlier themes.
// The first is the one `posts` and ctx.posts() mean without a type.
export function postTypesOf(theme = {}) {
  if (theme.postTypes && theme.postType) throw new Error('theme: give either postType or postTypes, not both.');
  return theme.postTypes ?? (theme.postType ? [theme.postType] : []);
}
// The theme's taxonomies ({ name, label, singular, url }), e.g. categories of posts.
export const taxonomiesOf = (theme = {}) => theme.taxonomies ?? [];

// Folder names in the content directory that are not a post type's or a taxonomy's.
const OWN_FOLDERS = ['pages', 'patterns', 'forms', 'settings'];

// The posts of each type and the terms of each taxonomy in the content directory `dir`.
async function loadEntries(store, dir, theme, revive) {
  const types = Object.fromEntries(await Promise.all(postTypesOf(theme).map(async (t) => [t.name, await loadFolder(store, `${dir}/${t.name}`, revive)])));
  const terms = Object.fromEntries(await Promise.all(taxonomiesOf(theme).map(async (t) => [t.name, await loadFolder(store, `${dir}/${t.name}`, revive)])));
  const first = postTypesOf(theme)[0]?.name;
  return { posts: first ? types[first] : [], types, terms };
}

export async function loadContent({ site, theme, store }) {
  const dir = site.contentDir ?? site.content ?? 'content';
  const languages = siteLanguages(site);
  const names = [...postTypesOf(theme), ...taxonomiesOf(theme)].map((t) => t?.name);
  for (const name of names) if (languages.includes(name)) throw new Error(`werft.config.js: the language "${name}" has the name of one of the theme's post types or taxonomies.`);
  // The names in postTypes and taxonomies (a theme's one postType keeps the name it had).
  for (const name of [...(theme.postTypes ?? []), ...taxonomiesOf(theme)].map((t) => t?.name)) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`theme: a post type or taxonomy needs a name of lower-case letters, digits, - and _ (got ${JSON.stringify(name)}).`);
    if (OWN_FOLDERS.includes(name) || names.indexOf(name) !== names.lastIndexOf(name)) throw new Error(`theme: the name "${name}" is taken; post types and taxonomies need names of their own, other than ${OWN_FOLDERS.join(', ')}.`);
  }
  const revive = mediaPaths(site);
  const [pages, entries, patterns, forms, settings, menus, redirects] = await Promise.all([
    loadFolder(store, `${dir}/pages`, revive),
    loadEntries(store, dir, theme, revive),
    loadFolder(store, `${dir}/patterns`, revive),
    loadFolder(store, `${dir}/forms`, revive),
    loadFile(store, `${dir}/settings/site.json`, {}, revive),
    loadFile(store, `${dir}/settings/menus.json`, {}, revive),
    loadFile(store, `${dir}/settings/redirects.json`, { redirects: [] }, revive),
  ]);
  const content = { pages, ...entries, patterns, forms, settings, menus, redirects: redirects.redirects ?? [] };
  if (!languages.length) return content;
  // Each other language's own files, as they are; localize() fills in from the default language.
  content.languages = {};
  for (const lang of languages.slice(1)) {
    const at = `${dir}/${lang}`;
    const [pages, entries, patterns, forms, settings, menus] = await Promise.all([
      loadFolder(store, `${at}/pages`, revive),
      loadEntries(store, at, theme, revive),
      loadFolder(store, `${at}/patterns`, revive),
      loadFolder(store, `${at}/forms`, revive),
      loadFile(store, `${at}/settings/site.json`, {}, revive),
      loadFile(store, `${at}/settings/menus.json`, {}, revive),
    ]);
    content.languages[lang] = { pages, ...entries, patterns, forms, settings, menus };
  }
  return content;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Keys that would reach an object's prototype instead of the object.
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
const keysOf = (object) => Object.keys(object ?? {}).filter((key) => !UNSAFE.has(key));

// `over` laid over `base`: objects are merged key by key, anything else (text, lists) replaces; a
// key set to null in `over` is removed.
export function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return structuredClone(over === undefined ? base : over);
  const out = {};
  for (const key of keysOf(base)) out[key] = structuredClone(base[key]);
  for (const key of keysOf(over)) {
    if (over[key] === null) delete out[key];
    else out[key] = Object.hasOwn(out, key) ? deepMerge(out[key], over[key]) : structuredClone(over[key]);
  }
  return out;
}

const same = (a, b) => (isObject(a) && isObject(b)
  ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
  : JSON.stringify(a) === JSON.stringify(b));

// The reverse of deepMerge for the editor: what of `value` differs from `base`, so that
// deepMerge(base, result) is `value` again. `kept` (the file as saved) keeps its keys and their
// order, so a file nobody changed stays as it is. A key `value` lacks and `base` has becomes null,
// which removes it. `depth` 1 compares only the top-level values (menus are replaced per location).
export function differences(value, base, kept = null, depth = Infinity) {
  const out = {};
  for (const key of new Set([...keysOf(kept), ...keysOf(value), ...keysOf(base)])) {
    if (!Object.hasOwn(value, key)) { if (Object.hasOwn(base, key)) out[key] = null; continue; }
    const had = !!kept && Object.hasOwn(kept, key);
    if (depth > 1 && isObject(value[key]) && isObject(base[key])) {
      const inner = differences(value[key], base[key], isObject(kept?.[key]) ? kept[key] : null, depth - 1);
      if (had || Object.keys(inner).length) out[key] = inner;
    } else if (had || !same(value[key], base[key])) out[key] = structuredClone(value[key]);
  }
  return out;
}

const bySlug = (base, own) => [...own, ...base.filter((e) => !own.some((o) => o.slug === e.slug))].sort((a, b) => (a.slug < b.slug ? -1 : 1));

// The posts of a language other than the default, once one of them is public (published and due);
// until then, null: the language shows the default language's posts, so a draft or a scheduled
// first post changes nothing on the public site.
// `type` names a post type (default: the first, `posts`), `first` the theme's first.
export const ownPosts = (content, lang, now = new Date(), type, first) => {
  const own = content.languages?.[lang];
  const posts = own ? (type ? postsOf(own, type, first) : own.posts ?? []) : [];
  return posts.some((p) => isPublic(p, now)) ? posts : null;
};
// The posts of a type in the content (one language of it, or loadContent's): the first type's are
// `posts`. Content without `types` (made by hand) holds only the first type's (`first`, the theme's
// first type; without it `type` is taken for the first).
export const postsOf = (content, type, first = type) => content.types?.[type] ?? (!content.types && (!type || type === first) ? content.posts ?? [] : []);

// The slugs of a post's terms of a taxonomy, from its type's fields.terms() fields.
export const termsOfPost = (type, post, taxonomy) => (type?.fields ?? []).filter((f) => f.taxonomy === taxonomy)
  .flatMap((f) => (Array.isArray(post?.[f.name]) ? post[f.name] : [])).filter((slug) => typeof slug === 'string');

// The content as one language shows it: its own pages; its posts of each type, or the default
// language's when it has none public (see ownPosts); its patterns, forms and terms, else the default
// language's of the same name; its site settings
// laid over the default ones; its menus, else the default menu of each location. `lang` is set,
// `source` keeps the content of every language. A site without languages is returned as it is.
export function localize(content, { site = {}, lang, now = new Date() } = {}) {
  const languages = siteLanguages(site);
  if (content.lang || !languages.length) return content;
  const code = languages.includes(lang) ? lang : languages[0];
  const view = { ...content, lang: code, source: content };
  if (code === languages[0]) return { ...view, settings: { ...content.settings, lang: content.settings.lang ?? code } };
  const own = content.languages?.[code] ?? {};
  const types = Object.fromEntries(Object.entries(content.types ?? {}).map(([type, posts]) => [type, ownPosts(content, code, now, type) ?? posts]));
  return {
    ...view,
    pages: own.pages ?? [],
    posts: ownPosts(content, code, now) ?? content.posts,
    ...(content.types && { types }),
    ...(content.terms && { terms: Object.fromEntries(Object.entries(content.terms).map(([tax, terms]) => [tax, bySlug(terms, own.terms?.[tax] ?? [])])) }),
    patterns: bySlug(content.patterns, own.patterns ?? []),
    forms: bySlug(content.forms, own.forms ?? []),
    settings: { ...deepMerge(content.settings, own.settings ?? {}), lang: own.settings?.lang ?? code },
    menus: { ...content.menus, ...own.menus },
  };
}

// How a page is named in links in the content and menus: "kontakt.html" ("index.html" for the home
// page), whatever its address; the build leads such a link to the page's address.
export const pageFile = (slug) => `${slug}.html`;

// werft.config.js `urls`: clean addresses by default (the page "kontakt" at kontakt/, in the file
// kontakt/index.html); 'html' keeps the addresses of werft 0.6 (kontakt.html).
export function urlStyle(site = {}) {
  const urls = site.urls ?? 'clean';
  if (urls !== 'clean' && urls !== 'html') throw new Error(`werft.config.js: urls must be 'clean' or 'html' (got ${JSON.stringify(urls)}).`);
  return urls;
}

// Where an address in werft 0.6's form ("kontakt.html", "index.html", "termine/fest.html", a folder
// "termine/") goes: { url, file }. Clean addresses turn a page file into a folder ("kontakt/" in
// kontakt/index.html); 404.html stays, since hosts look for that file.
export function placeOf(path, style) {
  if (path === '' || path.endsWith('/')) return { url: path, file: `${path}index.html` };
  if (/(^|\/)index\.html$/.test(path)) return { url: path.slice(0, -'index.html'.length), file: path };
  if (style === 'html' || !path.endsWith('.html') || /(^|\/)404\.html$/.test(path)) return { url: path, file: path };
  const url = `${path.slice(0, -'.html'.length)}/`;
  return { url, file: `${url}index.html` };
}

// Where a language's files go: the default language at the root, the others below <lang>/.
export const prefixOf = (languages, lang) => (languages.length && lang && lang !== languages[0] ? `${lang}/` : '');

// The home page and the not-found page stay at the top of their language: they have no parent and
// are no parent.
const TOP = new Set(['index', '404']);

// The addresses of a site's pages and posts, as site paths (no base, with the language's folder).
// A page names its parent page's slug in `parent`; its address is its parents' slugs and its own
// ("tagen/preise/"). The default language's page gives every language's version its place, so a
// page has the same address in each. `content` is loadContent's (or one language of it).
//   page(slug, lang), post(post, lang, type), term(term, lang, taxonomy): { url, file, link } (`link`:
//     what a link to it becomes); post() and term() also `key` (the theme's url in werft 0.6's
//     form), null for a post without a page (type: a post type's name, default the first)
//   paged(place, number): the address of a listing's further page
//   hasTerm(lang, taxonomy, slug): whether the language shows a post with the term
//   ancestors(slug): the slugs of the page's parents, the topmost first
//   target(path): a site path, with a page named as in the content ("kontakt.html",
//     "en/kontakt.html") turned into its address
//   link(href, file, from): a link on the page in `file` that names a page as the content does,
//     relative to `from` (the language's folder, or the post's address in the theme's form) or to
//     the page itself, leads to its address. In a language other than the default, a link to a page
//     it does not have (or has not published) leads to the default language's.
export function siteAddresses({ site = {}, theme = {}, content, preview = false, now = new Date() }) {
  const style = urlStyle(site);
  const languages = siteLanguages(site);
  const every = content.source ?? content;
  const isDefault = (lang) => !prefixOf(languages, lang);
  const ownOf = (lang) => (isDefault(lang) ? every : every.languages?.[lang] ?? {});
  const parents = new Map();
  for (const lang of languages.slice(1)) for (const p of every.languages?.[lang]?.pages ?? []) parents.set(p.slug, p.parent);
  for (const p of every.pages ?? []) parents.set(p.slug, p.parent);
  const chain = (slug) => {
    const out = [slug];
    if (TOP.has(slug)) return slug;
    for (let at = parents.get(slug); typeof at === 'string' && parents.has(at) && !TOP.has(at) && !out.includes(at); at = parents.get(at)) out.unshift(at);
    return out.join('/');
  };
  const page = (slug, lang) => {
    const prefix = prefixOf(languages, lang);
    if (slug === 'index') return { url: prefix, file: `${prefix}index.html`, link: style === 'html' ? `${prefix}index.html` : prefix };
    const { url, file } = placeOf(`${chain(slug)}.html`, style);
    return { url: prefix + url, file: prefix + file, link: prefix + (style === 'html' ? file : url) };
  };
  const types = postTypesOf(theme);
  const at = (path, lang) => {
    if (typeof path !== 'string' || !path) return null;
    const prefix = prefixOf(languages, lang);
    const { url, file } = placeOf(path, style);
    return { url: prefix + url, file: prefix + file, link: prefix + (style === 'html' ? file : url), key: prefix + path };
  };
  const first = types[0]?.name;
  const post = (entry, lang, type = first) => at(types.find((t) => t.name === type)?.url?.(entry), lang);
  // The posts of a type a language shows: its own once one is public, else the default language's.
  const postsIn = (lang, type) => (isDefault(lang) ? postsOf(every, type, first) : ownPosts(every, lang, now, type, first) ?? postsOf(every, type, first));
  // A term's listing page: the taxonomy's `url(term)`, else <taxonomy>/<slug>.html in werft 0.6's form.
  const term = (entry, lang, taxonomy) => {
    const definition = taxonomiesOf(theme).find((t) => t.name === taxonomy);
    return definition ? at(definition.url?.(entry) ?? `${taxonomy}/${entry.slug}.html`, lang) : null;
  };
  // Whether a language shows a post with the term: only then does the term get a listing page there.
  const hasTerm = (lang, taxonomy, slug) => types.some((t) => postsIn(lang, t.name).some((p) => shown(p) && termsOfPost(t, p, taxonomy).includes(slug)));
  // Links as the content writes them → where they lead.
  const map = new Map();
  const add = (key, to) => { if (!map.has(key)) map.set(key, to); };
  // The addresses and files of the pages and posts each language shows.
  const built = new Set();
  const builds = (at) => { built.add(at.url); built.add(at.file); };
  const shown = (entry) => !!entry && (preview || isPublic(entry, now));
  for (const lang of languages.length ? languages : [undefined]) {
    const own = ownOf(lang);
    const prefix = prefixOf(languages, lang);
    const slugs = new Set([...(own.pages ?? []), ...(isDefault(lang) ? [] : every.pages ?? [])].map((p) => p.slug));
    for (const slug of slugs) {
      const mine = own.pages?.find((p) => p.slug === slug);
      const theirs = isDefault(lang) ? null : every.pages.find((p) => p.slug === slug);
      if (!shown(mine) && shown(theirs)) {
        const original = page(slug);
        add(`${prefix}${pageFile(slug)}`, slug === 'index' ? original.url : original.link);
        if (slug === 'index') add(prefix, original.url);
      } else if (mine) add(`${prefix}${pageFile(slug)}`, page(slug, lang).link);
      if (shown(mine)) builds(page(slug, lang));
    }
    for (const { name } of types) {
      for (const entry of (isDefault(lang) ? postsOf(every, name, first) : ownPosts(every, lang, now, name, first)) ?? []) {
        const place = post(entry, lang, name);
        if (place) add(place.key, place.link);
        if (place && shown(entry)) builds(place);
      }
    }
    for (const [taxonomy, terms] of Object.entries(every.terms ?? {})) {
      for (const entry of bySlug(terms, own.terms?.[taxonomy] ?? [])) {
        const place = term(entry, lang, taxonomy);
        if (place) add(place.key, place.link);
        if (place && hasTerm(lang, taxonomy, entry.slug)) builds(place);
      }
    }
  }
  const target = (path) => {
    const value = String(path ?? '');
    const cut = value.search(/[?#]/);
    const [name, rest] = cut < 0 ? [value, ''] : [value.slice(0, cut), value.slice(cut)];
    return map.has(name) ? map.get(name) + rest : value;
  };
  // The site path `name` names from the file `origin`, null above the root.
  const resolve = (origin, name) => {
    const parts = origin.split('/').slice(0, -1);
    for (const part of name.split('/')) {
      if (part === '..') { if (!parts.length) return null; parts.pop(); } else if (part !== '.') parts.push(part);
    }
    return parts.join('/');
  };
  const link = (href, file, from = file) => {
    if (/^([a-z][a-z0-9+.-]*:|[/\\#?])/i.test(href)) return href;
    const cut = href.search(/[?#]/);
    const [name, rest] = cut < 0 ? [href, ''] : [href.slice(0, cut), href.slice(cut)];
    if (!name) return href;
    const here = resolve(file, name);
    // An address (kontakt/, ./) that leads to a page from where it is stays as it is written.
    if (!name.endsWith('.html')) return here !== null && !built.has(here) && map.has(here) ? relativePath(file, map.get(here)) + rest : href;
    // A page named as in the content ("kontakt.html") is read from the page, then from the
    // language's folder; one that leads to the page from where it is stays as it is written.
    for (const origin of [file, from]) {
      const path = resolve(origin, name);
      if (path === null || !map.has(path)) continue;
      return origin === file && map.get(path) === path ? href : relativePath(file, map.get(path)) + rest;
    }
    return href;
  };
  // The slugs of a page's parent pages, the topmost first.
  const ancestors = (slug) => chain(slug).split('/').slice(0, -1);
  // The `number`th page (from 2) of a listing at `place` (page() or term()): <address><number>/,
  // with werft 0.6's addresses <file without .html>/<number>.html.
  const paged = (place, number) => {
    if (number <= 1) return place;
    if (style === 'html') { const file = `${place.file.replace(/\.html$/, '')}/${number}.html`; return { url: file, file, link: file }; }
    const url = `${place.url}${number}/`;
    return { url, file: `${url}index.html`, link: url };
  };
  return { style, page, post, term, hasTerm, paged, target, link, ancestors };
}

// A site path as seen from the file `from`: "../kontakt/" for kontakt/ from en/index.html.
export function relativePath(from, path) {
  const dirs = from.split('/').slice(0, -1);
  const parts = path.split('/');
  let i = 0;
  while (i < dirs.length && i < parts.length - 1 && dirs[i] === parts[i]) i++;
  return '../'.repeat(dirs.length - i) + parts.slice(i).join('/') || './';
}
