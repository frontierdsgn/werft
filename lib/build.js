// Isomorphic site build: runs in Node (CLI, host builds) and in the browser (admin preview).
// `store` abstracts file access: { list(dir) → relative paths, readText(path), readBytes(path) }.
import { html, raw, escape } from './html.js';
import { markdown, inline } from './markdown.js';
import { imageSize } from './image-size.js';
import { loadContent, isPublic, isScheduled, pageFile } from './content.js';

const IMAGE = /\.(jpe?g|png|gif|webp)$/i;

export async function indexMedia(store, dirs) {
  const index = {};
  for (const dir of dirs) {
    for (const rel of await store.list(dir)) {
      if (!IMAGE.test(rel)) continue;
      const path = `${dir}/${rel}`;
      const size = imageSize(await store.readBytes(path));
      if (size) index[path] = size;
    }
  }
  return index;
}

// Collects the block types used by a list of sections, following patterns.
function blockTypes(sections, patterns, seen = new Set()) {
  for (const section of sections ?? []) {
    if (section.type === 'pattern') {
      const pattern = patterns.find((p) => p.slug === section.pattern);
      if (pattern && !seen.has(`pattern:${pattern.slug}`)) {
        seen.add(`pattern:${pattern.slug}`);
        blockTypes(pattern.sections, patterns, seen);
      }
    } else seen.add(section.type);
  }
  return seen;
}

export function createContext({ site, theme, content, media = {}, now = new Date(), preview = false }) {
  const publicPosts = content.posts.filter((p) => isPublic(p, now));
  const base = {
    site, theme, content, now, preview,
    settings: content.settings,
    html, raw, escape, md: (s) => raw(markdown(s)), inline: (s) => raw(inline(s)),
    menu: (id) => ({ label: '', items: [], ...content.menus[id] }),
    form: (slug) => content.forms.find((f) => f.slug === slug),
    image: (src) => (src ? { src, ...media[src] } : undefined),
    exists: (path) => path in media,
    posts: ({ slugs, limit } = {}) => {
      const list = slugs?.length ? slugs.map((s) => publicPosts.find((p) => p.slug === s)).filter(Boolean) : publicPosts;
      return limit ? list.slice(0, limit) : list;
    },
    postUrl: (post) => theme.postType?.url?.(post),
  };
  const forEntry = (entry) => {
    const ctx = {
      ...base,
      page: entry,
      uses: (type) => blockTypes(entry.sections, content.patterns).has(type),
      blocks: (sections) => raw((sections ?? []).map((section) => {
        if (section.type === 'pattern') {
          const pattern = content.patterns.find((p) => p.slug === section.pattern);
          return pattern ? ctx.blocks(pattern.sections).value : '';
        }
        const block = theme.blocks[section.type];
        if (!block) throw new Error(`Unknown block type "${section.type}" on ${entry.slug}`);
        return block.render(section, ctx).value;
      }).join('')),
    };
    return ctx;
  };
  return { ...base, for: forEntry };
}

const redirectsFile = (list) => list.map((r) => `${r.from} ${r.to} ${r.status ?? 301}`).join('\n') + (list.length ? '\n' : '');
const htaccess = (list) => list.map((r) => `Redirect ${r.status ?? 301} ${r.from} ${r.to}`).join('\n') + (list.length ? '\n' : '');

function sitemap(baseURL, urls) {
  const items = urls.map((u) => `<url><loc>${escape(new URL(u, baseURL).href)}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</urlset>\n`;
}

// Returns { files: [{ path, text }], copies: [dir], schedule } without touching the file system.
export async function build({ site, theme, store, now = new Date(), media }) {
  const base = site.base ? `${site.base.replace(/\/+$/, '')}/` : '';
  const content = await loadContent({ site, theme, store });
  const mediaDirs = site.mediaDirs ?? [];
  media ??= await indexMedia(store, mediaDirs);
  const ctx = createContext({ site, theme, content, media, now });
  const files = [];
  const urls = [];
  for (const page of content.pages.filter((p) => isPublic(p, now))) {
    const path = pageFile(page.slug);
    files.push({ path: base + path, text: theme.renderPage(page, ctx.for(page)).value });
    if (!page.seo?.noindex) urls.push(base + (page.slug === 'index' ? '' : path));
  }
  if (theme.postType?.url && theme.renderPost) {
    for (const post of content.posts.filter((p) => isPublic(p, now))) {
      const path = theme.postType.url(post);
      if (!path) continue;
      files.push({ path: base + path, text: theme.renderPost(post, ctx.for(post)).value });
      urls.push(base + path);
    }
  }
  const indexable = content.settings.search_visibility !== 'noindex';
  const baseURL = content.settings.url;
  // robots.txt and sitemap.xml only work at the root of a host; a site below a base path leaves
  // them to the host.
  if (!base) files.push({ path: 'robots.txt', text: indexable ? `User-agent: *\nAllow: /\n${baseURL ? `Sitemap: ${new URL('sitemap.xml', baseURL).href}\n` : ''}` : 'User-agent: *\nDisallow: /\n' });
  if (!base && indexable && baseURL) files.push({ path: 'sitemap.xml', text: sitemap(baseURL, urls) });
  if (content.redirects.length) {
    files.push({ path: '_redirects', text: redirectsFile(content.redirects) });
    files.push({ path: '.htaccess', text: htaccess(content.redirects) });
  }
  const upcoming = [...content.pages, ...content.posts].filter((e) => isScheduled(e, now)).map((e) => Date.parse(e.publish_date));
  const schedule = { built_at: now.toISOString(), next_publish: upcoming.length ? new Date(Math.min(...upcoming)).toISOString() : null };
  files.push({ path: '_werft/build.json', text: JSON.stringify({ ...schedule, redirects: content.redirects }) });
  files.push({ path: '_werft/media.json', text: JSON.stringify(media) });
  // Directories copied unchanged into the site: the theme's static files (their contents) and the
  // media directories (as they are).
  const copies = [
    ...(theme.staticDir ? [{ from: theme.staticDir, to: base.replace(/\/$/, '') }] : []),
    ...mediaDirs.map((dir) => ({ from: dir, to: base + dir })),
  ];
  return { files, copies, schedule, content };
}
