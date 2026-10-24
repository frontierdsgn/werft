// Helpers for the editor's page preview: what makes a page safe to show next to the signed-in
// user's tokens, and how a post is shown when it has no page of its own.
import { createContext, safeURL, html } from 'werft';
import { postTypesOf } from 'werft/content';
import { t, intlLocale } from './i18n.js';

const replaceIn = (list, entry) => [...list.filter((e) => e.slug !== entry.slug), entry].sort((a, b) => (a.slug < b.slug ? -1 : 1));

// The element a page gains when a post is added (a in `shown`, missing in `hidden`): the first
// child that differs, followed down until the added element itself.
function addedElement(shown, hidden) {
  let a = shown.body, b = hidden.body;
  for (;;) {
    const i = [...a.children].findIndex((child, n) => child.outerHTML !== b.children[n]?.outerHTML);
    if (i < 0) return a === shown.body ? null : a;
    const next = b.children[i];
    if (!next || (a.children.length > b.children.length && a.children[i + 1]?.outerHTML === next.outerHTML)) return a.children[i];
    a = a.children[i];
    b = next;
  }
}

const parse = (text) => new DOMParser().parseFromString(text, 'text/html');

// The preview runs on the admin's origin, next to the signed-in user's tokens: whatever a theme
// lets through, no event handler or javascript: URL reaches it.
export function disarm(doc) {
  for (const el of doc.querySelectorAll('*')) {
    for (const { name, value } of [...el.attributes]) {
      if (name.startsWith('on') || (['href', 'src', 'action', 'formaction', 'poster', 'xlink:href'].includes(name) && !safeURL(value))) el.removeAttribute(name);
    }
  }
}

// A post as the site shows it, for any theme: its own page when the theme has post pages; else the
// page that lists it, with the post marked; else the post alone in a block that lists posts; else
// its data. Drafts and scheduled posts are shown as if published.
// `type` is the post's type (the theme's first by default).
export function postPreview(entry, content, { site, theme, media, type = postTypesOf(theme)[0] }) {
  const post = { ...entry, status: 'published', publish_date: undefined };
  const { label, previewPage } = type;
  const title = post.title || post.slug;
  const first = type.name === postTypesOf(theme)[0]?.name;
  const others = (content.types?.[type.name] ?? (first ? content.posts : [])).filter((p) => p.slug !== post.slug);
  const withPost = replaceIn(others, post);
  const contextWith = (posts) => createContext({ site, theme, content: { ...content, types: { ...content.types, [type.name]: posts }, ...(first && { posts }) }, media, now: new Date(), preview: true });
  const render = (posts, page) => theme.renderPage(page, contextWith(posts).for(page)).value;
  if (theme.renderPost && type.url) return { html: theme.renderPost(post, contextWith(withPost).for(post, 'post', { type: type.name })).value };

  const pages = [...content.pages].sort((a, b) => (b.slug === previewPage) - (a.slug === previewPage));
  for (const page of pages) {
    const shown = render(withPost, page);
    const hidden = render(others, page);
    if (shown === hidden) continue;
    const doc = parse(shown);
    addedElement(doc, parse(hidden))?.setAttribute('data-werft-focus', '');
    return { html: doc.documentElement.outerHTML, focus: page.slug, note: t('postPreview.onPage', { label, title, page: page.title }) };
  }

  for (const [type, block] of Object.entries(theme.blocks)) {
    const page = { slug: post.slug, title, sections: [{ type }] };
    try {
      const shown = render([post], page);
      if (shown !== render([], page)) return { html: shown, note: t('postPreview.inBlock', { label, title, block: block.label }) };
    } catch { /* the block needs fields a bare section lacks */ }
  }

  const value = (field) => {
    const v = post[field.name];
    if (field.widget === 'image' || v?.src) return html`<img src="${v?.src ?? v}" alt="" style="max-width:100%;max-height:50vh">`;
    if (field.widget === 'datetime') return new Date(v).toLocaleString(intlLocale(), { dateStyle: 'long', ...(field.time_format !== false && { timeStyle: 'short' }) });
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  const fields = type.fields.filter((f) => post[f.name] != null && post[f.name] !== '');
  return {
    html: html`<body><dl style="margin:24px;font:16px/1.5 system-ui,sans-serif">${fields.map((f) => html`<dt style="font-weight:700;margin-top:12px">${f.label}</dt><dd style="margin:0">${value(f)}</dd>`)}</dl></body>`.value,
    note: t('postPreview.fields', { label, title }),
  };
}

