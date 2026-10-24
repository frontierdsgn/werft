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
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;
export function siteLanguages(site = {}) {
  const list = site.languages ?? [];
  if (!Array.isArray(list) || list.some((l) => typeof l !== 'string' || !LANGUAGE.test(l)) || new Set(list).size !== list.length) {
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
    content.languages[lang] = { pages, posts: posts.length ? posts : null, patterns, forms, settings, menus };
  }
  return content;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// `over` laid over `base`: objects are merged key by key, anything else (text, lists) replaces.
export function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return structuredClone(over === undefined ? base : over);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(over)) out[key] = key in out ? deepMerge(out[key], value) : structuredClone(value);
  return out;
}

const same = (a, b) => (isObject(a) && isObject(b)
  ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => k in b && same(a[k], b[k]))
  : JSON.stringify(a) === JSON.stringify(b));

// The reverse of deepMerge for the editor: what of `value` differs from `base`, so that
// deepMerge(base, result) is `value` again. `kept` (the file as saved) keeps its keys and their
// order, so a file nobody changed stays as it is. A key `value` lacks and `base` has becomes null.
// `depth` 1 compares only the top-level values (menus are replaced per location).
export function differences(value, base, kept = null, depth = Infinity) {
  const out = {};
  for (const key of new Set([...Object.keys(kept ?? {}), ...Object.keys(value), ...Object.keys(base)])) {
    if (!(key in value)) { if (key in base) out[key] = null; continue; }
    const had = !!kept && key in kept;
    if (depth > 1 && isObject(value[key]) && isObject(base[key])) {
      const inner = differences(value[key], base[key], isObject(kept?.[key]) ? kept[key] : null, depth - 1);
      if (had || Object.keys(inner).length) out[key] = inner;
    } else if (had || !same(value[key], base[key])) out[key] = structuredClone(value[key]);
  }
  return out;
}

const bySlug = (base, own) => [...own, ...base.filter((e) => !own.some((o) => o.slug === e.slug))].sort((a, b) => (a.slug < b.slug ? -1 : 1));

// The content as one language shows it: its own pages; its posts, or the default language's when it
// has none; its patterns and forms, else the default language's of the same name; its site settings
// laid over the default ones; its menus, else the default menu of each location. `lang` is set,
// `source` keeps the content of every language. A site without languages is returned as it is.
export function localize(content, { site = {}, lang } = {}) {
  const languages = siteLanguages(site);
  if (content.lang || !languages.length) return content;
  const code = languages.includes(lang) ? lang : languages[0];
  const view = { ...content, lang: code, source: content };
  if (code === languages[0]) return { ...view, settings: { ...content.settings, lang: content.settings.lang ?? code } };
  const own = content.languages?.[code] ?? {};
  return {
    ...view,
    pages: own.pages ?? [],
    posts: own.posts ?? content.posts,
    patterns: bySlug(content.patterns, own.patterns ?? []),
    forms: bySlug(content.forms, own.forms ?? []),
    settings: { ...deepMerge(content.settings, own.settings ?? {}), lang: own.settings?.lang ?? code },
    menus: { ...content.menus, ...own.menus },
  };
}

export const pageFile = (slug) => `${slug}.html`;
