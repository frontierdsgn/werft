// Live preview in the CMS: renders the entry being edited with the site's own theme, in the browser,
// so the preview is the page as it will be published.
import { createContext } from 'werft';
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
  const data = Object.fromEntries(files.filter(Boolean).map((f) => [f.path, JSON.parse(decode(f.content))]));
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
    case 'menus': content.menus = entry; return content.pages.find((p) => p.slug === 'index');
    default: // posts
      content.posts = replaceIn(content.posts, { status: 'published', ...entry });
      return content.pages.find((p) => p.slug === theme.postType?.previewPage) ?? content.pages.find((p) => p.slug === 'index');
  }
}

export function registerPreviews({ CMS, site, theme, base, branch }) {
  const { React } = CMS;
  const mediaDir = site.mediaDirs?.[0] ?? 'assets/img';
  let media;
  const mediaIndex = async () => (media ??= await fetch(`${base}_werft/media.json`).then((r) => (r.ok ? r.json() : {}), () => ({})));

  function Preview(kind) {
    return function WerftPreview({ entry, getAsset, document: doc }) {
      const data = entry.get('data').toJS();
      const slug = entry.get('slug') || 'neu';
      const key = JSON.stringify(data);
      const [state, setState] = React.useState({ html: '', className: '' });
      React.useEffect(() => {
        let alive = true;
        (async () => {
          const index = await mediaIndex();
          const content = structuredClone(await (cache ??= loadContent(site, theme, branch)));
          const page = pageFor(kind, { ...data, slug }, content, theme);
          const ctx = createContext({ site, theme, content, media: index, now: new Date(), preview: true });
          const html = theme.renderPage(page, ctx.for(page)).value;
          const parsed = new DOMParser().parseFromString(html, 'text/html');
          // The preview frame has no address of its own: links and images become absolute. Files
          // uploaded but not yet on the site come from the CMS's local copy.
          const siteURL = new URL(base, location.origin);
          for (const el of parsed.querySelectorAll('[src], [href], [srcset]')) {
            for (const name of ['src', 'href']) {
              const value = el.getAttribute(name);
              if (!value || value.startsWith('#')) continue;
              el.setAttribute(name, value.startsWith(`${mediaDir}/`) && !(value in index) ? String(getAsset(value) ?? value) : new URL(value, siteURL).href);
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
          const scripts = [...parsed.head.querySelectorAll('script[src]')].map((el) => new URL(el.getAttribute('src'), new URL(base, location.origin)).href);
          if (alive) setState({ html: styles + parsed.body.innerHTML, className: parsed.body.className, lang: parsed.documentElement.lang, scripts });
        })().catch((error) => alive && setState({ html: `<p style="padding:16px;font:14px system-ui">Vorschau nicht möglich: ${String(error.message).replace(/</g, '&lt;')}</p>`, className: '' }));
        return () => { alive = false; };
      }, [key, slug]);
      React.useEffect(() => {
        if (!doc.querySelector('base')) doc.head.prepend(Object.assign(doc.createElement('base'), { href: new URL(base, location.origin).href }));
        doc.body.className = state.className;
        if (state.lang) doc.documentElement.lang = state.lang;
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

  CMS.registerPreviewStyle(`${base}assets/css/site.css`);
  // The CMS wraps the template in its own padding; the page brings its own.
  CMS.registerPreviewStyle('body{margin:0!important;padding:0!important}.werft-preview{display:contents}', { raw: true });
  for (const kind of ['pages', 'patterns', 'forms', 'site', 'menus', ...(theme.postType ? [theme.postType.name] : [])]) {
    CMS.registerPreviewTemplate(kind, Preview(kind));
  }
}
