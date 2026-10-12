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

async function loadFolder(store, dir) {
  const paths = (await store.list(dir)).filter((p) => p.endsWith('.json'));
  const entries = await Promise.all(paths.map(async (p) => ({ ...JSON.parse(await store.readText(`${dir}/${p}`)), slug: slugOf(p) })));
  return entries.sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

async function loadFile(store, path, fallback) {
  try { return JSON.parse(await store.readText(path)); } catch (error) {
    if (error.code === 'ENOENT' || error.status === 404) return fallback;
    throw error;
  }
}

export async function loadContent({ site, theme, store }) {
  const dir = site.contentDir ?? 'content';
  const postType = theme.postType?.name;
  const [pages, posts, patterns, forms, settings, menus, redirects] = await Promise.all([
    loadFolder(store, `${dir}/pages`),
    postType ? loadFolder(store, `${dir}/${postType}`) : [],
    loadFolder(store, `${dir}/patterns`),
    loadFolder(store, `${dir}/forms`),
    loadFile(store, `${dir}/settings/site.json`, {}),
    loadFile(store, `${dir}/settings/menus.json`, {}),
    loadFile(store, `${dir}/settings/redirects.json`, { redirects: [] }),
  ]);
  return { pages, posts, patterns, forms, settings, menus, redirects: redirects.redirects ?? [] };
}

export const pageFile = (slug) => `${slug}.html`;
