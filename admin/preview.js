// Live preview in the CMS: renders the entry being edited with the site's own theme, in the browser,
// so the preview is the page as it will be published.
import { createContext, mediaPaths, safeURL, html } from 'werft';
import { api } from './session.js';

const REPO = '/api/v1/repos/werft/site';
const decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

// The saved content of the site, read once per change on the server.
let cache;
export const forgetContent = () => { cache = undefined; };

async function loadContent(site, theme, branch) {
  const dir = site.contentDir ?? site.content ?? 'content';
  const { tree } = await api(`${REPO}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const paths = tree.map((e) => e.path).filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.json'));
  const files = await api(`${REPO}/file-contents?ref=${encodeURIComponent(branch)}`, { method: 'POST', body: { files: paths } });
  const revive = mediaPaths(site);
  const data = Object.fromEntries(files.filter(Boolean).map((f) => [f.path, JSON.parse(decode(f.content), revive)]));
  const folder = (name) => Object.entries(data).filter(([p]) => p.startsWith(`${dir}/${name}/`))
    .map(([p, value]) => ({ ...value, slug: p.split('/').pop().replace(/\.json$/, '') })).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return {
    pages: folder('pages'), posts: theme.postType ? folder(theme.postType.name) : [], patterns: folder('patterns'), forms: folder('forms'),
    settings: data[`${dir}/settings/site.json`] ?? {}, menus: data[`${dir}/settings/menus.json`] ?? {}, redirects: data[`${dir}/settings/redirects.json`]?.redirects ?? [],
  };
}

const replaceIn = (list, entry) => [...list.filter((e) => e.slug !== entry.slug), entry].sort((a, b) => (a.slug < b.slug ? -1 : 1));

// Does a list of sections (following patterns) contain `key: value` anywhere?
function mentions(sections, content, key, value, seen = new Set()) {
  return (sections ?? []).some((s) => {
    if (s.type === 'pattern' && !seen.has(s.pattern)) {
      seen.add(s.pattern);
      return s.pattern === value && key === 'pattern' || mentions(content.patterns.find((p) => p.slug === s.pattern)?.sections, content, key, value, seen);
    }
    return s[key] === value;
  });
}

// Which page shows an entry of `kind`, with the draft applied to the content.
function pageFor(kind, entry, content, theme) {
  switch (kind) {
    case 'pages': content.pages = replaceIn(content.pages, entry); return entry;
    case 'patterns': content.patterns = replaceIn(content.patterns, entry);
      return content.pages.find((p) => mentions(p.sections, content, 'pattern', entry.slug)) ?? { slug: entry.slug, title: entry.title, sections: [{ type: 'pattern', pattern: entry.slug }] };
    case 'forms': content.forms = replaceIn(content.forms, entry);
      return content.pages.find((p) => mentions(p.sections, content, 'form', entry.slug)) ?? content.pages.find((p) => p.slug === 'index');
    case 'site': content.settings = entry; return content.pages.find((p) => p.slug === 'index');
    default: // menus
      content.menus = entry; return content.pages.find((p) => p.slug === 'index');
  }
}

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

// A post as the site shows it, for any theme: its own page when the theme has post pages; else the
// page that lists it, with the post marked; else the post alone in a block that lists posts; else
// its data. Drafts and scheduled posts are shown as if published.
function postPreview(entry, content, { site, theme, media }) {
  const post = { ...entry, status: 'published', publish_date: undefined };
  const { label, previewPage } = theme.postType;
  const title = post.title || post.slug;
  const others = content.posts.filter((p) => p.slug !== post.slug);
  const withPost = replaceIn(others, post);
  const contextWith = (posts) => createContext({ site, theme, content: { ...content, posts }, media, now: new Date(), preview: true });
  const render = (posts, page) => theme.renderPage(page, contextWith(posts).for(page)).value;
  if (theme.renderPost && theme.postType.url) return { html: theme.renderPost(post, contextWith(withPost).for(post)).value };

  const pages = [...content.pages].sort((a, b) => (b.slug === previewPage) - (a.slug === previewPage));
  for (const page of pages) {
    const shown = render(withPost, page);
    const hidden = render(others, page);
    if (shown === hidden) continue;
    const doc = parse(shown);
    addedElement(doc, parse(hidden))?.setAttribute('data-werft-focus', '');
    return { html: doc.documentElement.outerHTML, focus: page.slug, note: `${label} haben keine eigene Seite. „${title}“ erscheint auf der Seite „${page.title}“ (markiert).` };
  }

  for (const [type, block] of Object.entries(theme.blocks)) {
    const page = { slug: post.slug, title, sections: [{ type }] };
    try {
      const shown = render([post], page);
      if (shown !== render([], page)) return { html: shown, note: `${label} haben keine eigene Seite, und „${title}“ steht noch auf keiner. So zeigt die Website sie im Abschnitt „${block.label}“.` };
    } catch { /* the block needs fields a bare section lacks */ }
  }

  const value = (field) => {
    const v = post[field.name];
    if (field.widget === 'image' || v?.src) return html`<img src="${v?.src ?? v}" alt="" style="max-width:100%;max-height:50vh">`;
    if (field.widget === 'datetime') return new Date(v).toLocaleString('de-DE', { dateStyle: 'long', ...(field.time_format !== false && { timeStyle: 'short' }) });
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  const fields = theme.postType.fields.filter((f) => post[f.name] != null && post[f.name] !== '');
  return {
    html: html`<body><dl style="margin:24px;font:16px/1.5 system-ui,sans-serif">${fields.map((f) => html`<dt style="font-weight:700;margin-top:12px">${f.label}</dt><dd style="margin:0">${value(f)}</dd>`)}</dl></body>`.value,
    note: `${label} haben keine eigene Seite, und „${title}“ steht noch auf keiner. Hier ihre Angaben.`,
  };
}

export function registerPreviews({ CMS, site, theme, base, branch }) {
  const { React } = CMS;
  const mediaDir = site.mediaDirs?.[0] ?? 'assets/img';
  let media;
  const mediaIndex = async () => (media ??= await fetch(`${base}_werft/media.json`).then((r) => (r.ok ? r.json() : {}), () => ({})));

  function Preview(kind) {
    return function WerftPreview({ entry, getAsset, document: doc }) {
      // A file uploaded but not saved yet is a blob: URL in the entry, which a theme would drop as an
      // unsafe address. The theme gets a media path for it; the preview shows the file itself.
      const revive = mediaPaths(site);
      const uploads = new Map();
      const data = JSON.parse(JSON.stringify(entry.get('data').toJS()), (key, value) => {
        if (typeof value !== 'string' || !value.startsWith('blob:')) return revive(key, value);
        const path = [...uploads].find(([, url]) => url === value)?.[0] ?? `${mediaDir}/werft-upload-${uploads.size + 1}`;
        uploads.set(path, value);
        return path;
      });
      const slug = entry.get('slug') || 'neu';
      const key = JSON.stringify([data, [...uploads]]);
      const [state, setState] = React.useState({ html: '', className: '' });
      React.useEffect(() => {
        let alive = true;
        (async () => {
          const index = await mediaIndex();
          const content = structuredClone(await (cache ??= loadContent(site, theme, branch)));
          let text, note, focus;
          if (kind === theme.postType?.name) ({ html: text, note, focus } = postPreview({ ...data, slug }, content, { site, theme, media: index }));
          else {
            const page = pageFor(kind, { ...data, slug }, content, theme);
            text = theme.renderPage(page, createContext({ site, theme, content, media: index, now: new Date(), preview: true }).for(page)).value;
          }
          const parsed = parse(text);
          // The preview runs on the admin's origin, next to the signed-in user's tokens: whatever a
          // theme lets through, no event handler or javascript: URL reaches it.
          for (const el of parsed.querySelectorAll('*')) {
            for (const { name, value } of [...el.attributes]) {
              if (name.startsWith('on') || (['href', 'src', 'action', 'formaction', 'poster', 'xlink:href'].includes(name) && !safeURL(value))) el.removeAttribute(name);
            }
          }
          // The preview frame has no address of its own: links and images become absolute. Files
          // uploaded but not yet on the site come from the CMS's local copy.
          const siteURL = new URL(base, location.origin);
          for (const el of parsed.querySelectorAll('[src], [href], [srcset]')) {
            for (const name of ['src', 'href']) {
              const value = el.getAttribute(name);
              if (!value || value.startsWith('#')) continue;
              el.setAttribute(name, uploads.get(value) ?? (value.startsWith(`${mediaDir}/`) && !(value in index) ? String(getAsset(`${base}${value}`) ?? value) : new URL(value, siteURL).href));
            }
            const srcset = el.getAttribute('srcset');
            if (srcset) {
              const candidates = [...srcset.matchAll(/(\S+)(\s+\S+)?/g)];
              if (candidates.some(([, u]) => u.startsWith(`${mediaDir}/`) && !(u in index))) el.removeAttribute('srcset');
              else el.setAttribute('srcset', candidates.map(([, u, w = '']) => `${new URL(u.replace(/,$/, ''), siteURL).href}${w.replace(/,$/, '')}`).join(', '));
            }
          }
          // The page's own styles come along; of its scripts only files run, not inline ones (they
          // could, e.g., lock the preview behind a password screen).
          const styles = [...parsed.head.querySelectorAll('style')].map((el) => el.outerHTML).join('');
          const url = (el, attr) => new URL(el.getAttribute(attr), new URL(base, location.origin)).href;
          const sheets = [...parsed.head.querySelectorAll('link[rel~="stylesheet"][href]')].map((el) => url(el, 'href'));
          const scripts = [...parsed.head.querySelectorAll('script[src]')].map((el) => url(el, 'src'));
          if (note) {
            const bar = parsed.createElement('p');
            bar.className = 'werft-preview-note';
            bar.textContent = note;
            parsed.body.prepend(bar);
          }
          if (alive) setState({ html: styles + parsed.body.innerHTML, className: parsed.body.className, lang: parsed.documentElement.lang, sheets, scripts, focus });
        })().catch((error) => alive && setState({ html: `<p style="padding:16px;font:14px system-ui">Vorschau nicht möglich: ${String(error.message).replace(/</g, '&lt;')}</p>`, className: '' }));
        return () => { alive = false; };
      }, [key, slug]);
      // The marked post comes into view when the preview first shows it, not on every keystroke. The
      // page's styles and images still move it while they load, so it is followed for a moment
      // unless the user scrolls.
      const focused = React.useRef();
      React.useEffect(() => {
        if (!state.focus || focused.current === `${slug}:${state.focus}`) return undefined;
        focused.current = `${slug}:${state.focus}`;
        const follow = () => doc.querySelector('[data-werft-focus]')?.scrollIntoView({ block: 'center', behavior: 'instant' });
        const observer = new doc.defaultView.ResizeObserver(follow);
        observer.observe(doc.body);
        const stop = () => observer.disconnect();
        const timer = setTimeout(stop, 3000);
        for (const type of ['wheel', 'touchstart', 'keydown', 'mousedown']) doc.addEventListener(type, stop, { once: true });
        return () => { clearTimeout(timer); stop(); };
      }, [state]);
      React.useEffect(() => {
        if (!doc.querySelector('base')) doc.head.prepend(Object.assign(doc.createElement('base'), { href: new URL(base, location.origin).href }));
        doc.body.className = state.className;
        if (state.lang) doc.documentElement.lang = state.lang;
        // Stylesheets stay while they are unchanged, so typing does not reload them.
        const sheets = state.sheets ?? [];
        doc.querySelectorAll('link[data-werft]').forEach((el) => { if (!sheets.includes(el.href)) el.remove(); });
        for (const href of sheets) {
          if ([...doc.querySelectorAll('link[data-werft]')].some((el) => el.href === href)) continue;
          doc.head.append(Object.assign(doc.createElement('link'), { rel: 'stylesheet', href }));
          doc.head.lastChild.setAttribute('data-werft', '');
        }
        doc.querySelectorAll('script[data-werft]').forEach((el) => el.remove());
        for (const src of state.scripts ?? []) {
          const script = doc.createElement('script');
          script.src = src;
          script.setAttribute('data-werft', '');
          doc.body.append(script);
        }
        const stop = (event) => { if (event.target.closest('a, button, form')) event.preventDefault(); };
        doc.addEventListener('click', stop);
        doc.addEventListener('submit', stop);
        return () => { doc.removeEventListener('click', stop); doc.removeEventListener('submit', stop); };
      }, [state]);
      return React.createElement('div', { className: 'werft-preview', dangerouslySetInnerHTML: { __html: state.html } });
    };
  }

  // The CMS wraps the template in its own padding; the page brings its own.
  // A post's preview says where it appears and marks it there.
  CMS.registerPreviewStyle(`body{margin:0!important;padding:0!important}.werft-preview{display:contents}
    .werft-preview-note{position:sticky;top:0;z-index:1000;margin:0;padding:8px 16px;background:#231f1b;color:#faf4e8;font:600 13px/1.4 system-ui,sans-serif}
    [data-werft-focus]{outline:3px solid #d9a521!important;outline-offset:4px}`, { raw: true });
  for (const kind of ['pages', 'patterns', 'forms', 'site', 'menus', ...(theme.postType ? [theme.postType.name] : [])]) {
    CMS.registerPreviewTemplate(kind, Preview(kind));
  }
}
