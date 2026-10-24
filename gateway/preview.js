// Preview links: one page or post, as it is saved on the branch, rendered with the site's theme for
// someone without an account. The gateway checks the link (signed, expiring, listed until revoked,
// see core.js); this module only finds the entry and renders it the way the build does, with a
// draft or scheduled entry shown as published.
import { loadContent, siteAddresses, postsOf, postTypesOf } from '../lib/content.js';
import { createContext } from '../lib/build.js';

const escapeAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// What a content path is: { kind: 'page' | 'post', slug, lang, type (a post's) }, or null for
// anything else.
export function previewTarget(path, { contentDir = 'content', postType, postTypes = postType ? [postType] : [], languages = [] }) {
  const lang = languages.slice(1).find((l) => path.startsWith(`${contentDir}/${l}/`));
  const rest = path.slice(contentDir.length + 1 + (lang ? lang.length + 1 : 0));
  if (!path.startsWith(`${contentDir}/`)) return null;
  const match = /^([^/]+)\/([^/]+)\.json$/.exec(rest);
  if (!match) return null;
  const kind = match[1] === 'pages' ? 'page' : postTypes.includes(match[1]) ? 'post' : null;
  return kind && { kind, slug: match[2], lang, ...(kind === 'post' && { type: match[1] }) };
}

// The entry's page as HTML, or null when the entry is gone. files: the content directory's tree
// entries; read(paths) → texts.
export async function renderPreview({ site, theme, target, files, media = {}, read, now = new Date() }) {
  const texts = new Map((await read(files.map((f) => f.path))).map((text, i) => [files[i].path, text]));
  const store = {
    list: async (dir) => files.filter((f) => f.path.startsWith(`${dir}/`)).map((f) => f.path.slice(dir.length + 1)),
    readText: async (p) => { if (texts.get(p) == null) throw Object.assign(new Error(p), { status: 404 }); return texts.get(p); },
  };
  const content = await loadContent({ site, theme, store });
  const own = target.lang ? content.languages?.[target.lang] : content;
  const type = postTypesOf(theme).find((t) => t.name === (target.type ?? postTypesOf(theme)[0]?.name));
  const list = target.kind === 'post' ? own && type && postsOf(own, type.name, postTypesOf(theme)[0].name) : own?.pages;
  const entry = list?.find((e) => e.slug === target.slug);
  if (!entry) return null;
  list.splice(list.indexOf(entry), 1, { ...entry, status: 'published', publish_date: undefined });
  const ctx = createContext({ site, theme, content, media, lang: target.lang, now, preview: true });
  // The entry as the language shows it (filled in from the default language where it has to be).
  const shown = (target.kind === 'post' ? postsOf(ctx.content, type.name, postTypesOf(theme)[0].name) : ctx.content.pages).find((e) => e.slug === target.slug);
  if (!shown) return null;
  let page = shown;
  let kind = target.kind;
  if (kind === 'post' && !(theme.renderPost && type.url?.(shown))) {
    // A post without a page of its own: the page that lists posts, with this one among them.
    const pages = ctx.content.pages;
    page = pages.find((p) => p.slug === type.previewPage) ?? pages.find((p) => p.slug === 'index') ?? pages[0];
    if (!page) return null;
    kind = 'page';
  }
  const pageCtx = ctx.for(page, kind, { type: type?.name });
  // Links the content writes ("kontakt.html") lead to their pages as on the site, where another
  // language's drafts are not shown.
  const html = pageCtx.links((kind === 'page' ? theme.renderPage(page, pageCtx) : theme.renderPost(page, pageCtx)).value, siteAddresses({ site, theme, content, now }));
  // Relative addresses start from the page's folder on the site, not from the gateway's path.
  const { file } = kind === 'post' ? ctx.addresses.post(page, target.lang, type.name) : ctx.addresses.page(page.slug, target.lang);
  const dir = `${site.base ? `${String(site.base).replace(/^\/+|\/+$/g, '')}/` : ''}${file.slice(0, file.lastIndexOf('/') + 1)}`;
  const head = `<base href="/${escapeAttr(dir)}"><meta name="robots" content="noindex">`;
  return /<head(\s[^>]*)?>/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (tag) => tag + head) : head + html;
}
