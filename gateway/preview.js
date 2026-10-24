// Preview links: one page or post, as it is saved on the branch, rendered with the site's theme for
// someone without an account. The gateway checks the link (signed, expiring, listed until revoked,
// see core.js); this module only finds the entry and renders it the way the build does, with a
// draft or scheduled entry shown as published.
import { loadContent, siteLanguages } from '../lib/content.js';
import { createContext } from '../lib/build.js';

const escapeAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// What a content path is: { kind: 'page' | 'post', slug, lang }, or null for anything else.
export function previewTarget(path, { contentDir = 'content', postType, languages = [] }) {
  const lang = languages.slice(1).find((l) => path.startsWith(`${contentDir}/${l}/`));
  const rest = path.slice(contentDir.length + 1 + (lang ? lang.length + 1 : 0));
  if (!path.startsWith(`${contentDir}/`)) return null;
  const match = /^([^/]+)\/([^/]+)\.json$/.exec(rest);
  if (!match) return null;
  const kind = match[1] === 'pages' ? 'page' : postType && match[1] === postType ? 'post' : null;
  return kind && { kind, slug: match[2], lang };
}

// The entry's page as HTML, or null when the entry is gone. files: the content directory's tree
// entries; read(paths) → texts.
export async function renderPreview({ site, theme, target, files, read, now = new Date() }) {
  const texts = new Map((await read(files.map((f) => f.path))).map((text, i) => [files[i].path, text]));
  const store = {
    list: async (dir) => files.filter((f) => f.path.startsWith(`${dir}/`)).map((f) => f.path.slice(dir.length + 1)),
    readText: async (p) => { if (texts.get(p) == null) throw Object.assign(new Error(p), { status: 404 }); return texts.get(p); },
  };
  const content = await loadContent({ site, theme, store });
  const own = target.lang ? content.languages?.[target.lang] : content;
  const list = target.kind === 'post' ? own?.posts : own?.pages;
  const entry = list?.find((e) => e.slug === target.slug);
  if (!entry) return null;
  list.splice(list.indexOf(entry), 1, { ...entry, status: 'published', publish_date: undefined });
  const ctx = createContext({ site, theme, content, lang: target.lang, now, preview: true });
  // The entry as the language shows it (filled in from the default language where it has to be).
  const shown = (target.kind === 'post' ? ctx.content.posts : ctx.content.pages).find((e) => e.slug === target.slug);
  if (!shown) return null;
  let page = shown;
  let kind = target.kind;
  let html;
  if (kind === 'page') html = theme.renderPage(shown, ctx.for(shown, 'page')).value;
  else if (theme.renderPost && theme.postType?.url?.(shown)) html = theme.renderPost(shown, ctx.for(shown, 'post')).value;
  else {
    // A post without a page of its own: the page that lists posts, with this one among them.
    const pages = ctx.content.pages;
    page = pages.find((p) => p.slug === theme.postType?.previewPage) ?? pages.find((p) => p.slug === 'index') ?? pages[0];
    if (!page) return null;
    kind = 'page';
    html = theme.renderPage(page, ctx.for(page, 'page')).value;
  }
  // Relative addresses start from the page's folder on the site, not from the gateway's path.
  const languages = siteLanguages(site);
  const folder = target.lang && target.lang !== languages[0] ? `${target.lang}/` : '';
  const file = kind === 'post' ? theme.postType.url(shown) : `${page.slug}.html`;
  const dir = `${site.base ? `${String(site.base).replace(/^\/+|\/+$/g, '')}/` : ''}${folder}${file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : ''}`;
  const head = `<base href="/${escapeAttr(dir)}"><meta name="robots" content="noindex">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (tag) => tag + head) : head + html;
}
