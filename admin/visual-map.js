// Where the content of a page appears on the page. The visual editor renders the page with the
// site's own theme, so a theme needs nothing extra to be edited on the page itself: each text is
// rendered once more wrapped in invisible markers, and the markers in the resulting document say
// which element shows which value. A text whose markers would change the page (a value the theme
// compares, cuts or turns into a name) is left unmarked and stays editable in the side panel.
import { createContext, raw } from 'werft';

const OPEN = '';
const CLOSE = '';
const END = '';
const DIGIT = 0xE010;
const ANY = /[-]/;
const ALL = /[-]/g;
const MARK = /([-]+)|/g;
const OPENING = /([-]+)/g;

// Ids are written in private-use characters too, so a theme that turns a text into a name (a slug,
// an anchor) drops the whole marker instead of keeping its digits.
const encode = (id) => [...id.toString(16)].map((d) => String.fromCharCode(DIGIT + parseInt(d, 16))).join('');
const decode = (code) => parseInt([...code].map((c) => (c.charCodeAt(0) - DIGIT).toString(16)).join(''), 16);
const mark = (id, value) => `${OPEN}${encode(id)}${CLOSE}${value}${END}`;
export const unmark = (text) => text.replace(ALL, '');

// Values that name things rather than show text.
const STRUCTURE = new Set(['type', 'pattern', 'status', 'publish_date', 'form', 'id', 'slug']);
const IMAGE = /\.(jpe?g|png|gif|webp|svg|avif)$/i;

export function getAt(root, path) {
  return path.reduce((value, key) => value?.[key], root);
}
export function setAt(root, path, value) {
  getAt(root, path.slice(0, -1))[path.at(-1)] = value;
}

// The entry behind a source name: page:<slug>, pattern:<slug>, form:<slug>, settings, menus.
export function rootOf(content, source) {
  const [kind, slug] = source.split(':');
  if (kind === 'settings') return content.settings;
  if (kind === 'menus') return content.menus;
  const list = { page: content.pages, pattern: content.patterns, form: content.forms }[kind];
  return list?.find((e) => e.slug === slug);
}

function collect(value, source, path, texts, images, isMedia) {
  if (typeof value === 'string') {
    if (isMedia(value)) images.push({ source, path, value });
    else if (value.trim() && !STRUCTURE.has(path.at(-1))) texts.push({ source, path, value });
  } else if (Array.isArray(value)) value.forEach((v, i) => collect(v, source, [...path, i], texts, images, isMedia));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, source, [...path, k], texts, images, isMedia);
}

// The sources a page can show: the page, the patterns it uses, every form, the settings and menus.
export function sourcesOf(content, slug) {
  const page = content.pages.find((p) => p.slug === slug);
  const patterns = new Set((page?.sections ?? []).filter((s) => s.type === 'pattern').map((s) => s.pattern));
  return [`page:${slug}`, ...[...patterns].map((p) => `pattern:${p}`), ...content.forms.map((f) => `form:${f.slug}`), 'settings', 'menus'];
}

// render(content, slug) → { html, texts, images }. `texts[id]` is a marked text and where it lives;
// `images` are the media files the page's content names. `editable(source)` leaves out what the
// signed-in role cannot change.
export function pageRenderer({ site, theme, media = {}, now = () => new Date(), editable = () => true }) {
  const mediaDirs = site.mediaDirs ?? [];
  const isMedia = (v) => IMAGE.test(v) && mediaDirs.some((d) => v.replace(/^\/+/, '').includes(`${d}/`));
  // Texts known to change the page when marked, by source, path and value.
  const unsafe = new Set();
  const keyOf = (t) => JSON.stringify([t.source, t.path, t.value]);

  function draw(content, slug) {
    const page = content.pages.find((p) => p.slug === slug);
    const ctx = createContext({ site, theme, content, media, now: now(), preview: true }).for(page);
    // Each section of the page between comments, so the editor knows which elements it rendered.
    const blocks = ctx.blocks;
    ctx.blocks = (sections) => (sections !== page.sections ? blocks(sections)
      : raw((sections ?? []).map((s, i) => `<!--werft-section:${i}-->${blocks([s]).value}<!--/werft-section-->`).join('')));
    return theme.renderPage(page, ctx).value;
  }

  return function render(content, slug) {
    const texts = [];
    const images = [];
    for (const source of sourcesOf(content, slug)) {
      const root = rootOf(content, source);
      if (root) collect(root, source, [], editable(source) ? texts : [], images, isMedia);
    }
    texts.forEach((t, id) => { t.id = id; });
    images.forEach((t, id) => { t.id = id; });
    const plain = draw(content, slug);
    const drawMarked = (ids) => {
      const copy = structuredClone(content);
      for (const id of ids) setAt(rootOf(copy, texts[id].source), texts[id].path, mark(id, texts[id].value));
      return draw(copy, slug);
    };
    // Marks as many texts as possible: a group whose markers change nothing beyond themselves is
    // kept, a group that does is split until the texts at fault are found.
    let accepted = [];
    let best = plain;
    const tryGroup = (ids) => {
      if (!ids.length) return;
      let out;
      try { out = drawMarked([...accepted, ...ids]); } catch { out = null; }
      if (out !== null && unmark(out) === plain) { accepted = [...accepted, ...ids]; best = out; return; }
      if (ids.length === 1) { unsafe.add(keyOf(texts[ids[0]])); return; }
      tryGroup(ids.slice(0, ids.length >> 1));
      tryGroup(ids.slice(ids.length >> 1));
    };
    tryGroup(texts.filter((t) => !unsafe.has(keyOf(t))).map((t) => t.id));
    const marked = new Set(accepted);
    return { html: best, texts: texts.filter((t) => marked.has(t.id)), all: texts, images };
  };
}

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
// Elements whose text cannot hold other elements.
const RAW_TEXT = new Set(['title', 'textarea', 'script', 'style', 'option', 'noscript']);

// The text of an element as stored: line breaks become newlines.
export function textOf(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out += child.data;
    else if (child.localName === 'br') out += '\n';
    else if (child.nodeType === 1) out += textOf(child);
  }
  return out;
}
const squash = (s) => s.replace(/\s+/g, ' ').trim();

function ancestorOf(a, b) {
  const seen = new Set();
  for (let n = a; n; n = n.parentNode) seen.add(n);
  for (let n = b; n; n = n.parentNode) if (seen.has(n)) return n;
  return null;
}

const blank = (n) => (n.nodeType === 3 && !n.data.trim()) || n.nodeType === 8;

// Finds the marked texts, sections, list items and images in a live document and removes the
// markers. Returns lookups from ids to elements; the elements also carry data-werft-* attributes.
export function mapDocument(doc, { texts, images }) {
  const byId = new Map(texts.map((t) => [t.id, t]));
  const fields = new Map(); // text id → [{ el, plain }] or [{ parts: [el…] }]
  const attributes = new Map(); // text id → [{ el, name }]
  const push = (map, id, entry) => { if (!map.has(id)) map.set(id, []); map.get(id).push(entry); };

  for (const el of doc.querySelectorAll('*')) {
    for (const { name, value } of [...el.attributes]) {
      if (!ANY.test(value)) continue;
      for (const m of value.matchAll(OPENING)) push(attributes, decode(m[1]), { el, name });
      el.setAttribute(name, unmark(value));
    }
  }

  const walker = doc.createTreeWalker(doc.documentElement, 4);
  const marked = [];
  while (walker.nextNode()) if (ANY.test(walker.currentNode.data)) marked.push(walker.currentNode);
  for (const node of marked) {
    if (!doc.body?.contains(node) || RAW_TEXT.has(node.parentNode.localName)) { node.data = unmark(node.data); continue; }
    const pieces = [];
    let last = 0;
    for (const m of node.data.matchAll(MARK)) {
      pieces.push(node.data.slice(last, m.index));
      const boundary = doc.createElement('werft-mark');
      if (m[1]) boundary.dataset.open = decode(m[1]);
      pieces.push(boundary);
      last = m.index + m[0].length;
    }
    pieces.push(node.data.slice(last));
    node.replaceWith(...pieces.filter((p) => p !== ''));
  }

  const stack = [];
  for (const boundary of [...doc.querySelectorAll('werft-mark')]) {
    if (boundary.dataset.open) { stack.push(boundary); continue; }
    const open = stack.pop();
    if (!open) continue;
    const id = Number(open.dataset.open);
    const text = byId.get(id);
    if (!text) continue;
    const parent = ancestorOf(open, boundary);
    const top = (n) => { while (n.parentNode !== parent) n = n.parentNode; return n; };
    const first = top(open);
    const lastNode = top(boundary);
    const inside = [];
    for (let n = first; n; n = n.nextSibling) { inside.push(n); if (n === lastNode) break; }
    const content = inside.filter((n) => n.localName !== 'werft-mark');
    const outside = [...parent.childNodes].filter((n) => !inside.includes(n) && !blank(n));
    if (!outside.length && parent !== doc.body) {
      parent.dataset.werftField = id;
      push(fields, id, { el: parent });
    } else if (content.some((n) => n.nodeType === 1 && BLOCK.has(n.localName))) {
      const parts = content.filter((n) => n.nodeType === 1);
      parts.forEach((el) => { el.dataset.werftPart = id; });
      if (parts.length) push(fields, id, { parts });
    } else if (content.length) {
      const span = doc.createElement('span');
      span.dataset.werftField = id;
      first.before(span);
      span.append(...content);
      push(fields, id, { el: span });
    }
  }
  doc.querySelectorAll('werft-mark').forEach((m) => m.remove());
  doc.body?.normalize();
  for (const [id, list] of fields) {
    for (const entry of list) if (entry.el) entry.plain = squash(textOf(entry.el)) === squash(byId.get(id).value);
  }

  // Sections: the top-level nodes between the comments around each section.
  const sections = new Map();
  const comments = doc.createTreeWalker(doc.body ?? doc.documentElement, 128);
  const starts = [];
  while (comments.nextNode()) if (comments.currentNode.data.startsWith('werft-section:')) starts.push(comments.currentNode);
  for (const start of starts) {
    const index = Number(start.data.slice(14));
    const els = [];
    for (let n = start.nextSibling; n && !(n.nodeType === 8 && n.data === '/werft-section'); n = n.nextSibling) {
      if (n.nodeType === 1) { n.dataset.werftSection = index; els.push(n); }
    }
    sections.set(index, els);
  }

  // Images: matched through their alternative text when the theme writes it, else by file name.
  const imageEls = new Map();
  const candidates = [...(doc.body?.querySelectorAll('img, source, [style*="url("]') ?? [])];
  for (const image of images) {
    const altPath = JSON.stringify([...image.path.slice(0, -1), 'alt']);
    const alt = texts.find((t) => t.source === image.source && JSON.stringify(t.path) === altPath);
    let els = (alt && attributes.get(alt.id)?.filter((a) => a.name === 'alt').map((a) => a.el)) ?? [];
    if (!els.length) {
      const file = image.value.replace(/^\/+/, '');
      els = candidates.filter((el) => [el.getAttribute('src'), el.getAttribute('srcset'), el.getAttribute('style')].some((v) => v?.includes(file)));
    }
    els.forEach((el) => { el.dataset.werftImage = image.id; });
    if (els.length) imageEls.set(image.id, els);
  }

  // List items: the smallest element holding everything one item shows and nothing of its siblings.
  const elementsOf = new Map(); // "source|item path" → elements
  const addTo = (source, path, els) => {
    for (let i = 1; i < path.length; i++) {
      if (typeof path[i] !== 'number' || (i === 1 && path[0] === 'sections')) continue;
      const key = `${source}|${JSON.stringify(path.slice(0, i + 1))}`;
      if (!elementsOf.has(key)) elementsOf.set(key, []);
      elementsOf.get(key).push(...els);
    }
  };
  for (const [id, list] of fields) addTo(byId.get(id).source, byId.get(id).path, list.flatMap((e) => e.parts ?? [e.el]));
  for (const [id, list] of attributes) if (byId.get(id)) addTo(byId.get(id).source, byId.get(id).path, list.map((a) => a.el).filter((el) => doc.body?.contains(el)));
  for (const [id, els] of imageEls) addTo(images[id].source, images[id].path, els);
  const items = new Map();
  for (const [key, els] of elementsOf) {
    if (!els.length) continue;
    let el = els.reduce((a, b) => ancestorOf(a, b));
    if (el.nodeType !== 1 || el === doc.body || el.dataset.werftSection !== undefined) continue;
    const [source, json] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    const path = JSON.parse(json);
    const siblingKey = (k) => k !== key && k.startsWith(`${source}|${JSON.stringify(path.slice(0, -1)).slice(0, -1)},`) && JSON.parse(k.slice(source.length + 1)).length === path.length;
    const others = [...elementsOf].filter(([k]) => siblingKey(k)).flatMap(([, list]) => list);
    if (others.some((o) => el.contains(o) || o.contains(el))) continue;
    while (el.parentElement && el.parentElement !== doc.body && el.parentElement.children.length === 1
      && el.parentElement.dataset.werftSection === undefined && !others.some((o) => el.parentElement.contains(o))) el = el.parentElement;
    el.dataset.werftItem = key;
    items.set(key, { el, source, path });
  }

  return { fields, attributes, sections, images: imageEls, items };
}
