// Isomorphic site build: runs in Node (CLI, host builds) and in the browser (admin preview).
// `store` abstracts file access: { list(dir) → relative paths, readText(path), readBytes(path) }.
import { html, raw, escape, attr } from './html.js';
import { markdown, inline } from './markdown.js';
import { imageSize } from './image-size.js';
import { responsive, focusOf } from './images.js';
import { searchIndex, searchBox } from './search.js';
import { WEEKDAYS } from './fields.js';
import { loadContent, localize, ownPosts, siteLanguages, siteAddresses, prefixOf, relativePath, isPublic, isScheduled, pageFile, sortPosts, postDate } from './content.js';

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

// A short content hash of each stylesheet and script in the theme's static directory, by its path
// on the site ("assets/css/site.css"), for ctx.asset(). Other files (fonts, images) are not read.
const HASHED = /\.(css|js|mjs)$/i;
export async function indexAssets(store, dir) {
  const index = {};
  if (!dir) return index;
  for (const rel of (await store.list(dir)).filter((p) => HASHED.test(p))) {
    let bytes;
    // A symbolic link to a folder is listed as a file, and a broken one cannot be read: neither
    // gets a hash.
    try { bytes = await store.readBytes(`${dir}/${rel}`); } catch (error) { if (['EISDIR', 'ENOENT'].includes(error.code)) continue; throw error; }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    index[rel] = [...new Uint8Array(digest).slice(0, 5)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return index;
}

// An address with ?v=<hash> (&v= after a query), before an anchor; unchanged without a hash.
function versioned(address, hash) {
  if (!hash) return address;
  const at = address.indexOf('#');
  const [main, anchor] = at < 0 ? [address, ''] : [address.slice(0, at), address.slice(at)];
  return `${main}${main.includes('?') ? '&' : '?'}v=${hash}${anchor}`;
}

// An <img> for a media image with its size, srcset and lazy loading, inside a <picture> when it has
// variants in other formats. `image` is a path or a picture field ({ src, alt, focus }); its focal
// point becomes object-position, ahead of the theme's own style. The address and srcset come from
// the file; width and height too, unless the theme gives its own.
function imageTag(info, image, url, { alt, sizes = '100vw', loading = 'lazy', decoding = 'async', width = info?.width, height = info?.height, src: _src, srcset: _srcset, style, ...attributes } = {}) {
  if (!info) return raw('');
  const { srcset, sources = [] } = info;
  const focus = focusOf(image);
  attributes.style = [focus && `object-position:${focus}`, style].filter(Boolean).join(';') || style;
  const img = html`<img${attr('src', url(info.src))} alt="${alt ?? image?.alt ?? ''}"${attr('srcset', srcset)}${attr('sizes', srcset && sizes)}
    ${attr('width', width)}${attr('height', height)}${attr('loading', loading)}${attr('decoding', decoding)}
    ${Object.entries(attributes).map(([name, value]) => attr(name, value))}>`;
  if (!sources.length) return img;
  return html`<picture>${sources.map((s) => html`<source type="${s.type}" srcset="${s.srcset}"${attr('sizes', sizes)}>`)}${img}</picture>`;
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
  return relativePath(from, file) + rest;
}

// The page shown for an address the site does not have: content/pages/404.json → 404.html.
export const NOT_FOUND = '404';

// A language without posts of its own shows the default language's; they are published once, in
// the default language, and its pages link there.
const sharesPosts = (content, languages, lang, now) => !!prefixOf(languages, lang) && !ownPosts(content, lang, now);

// `content` is the site's content (loadContent) or one language of it (localize); `lang` picks the
// language of the first.
export function createContext({ site, theme, content: given, media = {}, assets = {}, now = new Date(), preview = false, lang }) {
  const languages = siteLanguages(site);
  const content = localize(given, { site, lang, now });
  const code = content.lang ?? content.settings?.lang ?? 'de';
  const prefix = prefixOf(languages, code);
  const every = content.source ?? content;
  const addresses = siteAddresses({ site, theme, content: every, preview, now });
  const sharedPosts = sharesPosts(every, languages, code, now);
  const mediaDirs = site.mediaDirs ?? [];
  // The editor's preview shows the originals: new uploads have no variants yet.
  const sizes = preview ? () => ({}) : responsive;
  // A media image by its path or its picture field, with its focal point if the field has one.
  const imageInfo = (value, url) => {
    const src = typeof value === 'object' ? value?.src : value;
    const focus = focusOf(value);
    return src ? { src, ...media[src], ...sizes(src, media[src], url), ...(focus && { focus }) } : undefined;
  };
  const publicPosts = sortPosts(content.posts.filter((p) => isPublic(p, now)), theme.postType?.date);
  const base = {
    site, theme, content, now, preview,
    lang: code, languages,
    settings: content.settings,
    html, raw, escape, md: (s) => raw(markdown(s)), inline: (s) => raw(inline(s)),
    menu: (id) => ({ label: '', items: [], ...content.menus[id] }),
    form: (slug) => content.forms.find((f) => f.slug === slug),
    image: (value) => imageInfo(value, (path) => path),
    img: (image, options) => imageTag(base.image(image), image, (path) => path, options),
    exists: (path) => path in media,
    posts: ({ slugs, limit } = {}) => {
      const list = slugs?.length ? slugs.map((s) => publicPosts.find((p) => p.slug === s)).filter(Boolean) : publicPosts;
      return limit ? list.slice(0, limit) : list;
    },
    postUrl: (post) => {
      const url = theme.postType?.url?.(post);
      return url && sharedPosts ? relativeURL(`${prefix}index.html`, url) : url;
    },
  };
  // The entry's counterpart in each language, for a language switcher: same slug, published (or
  // shown in the editor's preview); else that language's home page.
  const shown = (entry) => entry && (preview || isPublic(entry, now));
  // The entry's counterpart in a language: { path (its site path), noindex }, null without one.
  const counterpart = (entry, kind, other) => {
    const own = other === languages[0] ? every : every.languages?.[other] ?? {};
    const list = kind === 'post' ? (other === languages[0] ? every.posts : ownPosts(every, other, now) ?? []) : own.pages ?? [];
    const found = list.find((e) => e.slug === entry.slug);
    const match = shown(found) ? found : null;
    const target = match && (kind === 'post' ? addresses.post(match, other)?.url : addresses.page(entry.slug, other).url);
    return typeof target === 'string' ? { path: target, noindex: !!match.seo?.noindex } : null;
  };
  const translations = (entry, kind, file) => languages.map((other) => {
    const path = counterpart(entry, kind, other)?.path;
    return { lang: other, url: relativeURL(file, path ?? prefixOf(languages, other)), current: other === code, exists: typeof path === 'string' };
  });
  // kind: 'page' or 'post'; a post is an entry of the content's posts that is not a page.
  const forEntry = (entry, kind = content.posts.includes(entry) && !content.pages.includes(entry) ? 'post' : 'page') => {
    const own = kind === 'post' ? addresses.post(entry, code) : addresses.page(entry.slug, code);
    const file = own?.file ?? `${prefix}index.html`;
    // Links in the content start from the language's folder, on a post's page from the post's
    // address as the theme gives it.
    const from = kind === 'post' && own ? own.key : `${prefix}index.html`;
    const url = (path) => relativeURL(file, addresses.target(path));
    // Media named in Markdown are relative to the site's root, like every value in the content; on
    // a page in a folder they are made relative to the page.
    const relativeMedia = (out) => (file.includes('/') ? out.replace(/ (src|href)="([^"]*)"/g, (m, name, value) => (mediaDirs.some((d) => value.startsWith(`${d}/`)) ? ` ${name}="${url(value)}"` : m)) : out);
    const image = (value) => imageInfo(value, url);
    const ctx = {
      ...base,
      page: entry,
      url,
      // A theme stylesheet or script with its content hash, so browsers load it again once it changed.
      asset: (path) => versioned(url(path), assets[String(path ?? '').split(/[?#]/)[0]]),
      image,
      img: (value, options) => imageTag(image(value), value, url, options),
      translations: translations(entry, kind, file),
      head: (options) => headTags(ctx, entry, kind, options, languages.map((other) => ({ lang: other, ...counterpart(entry, kind, other) })), sharedPosts, own?.url),
      // The rendered page with the links the content writes ("kontakt.html") led to their pages
      // (by `using`, siteAddresses() of other content or without the preview's drafts).
      links: (text, using = addresses) => text.replace(/ href="([^"]*)"/g, (m, href) => ` href="${using.link(href, file, from)}"`),
      md: (s) => raw(relativeMedia(markdown(s))),
      inline: (s) => raw(relativeMedia(inline(s))),
      uses: (type) => blockTypes(entry.sections, content.patterns).has(type),
      search: (options) => {
        if (!theme.search) throw new Error('ctx.search() needs `search: true` in the theme');
        return searchBox(url, code, options);
      },
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
  return { ...base, addresses, for: forEntry };
}

// An absolute address for a site path, from the default language's site setting `url` (the address
// of the home page, below the base path if there is one); undefined without a usable one. An
// address with a scheme stays as it is.
function absoluteURL(siteURL, path) {
  if (/^https?:\/\//i.test(path)) return path;
  if (!siteURL) return undefined;
  try { return new URL(path, String(siteURL).replace(/\/*$/, '/')).href; } catch { return undefined; }
}

const ICON_TYPES = { png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const iconType = (src) => ICON_TYPES[String(src).split(/[?#]/)[0].split('.').pop().toLowerCase()];

// The web manifest for the site setting `icon` (a media path), null without one. Its addresses are
// relative to the manifest, which lies at the site's root.
function webManifest(settings, media) {
  if (!settings.icon) return null;
  const size = media[settings.icon];
  const icon = { src: settings.icon, ...(size && { sizes: `${size.width}x${size.height}` }), ...(iconType(settings.icon) && { type: iconType(settings.icon) }) };
  return { ...(settings.title && { name: settings.title }), start_url: './', display: 'browser', icons: [icon] };
}
const MANIFEST = 'manifest.webmanifest';

// A language's feed of posts: its newest published posts that are not noindex, by publish date
// (else the post type's date), at most FEED_ITEMS.
const FEED_ITEMS = 20;
function feedPosts(ctx) {
  const timeOf = (post) => { const time = postDate(post); return Number.isNaN(time) ? postDate(post, ctx.theme.postType?.date) : time; };
  const order = (a, b) => (Number.isNaN(a.time) - Number.isNaN(b.time)) || (Number.isNaN(a.time) ? 0 : b.time - a.time);
  return ctx.posts().filter((post) => !post.seo?.noindex).map((post) => ({ post, time: timeOf(post) })).sort(order).slice(0, FEED_ITEMS);
}

// The site path of a language's feed, null without one: it needs the post type, the default
// language's site address (feeds hold absolute links), a site open to search engines and posts to
// list. A language that shows the default language's posts (`shared`) links that feed.
// `postType.feed: false` turns it off.
function feedPath(ctx, shared) {
  const { postType } = ctx.theme;
  const settings = (ctx.content.source ?? ctx.content).settings ?? {};
  if (!postType || postType.feed === false || !settings.url || settings.search_visibility === 'noindex' || !feedPosts(ctx).length) return null;
  return `${shared ? '' : prefixOf(ctx.languages, ctx.lang)}feed.xml`;
}

// The feed's title: `postType.feed.title` (text, or a function of the language), else the site's
// name and the post type's label.
function feedTitle(theme, settings, lang) {
  const title = theme.postType.feed?.title;
  return (typeof title === 'function' ? title(lang) : title) ?? [settings.title, theme.postType.label].filter(Boolean).join(': ');
}

// Text for XML: escaped, without the control characters XML does not allow.
const xml = (value) => escape(String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, ''));

// An RSS 2.0 feed of a language's posts (feedPosts). A post links to its page, or without one to
// the language's home page. `postType.feed.description(post, ctx)`, with the post's ctx as in
// renderPost, gives an item's text (default: the post's SEO description); readers show it as HTML,
// so it is escaped as text first.
function rssFeed(ctx, siteURL, path) {
  const { theme } = ctx;
  const prefix = prefixOf(ctx.languages, ctx.lang);
  const home = absoluteURL(siteURL, prefix);
  const describe = theme.postType.feed?.description ?? ((post) => post.seo?.description);
  const item = ({ post, time }) => {
    const page = theme.renderPost && ctx.addresses.post(post, ctx.lang)?.url;
    const link = page ? absoluteURL(siteURL, page) : home;
    const description = describe(post, ctx.for(post, 'post'));
    return `<item><title>${xml(post.seo?.title || post.title || post.slug)}</title><link>${xml(link)}</link>`
      + `<guid isPermaLink="${page ? 'true' : 'false'}">${xml(page ? link : `${home}#${post.slug}`)}</guid>`
      + `${Number.isNaN(time) ? '' : `<pubDate>${new Date(time).toUTCString()}</pubDate>`}${description ? `<description>${xml(escape(description))}</description>` : ''}</item>`;
  };
  const title = xml(feedTitle(theme, ctx.settings, ctx.lang));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${title}</title><link>${xml(home)}</link>`
    + `<description>${title}</description><language>${xml(ctx.lang)}</language><atom:link href="${xml(absoluteURL(siteURL, path))}" rel="self" type="application/rss+xml"/>`
    + `${feedPosts(ctx).map(item).join('')}</channel></rss>\n`;
}

// A time as editors write it ("9:00", "09.30") in schema.org's form ("09:00"); midnight at the
// end of a day ("24:00") is 23:59. Null for anything else.
function openingTime(value) {
  const match = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(String(value ?? '').trim());
  if (match) return `${match[1].padStart(2, '0')}:${match[2]}`;
  return /^24[:.]00$/.test(String(value ?? '').trim()) ? '23:59' : null;
}

// The schema.org days from `from` to `to` (Mo to Fr, Fr to Mo across the weekend), or only `from`.
function weekdays(from, to) {
  const order = Object.keys(WEEKDAYS);
  const start = order.indexOf(from);
  const end = to ? order.indexOf(to) : start;
  if (start < 0 || end < 0) return null;
  return Array.from({ length: ((end - start + 7) % 7) + 1 }, (_, i) => WEEKDAYS[order[(start + i) % 7]]);
}

// JSON-LD (schema.org LocalBusiness, Organization or a type the theme offers) from the settings
// field the theme declares with fields.organization(); null without one or while it holds no
// more than its defaults.
function structuredData(ctx, siteURL) {
  const field = (ctx.theme.settingsFields ?? []).find((f) => f.structuredData);
  const data = field && ctx.settings[field.name];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const hours = (Array.isArray(data.hours) ? data.hours : []).flatMap((h) => {
    const days = h && typeof h === 'object' && weekdays(h.from, h.to);
    const [opens, closes] = [openingTime(h?.opens), openingTime(h?.closes)];
    return days && opens && closes ? [{ '@type': 'OpeningHoursSpecification', dayOfWeek: days, opens, closes }] : [];
  });
  const [street, city] = [text(data.street), text(data.city)];
  if (![data.name, street, city, data.phone, data.email].some(text) && !hours.length) return null;
  const types = field.fields.find((f) => f.name === 'type')?.options?.map((o) => (typeof o === 'string' ? o : o.value)) ?? [];
  const absolute = (path) => (path ? absoluteURL(siteURL, path) : undefined);
  const json = {
    '@context': 'https://schema.org',
    '@type': types.includes(data.type) ? data.type : types[0] ?? 'LocalBusiness',
    // One thing in every language.
    '@id': absolute('./') && `${absolute('./')}#organization`,
    name: text(data.name) ?? ctx.settings.title,
    url: absolute(prefixOf(ctx.languages, ctx.lang) || './'),
    logo: absolute((ctx.content.source ?? ctx.content).settings?.icon),
    image: absolute(ctx.settings.share_image),
    telephone: text(data.phone),
    email: text(data.email),
    address: street || city ? { '@type': 'PostalAddress', streetAddress: street, postalCode: text(data.postal_code), addressLocality: city, addressCountry: text(data.country) } : undefined,
    openingHoursSpecification: hours.length ? hours : undefined,
  };
  // "<" escaped, so no text ends the script element.
  return raw(`<script type="application/ld+json">${JSON.stringify(json).replace(/</g, '\\u003c')}</script>`);
}

// The tags for an entry's <head>: title, description, robots, canonical address, link preview (Open
// Graph, Twitter card), the entry's other languages, the feed and the icon. `versions` holds the
// entry in each language ({ lang, path, noindex }, without path where it has none); `options`
// ({ title, description, image, type }) replace what the entry and the site settings give;
// `sharedPosts`: the language shows the default language's posts.
function headTags(ctx, entry, kind, options = {}, versions = [], sharedPosts = false, address = '') {
  const { settings } = ctx;
  const seo = entry.seo ?? {};
  const siteURL = (ctx.content.source ?? ctx.content).settings?.url;
  const own = options.title || seo.title || entry.title;
  const name = own || settings.title;
  const title = own ? [own, settings.title_suffix].filter(Boolean).join(' ') : name;
  const description = options.description ?? seo.description;
  // A media path or address, or a picture field's value ({ src, alt }); an empty one falls through.
  const srcOf = (value) => (value && typeof value === 'object' ? value.src : value);
  const picked = [options.image, seo.image, settings.share_image].find(srcOf);
  const src = srcOf(picked);
  const image = src && absoluteURL(siteURL, src);
  const size = ctx.image(src) ?? {};
  // The not-found page is shown at any address, so its relative links start from its own folder;
  // it is noindex and names no address of its own.
  const notFound = kind === 'page' && entry.slug === NOT_FOUND;
  const folder = `/${ctx.site.base ? `${ctx.site.base.replace(/^\/+|\/+$/g, '')}/` : ''}${prefixOf(ctx.languages, ctx.lang)}`;
  const canonical = notFound ? undefined : absoluteURL(siteURL, versions.find((v) => v.lang === ctx.lang)?.path ?? address ?? '');
  // Like the sitemap: the indexed versions, once there are two.
  const indexed = notFound ? [] : versions.filter((v) => typeof v.path === 'string' && !v.noindex);
  const alternates = siteURL && indexed.length > 1 ? [...indexed, ...(indexed[0] === versions[0] ? [{ ...versions[0], lang: 'x-default' }] : [])] : [];
  const feed = feedPath(ctx, sharedPosts);
  const meta = (key, value, attribute = 'property') => (value == null || value === '' ? '' : html`<meta ${raw(attribute)}="${key}" content="${value}">`);
  return html`${notFound ? html`<base href="${folder}">` : ''}<title>${title}</title>${meta('description', description, 'name')}
    ${seo.noindex || notFound || settings.search_visibility === 'noindex' ? html`<meta name="robots" content="noindex">` : ''}
    ${canonical ? html`<link rel="canonical" href="${canonical}">` : ''}
    ${meta('og:type', options.type ?? (kind === 'post' ? 'article' : 'website'))}${meta('og:site_name', settings.title)}
    ${meta('og:title', name)}${meta('og:description', description)}${meta('og:url', canonical)}
    ${meta('og:image', image)}${image ? [meta('og:image:width', size.width), meta('og:image:height', size.height), meta('og:image:alt', picked?.alt)] : ''}
    ${meta('twitter:card', image ? 'summary_large_image' : 'summary', 'name')}
    ${alternates.map((v) => html`<link rel="alternate" hreflang="${v.lang}" href="${absoluteURL(siteURL, v.path)}">`)}
    ${feed ? html`<link rel="alternate" type="application/rss+xml" title="${sharedPosts ? feedTitle(ctx.theme, ctx.content.source?.settings ?? settings, ctx.languages[0]) : feedTitle(ctx.theme, settings, ctx.lang)}" href="${ctx.url(feed)}">` : ''}
    ${icons(ctx)}${kind === 'page' && entry.slug === 'index' ? structuredData(ctx, siteURL) : ''}`;
}

// The site setting `icon` for browser tabs, home screens and the web manifest.
function icons(ctx) {
  const icon = (ctx.content.source ?? ctx.content).settings?.icon;
  if (!icon) return '';
  const size = ctx.image(icon);
  // Apple devices take a PNG or JPEG for the home screen.
  const touch = /^image\/(png|jpeg)$/.test(iconType(icon));
  return html`<link rel="icon" href="${ctx.url(icon)}"${attr('type', iconType(icon))}${attr('sizes', size?.width && `${size.width}x${size.height}`)}>
    ${touch ? html`<link rel="apple-touch-icon" href="${ctx.url(icon)}">` : ''}<link rel="manifest" href="${ctx.url(MANIFEST)}">`;
}

const redirectsFile = (list) => list.map((r) => `${r.from} ${r.to} ${r.status ?? 301}`).join('\n') + (list.length ? '\n' : '');
// Apache knows no splats: a rule with * becomes a RedirectMatch whose group takes the place of :splat.
const htaccessLine = ({ from, to, status = 301 }) => {
  if (!from.includes('*')) return `Redirect ${status} ${from} ${to}`;
  const pattern = from.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('(.*)');
  return `RedirectMatch ${status} ^${pattern}$ ${to.replace(':splat', '$1')}`;
};
const htaccess = (lines) => lines.join('\n') + (lines.length ? '\n' : '');

// urls: [{ loc, alternates?: [{ lang, loc }] }]; alternates only for a site in several languages.
function sitemap(baseURL, urls, languages) {
  const href = (u) => escape(new URL(u, baseURL).href);
  const items = urls.map((u) => `<url><loc>${href(u.loc)}</loc>${(u.alternates ?? []).map((a) => `<xhtml:link rel="alternate" hreflang="${escape(a.lang)}" href="${href(a.loc)}"/>`).join('')}</url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${languages.length ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>${items}</urlset>\n`;
}

// The site's redirects (redirects.json) and the ones the build adds (`moved`: from each published
// entry's old .html address to its clean one). With clean addresses, a redirect away from an old
// clean address ("/alt/", a page renamed since) also takes that address's .html form. A redirect to a
// page named as in the content ("/kontakt.html") leads to the page's address; one that then leads to
// itself (werft 0.6's "/kontakt/" to "/kontakt.html") is left out, since it would hide the page. The
// site's own come first and keep their source.
function siteRedirects(own, moved, addresses, base) {
  const root = `/${base}`;
  const retarget = (to) => (typeof to === 'string' && to.startsWith(root) ? root + addresses.target(to.slice(root.length)) : to);
  const list = own.map((r) => (retarget(r.to) === r.to ? r : { ...r, to: retarget(r.to) })).filter((r) => r.from !== r.to);
  const aliases = addresses.style === 'clean'
    ? list.filter((r) => typeof r.from === 'string' && r.from.startsWith(root) && /[^/]\/$/.test(r.from) && !/[*:]/.test(r.from)).map((r) => ({ from: `${r.from.slice(0, -1)}.html`, to: r.to, status: r.status ?? 301 }))
    : [];
  const taken = new Set(list.map((r) => r.from));
  for (const r of [...moved, ...aliases]) if (!taken.has(r.from) && r.from !== r.to) { taken.add(r.from); list.push(r); }
  return list;
}

// Cloudflare Pages reads at most 2,000 redirects without and 100 with a placeholder or *; it drops
// the rest.
const CLOUDFLARE_REDIRECTS = { static: 2000, dynamic: 100 };
function redirectWarnings(redirects) {
  const dynamic = redirects.filter((r) => /[*:]/.test(String(r.from))).length;
  const counts = { static: redirects.length - dynamic, dynamic };
  return Object.entries(CLOUDFLARE_REDIRECTS).filter(([kind, most]) => counts[kind] > most)
    .map(([kind, most]) => `${counts[kind]} ${kind === 'static' ? 'plain' : 'pattern'} redirects: Cloudflare Pages reads only the first ${most.toLocaleString('en')} of them.`);
}

// Returns { files: [{ path, text }], copies: [dir], schedule, content, redirects, warnings } without
// touching the file system.
export async function build({ site, theme, store, now = new Date(), media }) {
  const base = site.base ? `${site.base.replace(/\/+$/, '')}/` : '';
  const content = await loadContent({ site, theme, store });
  const languages = siteLanguages(site);
  const mediaDirs = site.mediaDirs ?? [];
  media ??= await indexMedia(store, mediaDirs);
  const assets = await indexAssets(store, theme.staticDir);
  const files = [];
  const urls = [];
  const search = searchIndex(theme, base);
  const notFound = []; // the folders with a not-found page
  const moved = []; // redirects from the old .html addresses of published entries
  // An entry's file, unless another entry has it or it lies in a folder the site needs for
  // something else (another language, werft's files, the admin).
  const written = new Map();
  const reserved = new Set(['_werft', ...languages.slice(1), ...mediaDirs.map((d) => d.split('/')[0]), ...(base || site.admin === false ? [] : [site.admin ?? 'admin'])]);
  const write = (path, text, what, top) => {
    if (written.has(path)) throw new Error(`werft: ${written.get(path)} and ${what} would both be written to ${base}${path}; give one of them another address.`);
    if (top && path.includes('/') && reserved.has(path.split('/')[0])) throw new Error(`werft: ${what} would be written to ${base}${path}, a folder the site needs for something else; give it another address.`);
    written.set(path, what);
    files.push({ path: base + path, text });
  };
  // Each language in turn, the default first; a site without languages is built once.
  for (const lang of languages.length ? languages : [undefined]) {
    const local = localize(content, { site, lang, now });
    const prefix = base + prefixOf(languages, lang);
    const ctx = createContext({ site, theme, content: local, media, assets, now });
    const { addresses } = ctx;
    for (const page of local.pages.filter((p) => isPublic(p, now))) {
      const at = addresses.page(page.slug, lang);
      const entry = ctx.for(page, 'page');
      if (page.slug === NOT_FOUND) notFound.push(prefix);
      write(at.file, entry.links(theme.renderPage(page, entry).value), `the page "${page.slug}"`, !prefixOf(languages, lang));
      if (page.slug === NOT_FOUND) continue;
      const old = prefixOf(languages, lang) + pageFile(page.slug);
      if (page.slug !== 'index' && at.file !== old) moved.push({ from: `/${base}${old}`, to: `/${base}${at.url}`, status: 301 });
      search.add(ctx.lang, page, files.at(-1));
      if (!page.seo?.noindex) urls.push({ loc: base + at.url, key: `page:${page.slug}`, lang });
    }
    const shared = sharesPosts(content, languages, lang, now);
    const feed = !shared && feedPath(ctx, false);
    if (feed) files.push({ path: base + feed, text: rssFeed(ctx, content.settings.url, feed) });
    if (theme.postType?.url && theme.renderPost && !shared) {
      for (const post of local.posts.filter((p) => isPublic(p, now))) {
        const at = addresses.post(post, lang);
        if (!at) continue;
        const entry = ctx.for(post, 'post');
        write(at.file, entry.links(theme.renderPost(post, entry).value), `the ${theme.postType.singular ?? 'post'} "${post.slug}"`, !prefixOf(languages, lang));
        if (at.file !== at.key && at.key.endsWith('.html')) moved.push({ from: `/${base}${at.key}`, to: `/${base}${at.url}`, status: 301 });
        search.add(ctx.lang, post, files.at(-1), 'post');
        urls.push({ loc: base + at.url, key: `post:${post.slug}`, lang });
      }
    }
    if (sharesPosts(content, languages, lang, now)) search.sharePosts(ctx.lang, languages[0]);
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
  const redirects = siteRedirects(content.redirects, moved, siteAddresses({ site, theme, content, now }), base);
  if (redirects.length) files.push({ path: '_redirects', text: redirectsFile(redirects) });
  // Apache: the redirects at the root, each not-found page for its folder (Cloudflare Pages and
  // werft serve find the nearest 404.html themselves).
  const errorDocuments = Object.fromEntries(notFound.map((folder) => [`${folder.replace(/^\/+/, '')}.htaccess`, [`ErrorDocument 404 /${folder.replace(/^\/+/, '')}404.html`]]));
  const apache = { ...(redirects.length && { '.htaccess': redirects.map(htaccessLine) }) };
  for (const [path, lines] of Object.entries(errorDocuments)) apache[path] = [...(apache[path] ?? []), ...lines];
  for (const [path, lines] of Object.entries(apache)) files.push({ path, text: htaccess(lines) });
  const entries = [content, ...Object.values(content.languages ?? {})].flatMap((c) => [...c.pages, ...(c.posts ?? [])]);
  const upcoming = entries.filter((e) => isScheduled(e, now)).map((e) => Date.parse(e.publish_date));
  const schedule = { built_at: now.toISOString(), next_publish: upcoming.length ? new Date(Math.min(...upcoming)).toISOString() : null };
  const manifest = webManifest(content.settings, media);
  if (manifest) files.push({ path: base + MANIFEST, text: `${JSON.stringify(manifest, null, 2)}\n` });
  files.push({ path: `${base}_werft/build.json`, text: JSON.stringify({ ...schedule, redirects }) });
  files.push({ path: `${base}_werft/media.json`, text: JSON.stringify(media) });
  files.push(...search.files());
  // Directories copied unchanged into the site: the theme's static files (their contents) and the
  // media directories (as they are).
  const copies = [
    ...(theme.staticDir ? [{ from: theme.staticDir, to: base.replace(/\/$/, '') }] : []),
    ...mediaDirs.map((dir) => ({ from: dir, to: base + dir })),
  ];
  return { files, copies, schedule, content, redirects, warnings: redirectWarnings(redirects) };
}
