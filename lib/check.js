// `werft check`: what in a built site is broken or poor. It reads the build from `files`
// ([{ path, size, text }], `text` for HTML and CSS files, paths relative to the output directory),
// so it needs no file system and no network.

// Each rule and how much it counts unless werft.config.js says otherwise (`check.rules`).
export const RULES = {
  'broken-link': 'error', // a link to a page or file that is not in the build
  'broken-anchor': 'error', // a link to #name that is not on its page
  'untranslated-link': 'error', // a language's page links to its version of a page it has not translated
  'missing-file': 'error', // an image, stylesheet, script or font that is not in the build
  'missing-alt': 'error', // <img> without an alt attribute
  'empty-alt': 'warning', // <img alt=""> that is not marked as decoration
  'large-file': 'warning', // a file above `check.maxFileSize`
};
const LEVELS = ['error', 'warning', 'off'];
export const MAX_FILE_SIZE = 1_000_000;

// werft.config.js: check: { rules: { 'empty-alt': 'error', … }, maxFileSize: bytes, ignore: [path prefixes in the output] }
function settings(site) {
  const { rules, maxFileSize, ignore } = { rules: {}, maxFileSize: MAX_FILE_SIZE, ignore: [], ...Object.fromEntries(Object.entries(site.check ?? {}).filter(([, v]) => v != null)) };
  if (typeof rules !== 'object' || Array.isArray(rules)) throw new Error(`werft.config.js: check.rules must be an object, e.g. { 'empty-alt': 'error' } (got ${JSON.stringify(rules)}).`);
  for (const [rule, level] of Object.entries(rules)) {
    if (!Object.hasOwn(RULES, rule)) throw new Error(`werft.config.js: check.rules names the unknown rule "${rule}" (rules: ${Object.keys(RULES).join(', ')}).`);
    if (!LEVELS.includes(level)) throw new Error(`werft.config.js: check.rules["${rule}"] must be ${LEVELS.map((l) => `'${l}'`).join(', ')} (got ${JSON.stringify(level)}).`);
  }
  if (!(Number.isFinite(maxFileSize) && maxFileSize > 0)) throw new Error(`werft.config.js: check.maxFileSize must be a number of bytes (got ${JSON.stringify(maxFileSize)}).`);
  if (!Array.isArray(ignore) || ignore.some((p) => typeof p !== 'string' || !p)) throw new Error(`werft.config.js: check.ignore must list paths in the output, e.g. ['alt/'] (got ${JSON.stringify(ignore)}).`);
  return { levels: { ...RULES, ...rules }, maxFileSize, ignore };
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const codePoint = (n) => (n <= 0x10ffff ? String.fromCodePoint(n) : '�');
const decode = (value) => value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (m, hex, dec, name) => (hex ? codePoint(parseInt(hex, 16)) : dec ? codePoint(Number(dec)) : NAMED[name.toLowerCase()] ?? m));

// Line and column (both from 1) of an offset in `text`.
function locator(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let [lo, hi] = [0, starts.length - 1];
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
}

// Comments, <script> and <style> elements with their contents, and start tags with their attributes.
const MARKUP = /<!--[\s\S]*?-->|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>|<([a-z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseHTML(text) {
  const tags = [];
  const styles = [];
  for (const m of text.matchAll(MARKUP)) {
    if (!m[1] && !m[4]) continue;
    const name = (m[1] ?? m[4]).toLowerCase();
    const source = m[2] ?? m[5];
    const start = m.index + 1 + name.length;
    const attributes = new Map();
    for (const a of source.matchAll(ATTRIBUTE)) {
      const key = a[1].toLowerCase();
      if (!attributes.has(key)) attributes.set(key, { value: decode(a[2] ?? a[3] ?? a[4] ?? ''), offset: start + a.index });
    }
    tags.push({ name, attributes, offset: m.index });
    if (name === 'style') styles.push({ css: m[3], offset: start + source.length + 1 });
  }
  return { tags, styles };
}

// url(…) and @import in CSS, with their offsets; comments are blanked first.
const CSS_REFERENCE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const cssReferences = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).matchAll(CSS_REFERENCE)]
  .map((m) => ({ value: m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5], offset: m.index }));

// The site path an address in the file `from` leads to: { path, dir, fragment }, { error }, or null
// for an address on another host (or with a scheme, or empty).
function resolve(from, address) {
  const value = address.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return null;
  const hash = value.indexOf('#');
  const fragment = hash < 0 ? '' : value.slice(hash + 1);
  const name = (hash < 0 ? value : value.slice(0, hash)).split('?')[0];
  if (!name) return { path: from, dir: false, fragment };
  const parts = name.startsWith('/') ? [] : from.split('/').slice(0, -1);
  const segments = name.split('/');
  for (const segment of segments) {
    let part;
    try { part = decodeURIComponent(segment); } catch { return { error: 'is not a valid address' }; }
    if (part === '..') {
      if (!parts.length) return { error: 'leads above the root of the site' };
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return { path: parts.join('/'), dir: ['', '.', '..'].includes(segments.at(-1)), fragment };
}

// Tags and attributes that name a page (a link) or a file the page loads.
const LINKS = { a: ['href'], area: ['href'], iframe: ['src'] };
const FILES = { img: ['src', 'srcset'], source: ['src', 'srcset'], script: ['src'], video: ['src', 'poster'], audio: ['src'], track: ['src'], embed: ['src'], object: ['data'], input: ['src'] };
const PAGE_RELATIONS = /\b(alternate|canonical|prev|next|author|help|license|search)\b/i;
// The addresses of a srcset, read as the HTML standard does: an address runs to the next white
// space (commas at its end close the candidate), its descriptors to the next comma.
function srcset(value) {
  const urls = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    const start = i;
    while (i < value.length && !/\s/.test(value[i])) i++;
    const url = value.slice(start, i);
    if (!url.endsWith(',')) {
      for (let depth = 0; i < value.length && (value[i] !== ',' || depth); i++) depth += value[i] === '(' ? 1 : value[i] === ')' ? -1 : 0;
    }
    if (url.replace(/,+$/, '')) urls.push(url.replace(/,+$/, ''));
  }
  return urls;
}
const GATEWAY = /(^|\/)api\/werft(\/|$)/;

// Redirect sources ("/alt/*", "/blog/:slug") as patterns for a path below the host's root.
const redirectPattern = (from) => new RegExp(`^${from.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:[a-z]\w*/gi, '[^/]+')}$`, 'i');

// Where in the site's sources (content files, theme) an address is written, as "path:line".
function sourcesOf(sources, value, path) {
  const needles = [...new Set([value, value.replace(/^(\.\.?\/)+/, ''), path])].filter((n) => n && n.length > 2);
  const found = [];
  for (const source of sources) {
    for (const needle of needles) {
      const at = source.text.indexOf(needle);
      if (at < 0) continue;
      found.push(`${source.path}:${source.text.slice(0, at).split('\n').length}`);
      break;
    }
    if (found.length === 3) break;
  }
  return found;
}

// files: the build; site: werft.config.js; redirects: the site's redirects; sources: [{ path, text }]
// of the site's content and theme, named in a finding when its address is written there.
// Returns { findings: [{ rule, severity, file, line, column, message, sources }], pages }.
export function check({ files, site = {}, redirects = [], sources = [] }) {
  const { levels, maxFileSize, ignore } = settings(site);
  const base = site.base ? `${site.base.replace(/^\/+|\/+$/g, '')}/` : '';
  const languages = site.languages ?? [];
  const skipped = [...(site.admin === false ? [] : [`${site.admin ?? 'admin'}/`]), `${base}_werft/`, ...ignore];
  const checked = (path) => !skipped.map((p) => p.replace(/\/+$/, '')).some((p) => path === p || path.startsWith(`${p}/`));
  const have = new Set(files.map((f) => f.path));
  const patterns = redirects.filter((r) => typeof r?.from === 'string').map((r) => redirectPattern(r.from));
  const redirected = (path) => patterns.some((p) => p.test(`/${path}`));
  const lookup = ({ path, dir }) => {
    if (!dir && have.has(path)) return path;
    const index = path ? `${path}/index.html` : 'index.html';
    return have.has(index) ? index : null;
  };

  const findings = [];
  const report = (rule, file, at, message, address, path) => {
    const severity = levels[rule];
    if (severity === 'off') return;
    findings.push({ rule, severity, file, ...(at ?? { line: null, column: null }), message, sources: address ? sourcesOf(sources, address, path) : [] });
  };

  const pages = files.filter((f) => /\.html?$/i.test(f.path) && typeof f.text === 'string' && checked(f.path))
    .map((f) => ({ ...f, ...parseHTML(f.text), at: locator(f.text) }));
  const ids = new Map(pages.map((p) => [p.path, new Set(p.tags.flatMap((t) => [t.attributes.get('id')?.value, t.name === 'a' ? t.attributes.get('name')?.value : undefined]).filter(Boolean))]));

  // The language a file belongs to when that is not the default one.
  const languageOf = (path) => languages.slice(1).find((lang) => path.startsWith(`${base}${lang}/`));

  function reference(file, at, address, kind) {
    const target = resolve(file, address);
    if (!target) return;
    const rule = kind === 'link' ? 'broken-link' : 'missing-file';
    if (target.error) return report(rule, file, at, `"${address}" ${target.error}`, address);
    if (GATEWAY.test(target.path)) return;
    const found = lookup(target);
    if (!found) {
      if (kind === 'link' && redirected(target.path + (target.dir && target.path ? '/' : ''))) return;
      const lang = languageOf(file);
      const original = lang && target.path.startsWith(`${base}${lang}/`) ? base + target.path.slice(`${base}${lang}/`.length) : null;
      if (kind === 'link' && original !== null && lookup({ ...target, path: original })) {
        // The relative address the build rewrites, from the file's folder within its language.
        const relative = '../'.repeat(file.slice(`${base}${lang}/`.length).split('/').length - 1) + original.slice(base.length);
        return report('untranslated-link', file, at, `"${address}" leads to ${target.path || '/'}, a page "${lang}" does not have; the "${languages[0]}" page is ${lookup({ ...target, path: original })}. Write the link relative to the page ("${relative || './'}") so the build leads there, or translate the page.`, address, target.path);
      }
      const hint = !target.dir && lookup({ path: `${target.path}.html` }) ? `; ${target.path}.html exists, but only some hosts serve it without ".html"` : '';
      return report(rule, file, at, `"${address}": there is no ${target.path || '/'} in the build${hint}`, address, target.path);
    }
    if (kind !== 'link' || !target.fragment || target.fragment === 'top' || target.fragment.startsWith(':~:') || !ids.has(found)) return;
    let fragment;
    try { fragment = decodeURIComponent(target.fragment); } catch { fragment = target.fragment; }
    if (!ids.get(found).has(fragment)) report('broken-anchor', file, at, `"${address}": ${found} has no element with id "${fragment}"`, address);
  }

  for (const page of pages) {
    for (const { name, attributes, offset } of page.tags) {
      const at = (attribute) => page.at(attributes.get(attribute)?.offset ?? offset);
      for (const attribute of LINKS[name] ?? []) if (attributes.has(attribute)) reference(page.path, at(attribute), attributes.get(attribute).value, 'link');
      for (const attribute of FILES[name] ?? []) {
        if (!attributes.has(attribute) || (name === 'input' && attributes.get('type')?.value.toLowerCase() !== 'image')) continue;
        const value = attributes.get(attribute).value;
        for (const address of attribute === 'srcset' ? srcset(value) : [value]) reference(page.path, at(attribute), address, 'file');
      }
      if (name === 'link' && attributes.has('href')) reference(page.path, at('href'), attributes.get('href').value, PAGE_RELATIONS.test(attributes.get('rel')?.value ?? '') ? 'link' : 'file');
      if (attributes.has('style')) {
        for (const { value } of cssReferences(attributes.get('style').value)) reference(page.path, at('style'), value, 'file');
      }
      if (name === 'img') {
        const src = attributes.get('src')?.value || attributes.get('srcset')?.value || '';
        const alt = attributes.get('alt');
        // An image without a source is filled in by a script (a lightbox); its alt text comes with it.
        const decoration = !src || ['presentation', 'none'].includes(attributes.get('role')?.value) || attributes.get('aria-hidden')?.value === 'true';
        if (!alt) report('missing-alt', page.path, page.at(offset), `the image "${src}" has no alt attribute; give it alt="" if it is decoration`, src);
        else if (!alt.value.trim() && !decoration) report('empty-alt', page.path, page.at(offset), `the image "${src}" has no alt text: fill in "Alternativtext" in the editor, or mark it as decoration with role="presentation"`, src);
      }
    }
    for (const { css, offset } of page.styles) {
      for (const ref of cssReferences(css)) reference(page.path, page.at(offset + ref.offset), ref.value, 'file');
    }
  }

  for (const file of files.filter((f) => /\.css$/i.test(f.path) && typeof f.text === 'string' && checked(f.path))) {
    const at = locator(file.text);
    for (const ref of cssReferences(file.text)) if (!ref.value.startsWith('#')) reference(file.path, at(ref.offset), ref.value, 'file');
  }

  // Redirects to a page of the site that is not there; `_redirects` has one line per redirect.
  redirects.forEach((r, i) => {
    if (typeof r?.to !== 'string' || !r.to.startsWith('/') || r.to.startsWith('//')) return;
    const target = resolve('', r.to);
    if (target.error || GATEWAY.test(target.path) || /:[a-z]\w*/i.test(r.to) || lookup(target) || redirected(target.path)) return;
    report('broken-link', '_redirects', { line: i + 1, column: 1 }, `the redirect from ${r.from} leads to ${r.to}, which is not in the build`, r.to, target.path);
  });

  for (const file of files) {
    if (checked(file.path) && file.size > maxFileSize) report('large-file', file.path, null, `${megabytes(file.size)}, more than ${megabytes(maxFileSize)} (check.maxFileSize); make it smaller or set check.maxFileSize`, file.path.slice(base.length));
  }

  const order = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
  return { findings: findings.sort(order), pages: pages.length };
}
