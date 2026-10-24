// Content model shared by every werft site. Content lives as JSON files in the site's content
// directory; the theme decides how it looks.
//
//   content/pages/<slug>.json      pages, rendered to <slug>.html (index → index.html)
//   content/<posts>/<slug>.json    posts of the theme's post type (e.g. events)
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

export async function loadContent({ site, theme, store }) {
  const dir = site.contentDir ?? site.content ?? 'content';
  const postType = theme.postType?.name;
  const languages = siteLanguages(site);
  if (postType && languages.includes(postType)) throw new Error(`werft.config.js: the language "${postType}" has the name of the theme's post type.`);
  const revive = mediaPaths(site);
  const [pages, posts, patterns, forms, settings, menus, redirects] = await Promise.all([
    loadFolder(store, `${dir}/pages`, revive),
    postType ? loadFolder(store, `${dir}/${postType}`, revive) : [],
    loadFolder(store, `${dir}/patterns`, revive),
    loadFolder(store, `${dir}/forms`, revive),
    loadFile(store, `${dir}/settings/site.json`, {}, revive),
    loadFile(store, `${dir}/settings/menus.json`, {}, revive),
    loadFile(store, `${dir}/settings/redirects.json`, { redirects: [] }, revive),
  ]);
  const content = { pages, posts, patterns, forms, settings, menus, redirects: redirects.redirects ?? [] };
  if (!languages.length) return content;
  // Each other language's own files, as they are; localize() fills in from the default language.
  content.languages = {};
  for (const lang of languages.slice(1)) {
    const at = `${dir}/${lang}`;
    const [pages, posts, patterns, forms, settings, menus] = await Promise.all([
      loadFolder(store, `${at}/pages`, revive),
      postType ? loadFolder(store, `${at}/${postType}`, revive) : [],
      loadFolder(store, `${at}/patterns`, revive),
      loadFolder(store, `${at}/forms`, revive),
      loadFile(store, `${at}/settings/site.json`, {}, revive),
      loadFile(store, `${at}/settings/menus.json`, {}, revive),
    ]);
    content.languages[lang] = { pages, posts, patterns, forms, settings, menus };
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
export const ownPosts = (content, lang, now = new Date()) => {
  const posts = content.languages?.[lang]?.posts ?? [];
  return posts.some((p) => isPublic(p, now)) ? posts : null;
};

// The content as one language shows it: its own pages; its posts, or the default language's when it
// has none public (see ownPosts); its patterns and forms, else the default language's of the same name; its site settings
// laid over the default ones; its menus, else the default menu of each location. `lang` is set,
// `source` keeps the content of every language. A site without languages is returned as it is.
export function localize(content, { site = {}, lang, now = new Date() } = {}) {
  const languages = siteLanguages(site);
  if (content.lang || !languages.length) return content;
  const code = languages.includes(lang) ? lang : languages[0];
  const view = { ...content, lang: code, source: content };
  if (code === languages[0]) return { ...view, settings: { ...content.settings, lang: content.settings.lang ?? code } };
  const own = content.languages?.[code] ?? {};
  return {
    ...view,
    pages: own.pages ?? [],
    posts: ownPosts(content, code, now) ?? content.posts,
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
//   page(slug, lang), post(post, lang): { url, file, link } (`link`: what a link to it becomes),
//     post() also `key` (the theme's postType.url), null for a post without a page
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
  const post = (entry, lang) => {
    const path = theme.postType?.url?.(entry);
    if (typeof path !== 'string' || !path) return null;
    const prefix = prefixOf(languages, lang);
    const { url, file } = placeOf(path, style);
    return { url: prefix + url, file: prefix + file, link: prefix + (style === 'html' ? file : url), key: prefix + path };
  };
  // Links as the content writes them → where they lead.
  const map = new Map();
  const add = (key, to) => { if (!map.has(key)) map.set(key, to); };
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
    }
    for (const entry of (isDefault(lang) ? every.posts : ownPosts(every, lang, now)) ?? []) {
      const at = post(entry, lang);
      if (at) add(at.key, at.link);
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
    for (const origin of [file, from]) {
      const path = resolve(origin, name);
      if (path === null || !map.has(path)) continue;
      // A link that leads to the page from where it is stays as it is written.
      return origin === file && map.get(path) === path ? href : relativePath(file, map.get(path)) + rest;
    }
    return href;
  };
  // The slugs of a page's parent pages, the topmost first.
  const ancestors = (slug) => chain(slug).split('/').slice(0, -1);
  return { style, page, post, target, link, ancestors };
}

// A site path as seen from the file `from`: "../kontakt/" for kontakt/ from en/index.html.
export function relativePath(from, path) {
  const dirs = from.split('/').slice(0, -1);
  const parts = path.split('/');
  let i = 0;
  while (i < dirs.length && i < parts.length - 1 && dirs[i] === parts[i]) i++;
  return '../'.repeat(dirs.length - i) + parts.slice(i).join('/') || './';
}
