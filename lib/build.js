// Isomorphic site build: runs in Node (CLI, host builds) and in the browser (admin preview).
// `store` abstracts file access: { list(dir) → relative paths, readText(path), readBytes(path) }.
import { html, raw, escape } from './html.js';
import { markdown, inline } from './markdown.js';
import { imageSize } from './image-size.js';
import { loadContent, localize, siteLanguages, isPublic, isScheduled, pageFile, sortPosts } from './content.js';

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

// A site-root-relative path ("assets/css/site.css", "en/kontakt.html", "" for the home page) as
// seen from the file `from` ("en/index.html"): "../assets/css/site.css". Addresses with a scheme,
// starting with "/", "#" or "?", are returned as they are.
export function relativeURL(from, path) {
  const value = String(path ?? '');
  if (/^([a-z][a-z0-9+.-]*:|[/#?])/i.test(value)) return value;
  const cut = value.search(/[?#]/);
  const [file, rest] = cut < 0 ? [value, ''] : [value.slice(0, cut), value.slice(cut)];
  const dirs = from.split('/').slice(0, -1);
  const parts = file.split('/');
  let i = 0;
  while (i < dirs.length && i < parts.length - 1 && dirs[i] === parts[i]) i++;
  return ('../'.repeat(dirs.length - i) + parts.slice(i).join('/') || './') + rest;
}

// Where a language's pages go: the default language at the root, the others below <lang>/.
const prefixOf = (languages, lang) => (languages.length && lang && lang !== languages[0] ? `${lang}/` : '');
const pagePath = (slug) => (slug === 'index' ? '' : pageFile(slug));

// `content` is the site's content (loadContent) or one language of it (localize); `lang` picks the
// language of the first.
export function createContext({ site, theme, content: given, media = {}, now = new Date(), preview = false, lang }) {
  const languages = siteLanguages(site);
  const content = localize(given, { site, lang });
  const code = content.lang ?? content.settings?.lang ?? 'de';
  const prefix = prefixOf(languages, code);
  const mediaDirs = site.mediaDirs ?? [];
  const publicPosts = sortPosts(content.posts.filter((p) => isPublic(p, now)), theme.postType?.date);
  const base = {
    site, theme, content, now, preview,
    lang: code, languages,
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
  // The entry's counterpart in each language, for a language switcher: same slug, published (or
  // shown in the editor's preview); else that language's home page.
  const every = content.source ?? content;
  const shown = (entry) => entry && (preview || isPublic(entry, now));
  const translations = (entry, kind, file) => languages.map((other) => {
    const own = other === languages[0] ? every : every.languages?.[other] ?? {};
    const list = kind === 'post' ? own.posts ?? every.posts : own.pages ?? [];
    const match = shown(list.find((e) => e.slug === entry.slug));
    const target = match && (kind === 'post' ? theme.postType?.url?.(match) : pagePath(entry.slug));
    const exists = typeof target === 'string';
    return { lang: other, url: relativeURL(file, prefixOf(languages, other) + (exists ? target : '')), current: other === code, exists };
  });
  // kind: 'page' or 'post'; a post is an entry of the content's posts that is not a page.
  const forEntry = (entry, kind = content.posts.includes(entry) && !content.pages.includes(entry) ? 'post' : 'page') => {
    const file = prefix + (kind === 'post' ? theme.postType?.url?.(entry) ?? '' : pageFile(entry.slug));
    const url = (path) => relativeURL(file, path);
    // Media named in Markdown are relative to the site's root, like every value in the content; on
    // the pages of a language below <lang>/ they are made relative to the page.
    const relativeMedia = (out) => (prefix ? out.replace(/ (src|href)="([^"]*)"/g, (m, name, value) => (mediaDirs.some((d) => value.startsWith(`${d}/`)) ? ` ${name}="${url(value)}"` : m)) : out);
    const ctx = {
      ...base,
      page: entry,
      url,
      translations: translations(entry, kind, file),
      md: (s) => raw(relativeMedia(markdown(s))),
      inline: (s) => raw(relativeMedia(inline(s))),
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
// Apache knows no splats: a rule with * becomes a RedirectMatch whose group takes the place of :splat.
const htaccessLine = ({ from, to, status = 301 }) => {
  if (!from.includes('*')) return `Redirect ${status} ${from} ${to}`;
  const pattern = from.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('(.*)');
  return `RedirectMatch ${status} ^${pattern}$ ${to.replace(':splat', '$1')}`;
};
const htaccess = (list) => list.map(htaccessLine).join('\n') + (list.length ? '\n' : '');

// urls: [{ loc, alternates?: [{ lang, loc }] }]; alternates only for a site in several languages.
function sitemap(baseURL, urls, languages) {
  const href = (u) => escape(new URL(u, baseURL).href);
  const items = urls.map((u) => `<url><loc>${href(u.loc)}</loc>${(u.alternates ?? []).map((a) => `<xhtml:link rel="alternate" hreflang="${escape(a.lang)}" href="${href(a.loc)}"/>`).join('')}</url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${languages.length ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>${items}</urlset>\n`;
}

// Returns { files: [{ path, text }], copies: [dir], schedule } without touching the file system.
export async function build({ site, theme, store, now = new Date(), media }) {
  const base = site.base ? `${site.base.replace(/\/+$/, '')}/` : '';
  const content = await loadContent({ site, theme, store });
  const languages = siteLanguages(site);
  const mediaDirs = site.mediaDirs ?? [];
  media ??= await indexMedia(store, mediaDirs);
  const files = [];
  const urls = [];
  // Each language in turn, the default first; a site without languages is built once.
  for (const lang of languages.length ? languages : [undefined]) {
    const local = localize(content, { site, lang });
    const prefix = base + prefixOf(languages, lang);
    const ctx = createContext({ site, theme, content: local, media, now });
    for (const page of local.pages.filter((p) => isPublic(p, now))) {
      const path = pageFile(page.slug);
      files.push({ path: prefix + path, text: theme.renderPage(page, ctx.for(page, 'page')).value });
      if (!page.seo?.noindex) urls.push({ loc: prefix + (page.slug === 'index' ? '' : path), key: `page:${page.slug}`, lang });
    }
    if (theme.postType?.url && theme.renderPost) {
      for (const post of local.posts.filter((p) => isPublic(p, now))) {
        const path = theme.postType.url(post);
        if (!path) continue;
        files.push({ path: prefix + path, text: theme.renderPost(post, ctx.for(post, 'post')).value });
        urls.push({ loc: prefix + path, key: `post:${post.slug}`, lang });
      }
    }
  }
  // Pages in several languages name each other in the sitemap.
  if (languages.length) {
    for (const u of urls) {
      const versions = urls.filter((v) => v.key === u.key);
      if (versions.length > 1) u.alternates = versions.map((v) => ({ lang: v.lang, loc: v.loc }));
    }
  }
  const indexable = content.settings.search_visibility !== 'noindex';
  const baseURL = content.settings.url;
  // robots.txt and sitemap.xml only work at the root of a host; a site below a base path leaves
  // them to the host.
  if (!base) files.push({ path: 'robots.txt', text: indexable ? `User-agent: *\nAllow: /\n${baseURL ? `Sitemap: ${new URL('sitemap.xml', baseURL).href}\n` : ''}` : 'User-agent: *\nDisallow: /\n' });
  if (!base && indexable && baseURL) files.push({ path: 'sitemap.xml', text: sitemap(baseURL, urls, languages) });
  if (content.redirects.length) {
    files.push({ path: '_redirects', text: redirectsFile(content.redirects) });
    files.push({ path: '.htaccess', text: htaccess(content.redirects) });
  }
  const entries = [content, ...Object.values(content.languages ?? {})].flatMap((c) => [...c.pages, ...(c.posts ?? [])]);
  const upcoming = entries.filter((e) => isScheduled(e, now)).map((e) => Date.parse(e.publish_date));
  const schedule = { built_at: now.toISOString(), next_publish: upcoming.length ? new Date(Math.min(...upcoming)).toISOString() : null };
  files.push({ path: `${base}_werft/build.json`, text: JSON.stringify({ ...schedule, redirects: content.redirects }) });
  files.push({ path: `${base}_werft/media.json`, text: JSON.stringify(media) });
  // Directories copied unchanged into the site: the theme's static files (their contents) and the
  // media directories (as they are).
  const copies = [
    ...(theme.staticDir ? [{ from: theme.staticDir, to: base.replace(/\/$/, '') }] : []),
    ...mediaDirs.map((dir) => ({ from: dir, to: base + dir })),
  ];
  return { files, copies, schedule, content };
}
