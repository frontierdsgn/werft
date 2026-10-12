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

export const STATUSES = ['draft', 'pending', 'published'];

export const isPublic = (entry, now = new Date()) =>
  (entry.status ?? 'published') === 'published' &&
  (!entry.publish_date || Date.parse(entry.publish_date) <= now.getTime());

export const isScheduled = (entry, now = new Date()) =>
  (entry.status ?? 'published') === 'published' && !!entry.publish_date && Date.parse(entry.publish_date) > now.getTime();

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

export async function loadContent({ site, theme, store }) {
  const dir = site.contentDir ?? site.content ?? 'content';
  const postType = theme.postType?.name;
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
  return { pages, posts, patterns, forms, settings, menus, redirects: redirects.redirects ?? [] };
}

export const pageFile = (slug) => `${slug}.html`;
