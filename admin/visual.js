// The visual editor: each page as the site will publish it, edited where it appears. Texts are
// changed on the page, images replaced by clicking them, sections and list entries added, moved
// and removed once the layout is unlocked. Changes stay in the browser until "Speichern", which
// stores every changed file in one commit through the gateway, as the CMS does.
import { cmsConfig } from 'werft/cms-config';
import { createContext, mediaPaths, markdown, raw, imageSize } from 'werft';
import { requireUser, loadSite, api, signOut } from './session.js';
import { disarm } from './preview.js';
import { pageRenderer, mapDocument, getAt, setAt, textOf } from './visual-map.js';
import { buildForm, emptyValue } from './visual-form.js';
import { toMarkdown, formatBar } from './visual-rich.js';

const REPO = '/api/v1/repos/werft/site';
const { site, theme, base } = await loadSite();
const me = await requireUser(site.name);
const { branch } = await api('/status');
const contentDir = site.contentDir ?? site.content ?? 'content';
const mediaDir = site.mediaDirs?.[0] ?? 'assets/img';
const siteURL = new URL(base, location.origin).href;
const can = (kind) => (me.editable ?? []).includes(kind);
const schema = cmsConfig({ site, theme, origin: location.origin, branch, editable: me.editable, statuses: me.statuses });
const collection = (name) => schema.collections.find((c) => c.name === name);
const settingsFile = (name) => collection('settings')?.files.find((f) => f.name === name);
const postType = theme.postType;

const $ = (selector) => document.querySelector(selector);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
};
const button = (text, title, onClick, className = 've-tool') => {
  const b = el('button', { type: 'button', className, title: title ?? '' }, text);
  if (title) b.setAttribute('aria-label', title);
  b.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); onClick(event); });
  return b;
};

// ---- Content: every JSON file of the content directory, as stored and as edited ----
const files = new Map(); // path → { sha, saved: text | null, data: object | null }
const canon = (data) => JSON.stringify(data);
const fileText = (data) => `${JSON.stringify(data, null, 2)}\n`;
const decodeBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
function encodeBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

const { tree } = await api(`${REPO}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
const contentPaths = tree.map((e) => e.path).filter((p) => p.startsWith(`${contentDir}/`) && p.endsWith('.json'));
for (const f of (await api(`${REPO}/file-contents?ref=${encodeURIComponent(branch)}`, { method: 'POST', body: { files: contentPaths } })).filter(Boolean)) {
  const text = decodeBase64(f.content);
  files.set(f.path, { sha: f.sha, saved: canon(JSON.parse(text)), data: JSON.parse(text) });
}
const media = await fetch(`${base}_werft/media.json`).then((r) => (r.ok ? r.json() : {}), () => ({}));
const uploads = new Map(); // site-relative path → { base64, url }

const FOLDERS = { page: 'pages', pattern: 'patterns', form: 'forms', post: postType?.name };
function fileOf(source) {
  const [kind, slug] = source.split(':');
  if (kind === 'settings') return `${contentDir}/settings/site.json`;
  if (kind === 'menus') return `${contentDir}/settings/menus.json`;
  return `${contentDir}/${FOLDERS[kind]}/${slug}.json`;
}
function dataOf(source) {
  const path = fileOf(source);
  if (!files.has(path)) files.set(path, { sha: null, saved: null, data: ['settings', 'menus'].includes(source) ? {} : null });
  return files.get(path).data;
}
const slugsIn = (folder) => [...files].filter(([p, f]) => f.data && p.startsWith(`${contentDir}/${folder}/`)).map(([p]) => p.split('/').pop().replace(/\.json$/, ''));

// The content as the theme sees it.
function content() {
  const revive = mediaPaths(site);
  const copy = (data) => JSON.parse(JSON.stringify(data), revive);
  const folder = (name) => (name ? slugsIn(name).sort().map((slug) => ({ ...copy(files.get(`${contentDir}/${name}/${slug}.json`).data), slug })) : []);
  const one = (name, fallback) => (files.get(`${contentDir}/settings/${name}.json`)?.data ? copy(files.get(`${contentDir}/settings/${name}.json`).data) : fallback);
  return {
    pages: folder('pages'), posts: folder(postType?.name), patterns: folder('patterns'), forms: folder('forms'),
    settings: one('site', {}), menus: one('menus', {}), redirects: one('redirects', { redirects: [] }).redirects ?? [],
  };
}

const changedPaths = () => [...files].filter(([, f]) => (f.data === null ? f.saved !== null : canon(f.data) !== f.saved)).map(([p]) => p);
const isDirty = () => changedPaths().length > 0 || [...uploads.values()].some((u) => !u.saved);

// ---- Schema: the field definitions the CMS uses, looked up by path ----
function topFields(source) {
  const kind = source.split(':')[0];
  if (kind === 'page') return collection('pages')?.fields;
  if (kind === 'pattern') return collection('patterns')?.fields;
  if (kind === 'form') return collection('forms')?.fields;
  if (kind === 'post') return collection(postType?.name)?.fields;
  return settingsFile(kind === 'settings' ? 'site' : 'menus')?.fields;
}
function schemaAt(source, path) {
  let node = { widget: 'object', fields: topFields(source) ?? [], label: sourceLabel(source) };
  const root = dataOf(source);
  for (let i = 0; i < path.length && node; i++) {
    const key = path[i];
    if (typeof key === 'number') {
      if (node.widget !== 'list') return null;
      if (node.types) {
        const item = getAt(root, path.slice(0, i + 1));
        const type = node.types.find((t) => t.name === item?.[node.typeKey ?? 'type']);
        node = type && { widget: 'object', fields: type.fields, label: type.label };
      } else if (node.field) node = node.field;
      else node = { widget: 'object', fields: node.fields, label: node.label };
    } else node = node.fields?.find((f) => f.name === key) ?? null;
  }
  return node;
}
function sourceLabel(source) {
  const [kind, slug] = source.split(':');
  if (kind === 'pattern') return `Muster „${dataOf(source)?.title ?? slug}“`;
  if (kind === 'settings') return 'Website';
  if (kind === 'menus') return 'Menüs';
  if (kind === 'form') return `Formular „${dataOf(source)?.title ?? slug}“`;
  if (kind === 'post') return `${postType?.singular ?? 'Beitrag'} „${dataOf(source)?.title ?? slug}“`;
  return 'Seite';
}
const sharedNote = (source) => ({
  pattern: 'Erscheint auf mehreren Seiten: Änderungen wirken überall.',
  settings: 'Website-Einstellung: Änderungen wirken auf allen Seiten.',
  menus: 'Menü: Änderungen wirken auf allen Seiten.',
  form: 'Formular: Änderungen wirken überall, wo es erscheint.',
})[source.split(':')[0]];

// ---- Editor state ----
let current = slugsIn('pages').includes('index') ? 'index' : slugsIn('pages')[0];
let editing = false;
let locked = true;
let device = 'desktop';
let model = null; // what the page shows where: mapDocument's lookups plus texts and images
let hover = {};
let selected = null; // section index
let active = null; // { el, source, path, mode }
const undoStack = [];
const redoStack = [];

const snapshot = () => JSON.stringify([...files].map(([p, f]) => [p, f.data]));
function restore(snap) {
  const data = new Map(JSON.parse(snap));
  for (const [path, f] of [...files]) {
    if (data.has(path)) f.data = data.get(path);
    else if (f.saved === null) files.delete(path);
    else f.data = null;
  }
  for (const [path, d] of data) if (!files.has(path)) files.set(path, { sha: null, saved: null, data: d });
}
function checkpoint() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}
// A change made by a toolbar or dialog: one undo step, then the page is drawn again.
function change(fn) {
  checkpoint();
  fn();
  closePanel();
  draw();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  closePanel();
  draw();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  closePanel();
  draw();
}

// ---- Page frame ----
const frame = $('#ve-frame');
await new Promise((resolve) => { frame.addEventListener('load', resolve, { once: true }); frame.srcdoc = '<!doctype html><html><head></head><body></body></html>'; });
const doc = frame.contentDocument;
const win = frame.contentWindow;
const baseEl = Object.assign(doc.createElement('base'), { href: siteURL });
const frameStyle = doc.createElement('style');
frameStyle.textContent = `html.ve-editing [data-werft-field][contenteditable]{cursor:text;outline:none}
  html.ve-editing a,html.ve-editing button,html.ve-editing summary{cursor:default}
  html.ve-editing [data-werft-image],html.ve-editing [data-werft-part]{cursor:pointer}
  [contenteditable]:empty::before{content:"…";opacity:.4}`;
for (const node of [baseEl, frameStyle]) node.dataset.ve = '';

const PLAIN = (() => { const d = document.createElement('div'); d.contentEditable = 'plaintext-only'; return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; })();
const mediaURL = (value) => {
  const path = String(value).replace(/^\/+/, '').replace(base.slice(1), '');
  return uploads.get(path)?.url ?? new URL(path, siteURL).href;
};

const renderer = pageRenderer({
  site, theme, media,
  editable: (source) => ({ settings: can('settings'), menus: can('structure') })[source] ?? can('content'),
});

function draw() {
  const pageList = slugsIn('pages');
  if (!pageList.includes(current)) current = pageList.includes('index') ? 'index' : pageList[0];
  const result = renderer(content(), current);
  const parsed = new DOMParser().parseFromString(result.html, 'text/html');
  // Nothing of the page runs in the editor: no scripts, handlers, redirects or frames.
  parsed.querySelectorAll('script, noscript, base, meta[http-equiv], iframe, object, embed').forEach((n) => n.remove());
  disarm(parsed);
  // Files uploaded but not saved yet come from the browser's copy.
  const pending = [...uploads].filter(([, u]) => !u.saved).map(([path, u]) => [new URL(path, siteURL).href, u.url, path]);
  if (pending.length) {
    for (const node of parsed.querySelectorAll('[src], [srcset]')) {
      const src = node.getAttribute('src');
      const upload = src && pending.find(([href]) => href === new URL(src, siteURL).href);
      if (upload) node.setAttribute('src', upload[1]);
      if (pending.some(([, , path]) => node.getAttribute('srcset')?.includes(path))) node.removeAttribute('srcset');
    }
  }
  const scroll = win.scrollY;
  // Head elements that did not change stay where they are: a stylesheet that is moved loads again,
  // and until it has, the page is unstyled (it flashes, and sections are measured in wrong places).
  const kept = new Map([...doc.head.children].filter((n) => !n.dataset.ve).map((n) => [n.outerHTML, n]));
  const nodes = [...parsed.head.children].map((n) => {
    const node = kept.get(n.outerHTML);
    kept.delete(n.outerHTML);
    return node ?? doc.importNode(n, true);
  });
  kept.forEach((n) => n.remove());
  if (!baseEl.isConnected) doc.head.prepend(baseEl);
  let at = baseEl;
  for (const node of nodes) {
    if (at.nextElementSibling !== node) at.after(node);
    at = node;
  }
  if (!frameStyle.isConnected) doc.head.append(frameStyle);
  doc.documentElement.lang = parsed.documentElement.lang;
  doc.body.replaceWith(doc.importNode(parsed.body, true));
  model = { ...mapDocument(doc, result), texts: new Map(result.texts.map((t) => [t.id, t])), imageList: result.images };
  win.scrollTo(0, scroll);
  hover = {};
  active = null;
  applyMode();
  drawBar();
  drawPages();
}

// How a text is edited: in place as plain text, in place as rich text, or in a small dialog.
function modeOf(text, entry) {
  if (!entry.el) return 'dialog';
  const def = schemaAt(text.source, text.path);
  const block = entry.el.dataset.werftField !== undefined && entry.el.localName !== 'span' && !/^(a|button|label)$/.test(entry.el.localName);
  if (def?.widget === 'richtext' && block) return 'rich';
  return entry.plain ? 'plain' : 'dialog';
}

function applyMode() {
  doc.documentElement.classList.toggle('ve-editing', editing);
  for (const [id, entries] of model.fields) {
    const text = model.texts.get(id);
    for (const entry of entries) {
      if (!entry.el) continue;
      const mode = modeOf(text, entry);
      if (editing && mode !== 'dialog') entry.el.contentEditable = mode === 'rich' ? 'true' : PLAIN;
      else entry.el.removeAttribute('contenteditable');
      entry.el.spellcheck = true;
    }
  }
  paint();
}

const fieldOf = (node) => node?.closest?.('[data-werft-field]');
const textFor = (node) => model.texts.get(Number(node.dataset.werftField ?? node.dataset.werftPart));
const entryFor = (node) => model.fields.get(Number(node.dataset.werftField))?.find((e) => e.el === node);
const sectionOf = (node) => { const s = node?.closest?.('[data-werft-section]'); return s ? Number(s.dataset.werftSection) : null; };
const itemOf = (node) => { const i = node?.closest?.('[data-werft-item]'); return i ? model.items.get(i.dataset.werftItem) : null; };

// Writes a text into the content and into its other places on the page.
let typed = false;
function setText(text, value, except) {
  setAt(dataOf(text.source), text.path, value);
  text.value = value;
  for (const entry of model.fields.get(text.id) ?? []) {
    if (!entry.el || entry.el === except || !entry.plain) continue;
    entry.el.replaceChildren(...value.split('\n').flatMap((line, i) => (i ? [doc.createElement('br'), line] : [line])));
  }
  drawBar();
}

doc.addEventListener('focusin', (event) => {
  const node = fieldOf(event.target);
  if (!editing || !node?.isContentEditable) return;
  const text = textFor(node);
  active = { el: node, source: text.source, path: text.path, mode: modeOf(text, entryFor(node)), started: false };
  paint();
});
doc.addEventListener('input', (event) => {
  const node = fieldOf(event.target);
  if (!active || node !== active.el) return;
  if (!active.started) { checkpoint(); active.started = true; }
  const text = textFor(node);
  let value;
  if (active.mode === 'rich') value = toMarkdown(node);
  else {
    value = textOf(node).replace(/ /g, ' ').replace(/\n$/, '');
    if (schemaAt(text.source, text.path)?.widget !== 'text') value = value.replace(/\n/g, ' ');
  }
  setText(text, value, node);
  typed = true;
  paint();
});
doc.addEventListener('keydown', (event) => {
  const node = fieldOf(event.target);
  if (node && active?.el === node) {
    const multi = active.mode === 'rich' || schemaAt(active.source, active.path)?.widget === 'text';
    if (event.key === 'Escape' || (event.key === 'Enter' && !multi && !event.shiftKey)) { event.preventDefault(); node.blur(); return; }
  }
  shortcuts(event, !!node);
});
doc.addEventListener('paste', (event) => {
  if (active?.mode !== 'rich') return;
  event.preventDefault();
  doc.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
});
// After typing, the page is drawn again once nothing is edited, so the theme shows the new text
// everywhere and drops empty parts.
doc.addEventListener('focusout', () => {
  setTimeout(() => {
    if (fieldOf(doc.activeElement)?.isContentEditable) return;
    active = null;
    if (typed) { typed = false; draw(); } else paint();
  }, 150);
});

doc.addEventListener('mousemove', (event) => {
  const t = event.target;
  const next = {
    section: sectionOf(t), item: itemOf(t),
    field: editing ? (fieldOf(t) ?? t.closest?.('[data-werft-part]')) : null,
    image: editing ? t.closest?.('[data-werft-image]') : null,
  };
  if (next.section !== hover.section || next.item !== hover.item || next.field !== hover.field || next.image !== hover.image) { hover = next; paint(); }
});
win.addEventListener('scroll', () => paint(), { passive: true });
win.addEventListener('resize', () => paint());
doc.addEventListener('submit', (event) => event.preventDefault(), true);
doc.addEventListener('click', (event) => {
  const t = event.target;
  const link = t.closest?.('a[href]');
  if (!editing) {
    if (!link) return;
    event.preventDefault();
    const slug = pageOfURL(link.href);
    if (slug) openPage(slug);
    else if (link.hash && new URL(link.href).pathname === new URL(siteURL).pathname + (current === 'index' ? '' : `${current}.html`)) doc.querySelector(link.hash)?.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  if (t.closest?.('a, button, label, summary')) event.preventDefault();
  const image = t.closest?.('[data-werft-image]');
  const field = fieldOf(t);
  const part = t.closest?.('[data-werft-part]');
  if (field?.isContentEditable) return;
  if (image && !field) { openImage(image); return; }
  if (field || part) { openTextDialog(textFor(field ?? part), field ?? part); return; }
  const index = sectionOf(t);
  selected = index;
  paint();
}, true);

function pageOfURL(href) {
  const url = new URL(href, siteURL);
  const root = new URL(siteURL);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return null;
  const rest = decodeURIComponent(url.pathname.slice(root.pathname.length));
  const slug = rest === '' ? 'index' : rest.replace(/\.html$/, '');
  return slug !== current && slugsIn('pages').includes(slug) ? slug : null;
}

// ---- Overlay: outlines and tool bars over the page frame ----
const overlay = $('#ve-overlay');
let painting = false;
function paint() {
  if (painting) return;
  painting = true;
  requestAnimationFrame(() => { painting = false; paintNow(); });
}
function rectOf(els) {
  const rects = els.filter((n) => n?.isConnected).map((n) => n.getBoundingClientRect()).filter((r) => r.width || r.height);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  return { left, top, width: Math.max(...rects.map((r) => r.right)) - left, height: Math.max(...rects.map((r) => r.bottom)) - top };
}
function box(rect, className) {
  const node = el('div', { className: `ve-box ${className}` });
  Object.assign(node.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  return node;
}
function place(node, x, y) {
  node.style.left = `${Math.max(4, Math.min(x, overlay.clientWidth - node.offsetWidth - 4))}px`;
  node.style.top = `${Math.max(4, Math.min(y, overlay.clientHeight - node.offsetHeight - 4))}px`;
}

const pageData = () => dataOf(`page:${current}`);

function paintNow() {
  overlay.replaceChildren();
  if (!model) return;
  const page = pageData();
  if (editing && !page.sections?.length) {
    // The empty page gets room where its sections will be.
    const main = doc.querySelector('main') ?? doc.body;
    main.style.minHeight = '320px';
    const rect = rectOf([main]);
    const empty = box(rect, 've-empty');
    empty.append(el('p', {}, 'Diese Seite hat noch keine Abschnitte.'), button('+ Abschnitt hinzufügen', null, () => addSection(0), 've-primary'));
    overlay.append(empty);
  }
  if (!editing) return;

  const index = hover.section ?? selected;
  const sectionRect = index != null && rectOf(model.sections.get(index) ?? []);
  if (sectionRect) {
    const section = page.sections[index];
    const def = schemaAt(`page:${current}`, ['sections', index]);
    overlay.append(box(sectionRect, 've-section'));
    const chip = el('div', { className: 've-chip' }, section.type === 'pattern' ? sourceLabel(`pattern:${section.pattern}`) : (def?.label ?? section.type));
    overlay.append(chip);
    place(chip, sectionRect.left + 8, sectionRect.top + 8);
    const bar = el('div', { className: 've-bar ve-section-bar' });
    bar.append(button('✎ Abschnitt bearbeiten', null, () => openSectionPanel(index), 've-tool ve-wide'));
    if (!locked) {
      const row = el('div', { className: 've-row' },
        button('⧉', 'Duplizieren', () => sectionTo(index + 1, () => page.sections.splice(index + 1, 0, structuredClone(page.sections[index])))),
        button('↑', 'Nach oben', () => sectionTo(index - 1, () => page.sections.splice(index - 1, 0, ...page.sections.splice(index, 1)))),
        button('↓', 'Nach unten', () => sectionTo(index + 1, () => page.sections.splice(index + 1, 0, ...page.sections.splice(index, 1)))));
      row.children[1].disabled = index === 0;
      row.children[2].disabled = index === page.sections.length - 1;
      bar.append(row, button('Entfernen', null, () => confirmDialog('Abschnitt entfernen?', 'Der Abschnitt verschwindet von dieser Seite. Mit „Rückgängig“ oder ohne Speichern kommt er zurück.', 'Entfernen')
        .then((ok) => ok && change(() => { page.sections.splice(index, 1); selected = null; })), 've-tool ve-wide ve-danger'));
      for (const [where, at] of [['top', index], ['bottom', index + 1]]) {
        const add = button('+ Abschnitt hinzufügen', null, () => addSection(at), 've-add');
        overlay.append(add);
        place(add, sectionRect.left + sectionRect.width / 2 - add.offsetWidth / 2, (where === 'top' ? sectionRect.top : sectionRect.top + sectionRect.height) - add.offsetHeight / 2);
      }
    }
    overlay.append(bar);
    place(bar, sectionRect.left + sectionRect.width - bar.offsetWidth - 12, Math.max(sectionRect.top + 12, 12));
  }

  // A list entry, when the layout may be changed.
  const item = hover.item;
  if (!locked && item?.el.isConnected) {
    const rect = rectOf([item.el]);
    const list = getAt(dataOf(item.source), item.path.slice(0, -1));
    const i = item.path.at(-1);
    if (rect && Array.isArray(list)) {
      overlay.append(box(rect, 've-item'));
      const bar = el('div', { className: 've-bar ve-item-bar' },
        button('↑', 'Eintrag nach vorn', () => change(() => list.splice(i - 1, 0, ...list.splice(i, 1)))),
        button('↓', 'Eintrag nach hinten', () => change(() => list.splice(i + 1, 0, ...list.splice(i, 1)))),
        button('⧉', 'Eintrag duplizieren', () => change(() => list.splice(i + 1, 0, structuredClone(list[i])))),
        button('✕', 'Eintrag entfernen', () => change(() => list.splice(i, 1)), 've-tool ve-danger'));
      bar.children[0].disabled = i === 0;
      bar.children[1].disabled = i === list.length - 1;
      overlay.append(bar);
      place(bar, rect.left + rect.width - bar.offsetWidth, rect.top - bar.offsetHeight - 4);
    }
  }

  if (hover.image && hover.image !== active?.el) {
    const rect = rectOf([hover.image]);
    if (rect) {
      overlay.append(box(rect, 've-image'));
      const tag = el('div', { className: 've-chip ve-image-chip' }, 'Klicken: Bild ändern');
      overlay.append(tag);
      place(tag, rect.left + 8, rect.top + rect.height - 34);
    }
  }
  if (hover.field && hover.field !== active?.el) {
    const part = hover.field.dataset.werftPart;
    const rect = rectOf(part !== undefined ? [...doc.querySelectorAll(`[data-werft-part="${part}"]`)] : [hover.field]);
    if (rect) overlay.append(box(rect, 've-field'));
  }
  if (active?.el.isConnected) {
    const rect = rectOf([active.el]);
    if (rect) {
      overlay.append(box(rect, 've-active'));
      const def = schemaAt(active.source, active.path);
      const owner = ownerOf(active.source, active.path);
      // A text of a part within a section (a link, an entry) is named with that part.
      const inPart = owner && owner.path.length > (/^(page|pattern):/.test(active.source) ? 2 : 0);
      const bar = el('div', { className: 've-bar ve-field-bar' }, el('span', { className: 've-field-label' }, `${inPart ? `${owner.label} · ` : ''}${def?.label ?? 'Text'}`));
      if (active.mode === 'rich') bar.append(formatBar(doc, () => active.el.dispatchEvent(new Event('input', { bubbles: true }))));
      if (owner) bar.append(button('Optionen', `${owner.label} bearbeiten`, () => openPanel(owner.title, owner.source, owner.path)));
      const note = sharedNote(active.source);
      if (note) bar.append(el('span', { className: 've-note' }, note));
      overlay.append(bar);
      place(bar, rect.left, rect.top - bar.offsetHeight - 6 < 0 ? rect.top + rect.height + 6 : rect.top - bar.offsetHeight - 6);
    }
  }
}

// The object a text belongs to (a link, an image, a section), for its "Optionen".
function ownerOf(source, path) {
  let at = path.slice(0, -1);
  while (at.length && typeof at.at(-1) === 'number' && typeof getAt(dataOf(source), at) !== 'object') at = at.slice(0, -1);
  const def = schemaAt(source, at);
  if (!def?.fields?.length) return null;
  return { source, path: at, label: def.label ?? 'Abschnitt', title: def.label ?? sourceLabel(source) };
}

// ---- Side panel ----
const panel = $('#ve-panel');
function closePanel() { panel.hidden = true; panel.replaceChildren(); }
let drawSoon;
function openPanel(title, source, path, { fields, extra } = {}) {
  startEditing();
  const holder = path.length ? getAt(dataOf(source), path) : dataOf(source);
  const defs = fields ?? schemaAt(source, path)?.fields ?? [];
  const snapshotBefore = snapshot();
  let started = false;
  const form = buildForm(defs, holder, {
    onChange: () => {
      if (!started) { undoStack.push(snapshotBefore); redoStack.length = 0; started = true; }
      drawBar();
      clearTimeout(drawSoon);
      drawSoon = setTimeout(() => { const keep = panel.scrollTop; draw(); panel.scrollTop = keep; }, 300);
    },
    pickImage, mediaURL,
    suggest: (field) => (field.name === 'url' ? slugsIn('pages').map((slug) => ({ value: `${slug}.html`, label: files.get(`${contentDir}/pages/${slug}.json`).data.title ?? slug })) : []),
    choices: (name) => slugsIn(name).map((slug) => ({ label: files.get(`${contentDir}/${name}/${slug}.json`)?.data?.title ?? slug, value: slug })),
  });
  const note = sharedNote(source);
  panel.replaceChildren(
    el('header', {}, el('h2', {}, title), button('Fertig', null, closePanel, 've-primary')),
    ...(note ? [el('p', { className: 've-note' }, note)] : []),
    form, ...(extra ? [extra] : []));
  panel.hidden = false;
  panel.querySelector('input, textarea, select')?.focus();
}
function openSectionPanel(index) {
  const section = pageData().sections[index];
  const def = schemaAt(`page:${current}`, ['sections', index]);
  openPanel(def?.label ?? 'Abschnitt', `page:${current}`, ['sections', index]);
}

// A text that cannot be edited on the page (formatted parts, values the theme reworks).
function openTextDialog(text, node) {
  const def = schemaAt(text.source, text.path);
  const rich = def?.widget === 'richtext';
  const snapshotBefore = snapshot();
  let started = false;
  const save = (value) => {
    if (!started) { undoStack.push(snapshotBefore); redoStack.length = 0; started = true; }
    setAt(dataOf(text.source), text.path, value);
    clearTimeout(drawSoon);
    drawSoon = setTimeout(draw, 300);
    drawBar();
  };
  let editor;
  if (rich) {
    editor = el('div', { className: 've-rich', contentEditable: 'true' });
    editor.innerHTML = markdown(text.value);
    editor.addEventListener('input', () => save(toMarkdown(editor)));
    editor.addEventListener('paste', (event) => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); });
  } else {
    editor = el('textarea', { value: text.value, rows: 4 });
    editor.addEventListener('input', () => save(editor.value));
  }
  const owner = ownerOf(text.source, text.path);
  const note = sharedNote(text.source);
  panel.replaceChildren(
    el('header', {}, el('h2', {}, def?.label ?? 'Text'), button('Fertig', null, closePanel, 've-primary')),
    ...(note ? [el('p', { className: 've-note' }, note)] : []),
    ...(rich ? [formatBar(document, () => editor.dispatchEvent(new Event('input')))] : []),
    editor,
    ...(owner ? [el('p', {}, button(`Weitere Angaben: ${owner.label}`, null, () => openPanel(owner.title, owner.source, owner.path), 've-link'))] : []));
  panel.hidden = false;
  editor.focus();
}

// ---- Images ----
function openImage(node) {
  const image = model.imageList[Number(node.dataset.werftImage)];
  const holderPath = image.path.slice(0, -1);
  const holder = getAt(dataOf(image.source), holderPath);
  const key = image.path.at(-1);
  const preview = el('img', { className: 've-preview', src: mediaURL(holder[key]), alt: '' });
  const extra = el('div', { className: 've-image-panel' }, preview, button('Bild ändern', null, async () => {
    const picked = await pickImage(holder[key]);
    if (!picked) return;
    change(() => { holder[key] = picked; });
    openImage(doc.querySelector(`[data-werft-image="${image.id}"]`) ?? node);
  }, 've-primary'));
  const def = schemaAt(image.source, holderPath);
  const fields = (def?.widget === 'object' ? def.fields : []).filter((f) => f.name !== key && f.widget !== 'image');
  if (holder && !Array.isArray(holder) && fields.length) openPanel(def.label ?? 'Bild', image.source, holderPath, { fields, extra });
  else {
    panel.replaceChildren(el('header', {}, el('h2', {}, 'Bild'), button('Fertig', null, closePanel, 've-primary')), extra);
    panel.hidden = false;
  }
  panel.querySelector('header').after(extra);
}

// The site's images and an upload; resolves with the chosen file's address, or null.
function pickImage(current) {
  return new Promise((resolve) => {
    const dialog = $('#ve-media');
    const grid = dialog.querySelector('.ve-media-grid');
    const choose = (path) => {
      dialog.close();
      // Stored like the CMS stores a picked file, unless the content names its files relative to the site.
      resolve(current && !String(current).startsWith('/') ? path : `${base}${path}`);
    };
    const paths = [...new Set([...uploads.keys(), ...Object.keys(media).filter((p) => p.startsWith(`${mediaDir}/`))])];
    grid.replaceChildren(...paths.map((path) => {
      const b = button('', path.split('/').pop(), () => choose(path), 've-media-item');
      b.append(el('img', { src: mediaURL(path), alt: '', loading: 'lazy' }), el('span', {}, path.split('/').pop()));
      if (String(current ?? '').replace(/^\/+/, '').endsWith(path)) b.classList.add('ve-current');
      return b;
    }));
    const input = dialog.querySelector('input[type=file]');
    input.value = '';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stem = file.name.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
      let path = `${mediaDir}/${stem}`;
      for (let n = 2; path in media || uploads.has(path); n++) path = `${mediaDir}/${stem.replace(/(\.[^.]+)?$/, `-${n}$1`)}`;
      uploads.set(path, { base64: encodeBase64(bytes), url: URL.createObjectURL(file), saved: false });
      // The theme sees the new file as one of the site's images, with its size.
      media[path] = imageSize(bytes) ?? {};
      choose(path);
    };
    dialog.querySelector('.ve-cancel').onclick = () => { dialog.close(); resolve(null); };
    dialog.showModal();
  });
}

// A change to the page's sections that leaves the section at `index` selected and in view.
function sectionTo(index, fn) {
  change(fn);
  selected = index;
  const top = rectOf(model.sections.get(index) ?? [])?.top;
  if (top != null && (top < 0 || top > win.innerHeight - 80)) win.scrollBy({ top: top - 40, behavior: 'smooth' });
  paint();
}

// ---- Adding sections ----
// Each kind of section is offered with an example from the site itself, as it looks there.
function examples() {
  const found = new Map();
  for (const [path, f] of files) {
    if (!f.data?.sections || !(path.includes('/pages/') || path.includes('/patterns/'))) continue;
    for (const s of f.data.sections) if (s.type !== 'pattern' && !found.has(s.type)) found.set(s.type, s);
  }
  return found;
}
function sectionHTML(section) {
  const data = content();
  const page = { slug: current, title: '', sections: [JSON.parse(JSON.stringify(section), mediaPaths(site))] };
  data.pages = [...data.pages.filter((p) => p.slug !== current), page];
  const ctx = createContext({ site, theme, content: data, media, now: new Date(), preview: true }).for(page);
  const blocks = ctx.blocks;
  ctx.blocks = (sections) => (sections === page.sections ? raw(`<!--ve-->${blocks(sections).value}<!--/ve-->`) : blocks(sections));
  const out = new DOMParser().parseFromString(theme.renderPage(page, ctx).value, 'text/html');
  out.querySelectorAll('script').forEach((n) => n.remove());
  disarm(out);
  const body = out.body.innerHTML;
  const inner = body.slice(body.indexOf('<!--ve-->') + 9, body.indexOf('<!--/ve-->'));
  const styles = [...out.head.querySelectorAll('link[rel~="stylesheet"], style')].map((n) => n.outerHTML).join('');
  return `<!doctype html><html lang="${out.documentElement.lang}"><head><base href="${siteURL}">${styles}<style>html,body{overflow:hidden;pointer-events:none}</style></head><body class="${out.body.className}"><main>${inner}</main></body></html>`;
}
function addSection(at) {
  const dialog = $('#ve-sections');
  const grid = dialog.querySelector('.ve-section-grid');
  const found = examples();
  const insert = (section) => {
    dialog.close();
    sectionTo(at, () => pageData().sections.splice(at, 0, section));
  };
  const card = (label, section, note) => {
    const b = button('', label, () => insert(structuredClone(section)), 've-section-card');
    const thumb = el('div', { className: 've-thumb-frame' });
    let html = '';
    try { html = sectionHTML(section); } catch { /* a section without content cannot be shown */ }
    if (html) thumb.append(Object.assign(document.createElement('iframe'), { srcdoc: html, tabIndex: -1, loading: 'lazy', title: '' }));
    else thumb.append(el('span', {}, 'Leerer Abschnitt'));
    b.append(thumb, el('strong', {}, label), note ? el('small', {}, note) : null);
    return b;
  };
  const cards = Object.entries(theme.blocks).map(([type, block]) => {
    const example = found.get(type);
    const fields = schemaAt(`page:${current}`, []).fields?.find((f) => f.name === 'sections')?.types?.find((t) => t.name === type)?.fields ?? block.fields ?? [];
    return card(block.label ?? type, example ?? { type, ...emptyValue({ widget: 'object', fields }) }, example ? 'mit Beispielinhalt' : null);
  });
  const patterns = slugsIn('patterns').map((slug) => card(`Muster: ${files.get(`${contentDir}/patterns/${slug}.json`).data.title ?? slug}`, { type: 'pattern', pattern: slug }, 'auf mehreren Seiten gleich'));
  grid.replaceChildren(...cards, ...patterns);
  dialog.querySelector('.ve-cancel').onclick = () => dialog.close();
  dialog.showModal();
  for (const thumb of grid.querySelectorAll('.ve-thumb-frame')) thumb.style.setProperty('--ve-scale', thumb.clientWidth / 1200);
}

// ---- Dialogs ----
function confirmDialog(title, text, yes, { other } = {}) {
  const dialog = $('#ve-confirm');
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('p').textContent = text;
  const actions = dialog.querySelector('.ve-actions');
  actions.replaceChildren(
    ...(other ? [el('button', { value: 'other', className: 've-tool' }, other)] : []),
    el('button', { value: 'yes', className: yes === 'Entfernen' || yes === 'Verwerfen' || yes === 'Löschen' ? 've-primary ve-danger' : 've-primary' }, yes),
    el('button', { value: 'cancel', className: 've-tool', autofocus: true }, 'Abbrechen'));
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes' ? true : dialog.returnValue === 'other' ? 'other' : false), { once: true }));
}
function promptDialog(title, label, value = '') {
  const dialog = $('#ve-prompt');
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('label span').textContent = label;
  const input = dialog.querySelector('input');
  input.value = value;
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' && input.value.trim() ? input.value.trim() : null), { once: true }));
}

function startEditing() {
  if (editing) return;
  editing = true;
  selected = null;
  applyMode();
  drawBar();
}

// ---- Top bar ----
const STATUS = { draft: 'Entwurf', pending: 'Zur Prüfung', published: 'Veröffentlicht' };
const statusOf = (entry) => {
  const status = entry?.status ?? 'published';
  return status === 'published' && entry?.publish_date && Date.parse(entry.publish_date) > Date.now() ? 'Geplant' : STATUS[status] ?? status;
};
const pageURL = (slug) => `${siteURL}${slug === 'index' ? '' : `${slug}.html`}`;

function drawBar() {
  const bar = $('#ve-top');
  const page = pageData();
  const left = el('div', { className: 've-top-left' });
  if (editing) {
    const saveButton = button('Speichern', 'Speichern (Strg+S)', save, 've-primary');
    saveButton.disabled = !isDirty();
    const undoButton = button('↶', 'Rückgängig (Strg+Z)', undo);
    const redoButton = button('↷', 'Wiederholen (Strg+Umschalt+Z)', redo);
    undoButton.disabled = !undoStack.length;
    redoButton.disabled = !redoStack.length;
    left.append(saveButton, button('Beenden', null, finish, 've-tool'), undoButton, redoButton);
  } else left.append(button('Bearbeiten', null, startEditing, 've-primary'));
  const center = el('div', { className: 've-top-center' }, el('strong', {}, page?.title ?? current), el('span', {}, `Seite · ${statusOf(page)}${isDirty() ? ' · ungespeicherte Änderungen' : ''}`));
  const right = el('div', { className: 've-top-right' });
  if (editing) {
    const lock = button(locked ? 'Layout gesperrt' : 'Layout entsperrt', locked ? 'Entsperren, um Abschnitte und Einträge hinzuzufügen, zu verschieben und zu entfernen' : 'Sperren: nur Texte und Bilder ändern', () => { locked = !locked; drawBar(); paint(); }, `ve-tool ve-lock${locked ? '' : ' ve-unlocked'}`);
    lock.setAttribute('aria-pressed', String(!locked));
    right.append(lock);
  }
  const devices = el('div', { className: 've-devices', role: 'group' });
  for (const [name, icon, label] of [['desktop', 'Desktop', 'Desktop-Ansicht'], ['mobile', 'Mobil', 'Mobile Ansicht']]) {
    const b = button(icon, label, () => { device = name; $('#ve-stage').dataset.device = name; drawBar(); setTimeout(paint, 50); }, `ve-tool${device === name ? ' ve-on' : ''}`);
    b.setAttribute('aria-pressed', String(device === name));
    devices.append(b);
  }
  right.append(devices, el('a', { href: pageURL(current), target: '_blank', rel: 'noopener', className: 've-tool', title: 'Veröffentlichte Seite in neuem Tab' }, 'Ansehen ↗'));
  bar.replaceChildren(left, center, right);
}

async function save() {
  const changes = [];
  for (const path of changedPaths()) {
    const f = files.get(path);
    if (f.data === null) changes.push({ operation: 'delete', path, sha: f.sha });
    else changes.push({ operation: f.saved === null ? 'create' : 'update', path, ...(f.sha && { sha: f.sha }), content: encodeBase64(new TextEncoder().encode(fileText(f.data))) });
  }
  for (const [path, u] of uploads) if (!u.saved) changes.push({ operation: 'create', path, content: u.base64 });
  if (!changes.length) return;
  const titles = changes.filter((c) => c.path.endsWith('.json')).map((c) => files.get(c.path)?.data?.title ?? c.path.split('/').pop().replace(/\.json$/, ''));
  toast('Wird gespeichert …');
  try {
    const result = await api(`${REPO}/contents`, { method: 'POST', body: { branch, message: `Visueller Editor: ${[...new Set(titles)].join(', ') || 'Bilder'}`, files: changes } });
    for (const [i, c] of changes.entries()) {
      if (uploads.has(c.path)) { uploads.get(c.path).saved = true; continue; }
      const f = files.get(c.path);
      if (c.operation === 'delete') files.delete(c.path);
      else { f.saved = canon(f.data); f.sha = result.files?.[i]?.sha ?? f.sha; }
    }
    toast('Gespeichert. Die Website wird neu erstellt.');
  } catch (error) {
    toast(error.status === 403 ? `Nicht erlaubt: ${error.message}` : `Speichern fehlgeschlagen: ${error.message}`, true);
  }
  drawBar();
  drawPages();
}

async function finish() {
  if (isDirty()) {
    const choice = await confirmDialog('Ohne Speichern beenden?', 'Alle nicht gespeicherten Änderungen werden verworfen.', 'Verwerfen', { other: 'Speichern' });
    if (!choice) return;
    if (choice === 'other') { await save(); if (isDirty()) return; } else {
      for (const [path, f] of [...files]) { if (f.saved === null) files.delete(path); else f.data = JSON.parse(f.saved); }
      for (const [path, u] of [...uploads]) if (!u.saved) { uploads.delete(path); delete media[path]; }
    }
  }
  undoStack.length = 0;
  redoStack.length = 0;
  editing = false;
  locked = true;
  closePanel();
  draw();
}

let toastTimer;
function toast(text, error = false) {
  const node = $('#ve-toast');
  node.textContent = text;
  node.className = error ? 've-error' : '';
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, error ? 8000 : 3000);
}

function shortcuts(event, inField) {
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); if (editing) save(); return; }
  if (!editing || inField || !mod) return;
  if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
}
document.addEventListener('keydown', (event) => {
  if (event.target.closest?.('input, textarea, [contenteditable], select')) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') shortcuts(event, true); return; }
  shortcuts(event, false);
});
window.addEventListener('beforeunload', (event) => { if (isDirty()) event.preventDefault(); });
$('#ve-stage').addEventListener('mouseleave', () => { hover = {}; paint(); });

// ---- Pages panel ----
function openPage(slug) {
  current = slug;
  selected = null;
  closePanel();
  win.scrollTo(0, 0);
  draw();
}

function drawPages() {
  const list = $('#ve-pages');
  const pages = slugsIn('pages').map((slug) => ({ slug, data: files.get(`${contentDir}/pages/${slug}.json`).data }))
    .sort((a, b) => (b.slug === 'index') - (a.slug === 'index') || String(a.data.title ?? a.slug).localeCompare(String(b.data.title ?? b.slug), 'de'));
  const item = (label, sub, isCurrent, onOpen, onSettings) => {
    const row = el('li', { className: isCurrent ? 've-current' : '' });
    const open = button('', null, onOpen, 've-page');
    open.append(el('span', {}, label), el('small', {}, sub));
    if (isCurrent) open.setAttribute('aria-current', 'page');
    row.append(open);
    if (onSettings) row.append(button('⚙', `Einstellungen: ${label}`, onSettings, 've-icon'));
    return row;
  };
  const sections = [];
  if (can('content')) {
    sections.push(el('h2', {}, 'Seiten'), el('ul', {}, ...pages.map(({ slug, data }) => item(data.title ?? slug, `${slug === 'index' ? 'Startseite' : `${slug}.html`} · ${statusOf(data)}${changedPaths().includes(`${contentDir}/pages/${slug}.json`) ? ' · geändert' : ''}`,
      slug === current, () => openPage(slug), () => { if (slug !== current) openPage(slug); pageSettings(); }))),
    button('+ Neue Seite', null, newPage, 've-tool ve-wide'));
  }
  if (postType && can('post')) {
    const posts = slugsIn(postType.name).map((slug) => ({ slug, data: files.get(`${contentDir}/${postType.name}/${slug}.json`).data }))
      .sort((a, b) => String(b.data[postType.date ?? 'publish_date'] ?? '').localeCompare(String(a.data[postType.date ?? 'publish_date'] ?? '')));
    const postList = el('ul', {}, ...posts.map(({ slug, data }) => item(data.title ?? slug, statusOf(data), false, () => openPost(slug))));
    sections.push(el('details', { className: 've-posts' }, el('summary', {}, postType.label), postList, button(`+ ${postType.singular ?? 'Beitrag'}`, null, newPost, 've-tool ve-wide')));
  }
  const siteList = el('ul', {});
  if (can('settings')) siteList.append(item('Website-Einstellungen', 'Name, Kontakt, Kopf- und Fußzeile', false, () => openPanel('Website-Einstellungen', 'settings', [])));
  if (can('structure') && settingsFile('menus')) siteList.append(item('Menüs', 'Navigation', false, () => openPanel('Menüs', 'menus', [])));
  if (siteList.children.length) sections.push(el('h2', {}, 'Website'), siteList);
  list.replaceChildren(...sections);
}

function pageSettings() {
  const fields = (collection('pages')?.fields ?? []).filter((f) => f.name !== 'sections');
  const extra = current === 'index' ? null : button('Seite löschen', null, async () => {
    if (await confirmDialog('Seite löschen?', `„${pageData().title ?? current}“ wird beim nächsten Speichern gelöscht.`, 'Löschen')) {
      change(() => { files.get(fileOf(`page:${current}`)).data = null; });
    }
  }, 've-tool ve-danger');
  openPanel('Seiteneinstellungen', `page:${current}`, [], { fields, extra });
}

const slugify = (title) => title.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'seite';
const unique = (folder, slug) => { let s = slug; for (let n = 2; slugsIn(folder).includes(s) || files.has(`${contentDir}/${folder}/${s}.json`); n++) s = `${slug}-${n}`; return s; };

async function newPage() {
  const title = await promptDialog('Neue Seite', 'Titel der Seite');
  if (!title) return;
  const slug = unique('pages', slugify(title));
  startEditing();
  change(() => { files.set(`${contentDir}/pages/${slug}.json`, { sha: null, saved: null, data: { title, status: 'draft', sections: [] } }); });
  openPage(slug);
}

function openPost(slug) {
  // The page that lists the posts stays in view beside the post's details.
  const listing = postType.previewPage;
  if (listing && listing !== current && slugsIn('pages').includes(listing)) openPage(listing);
  openPanel(`${postType.singular ?? 'Beitrag'}: ${files.get(`${contentDir}/${postType.name}/${slug}.json`).data.title ?? slug}`, `post:${slug}`, [], {
    extra: button('Löschen', null, async () => {
      if (await confirmDialog(`${postType.singular ?? 'Beitrag'} löschen?`, 'Wird beim nächsten Speichern gelöscht.', 'Löschen')) change(() => { files.get(fileOf(`post:${slug}`)).data = null; });
    }, 've-tool ve-danger'),
  });
}
async function newPost() {
  const title = await promptDialog(`Neu: ${postType.singular ?? 'Beitrag'}`, 'Titel');
  if (!title) return;
  const slug = unique(postType.name, slugify(title));
  change(() => { files.set(`${contentDir}/${postType.name}/${slug}.json`, { sha: null, saved: null, data: { title, status: 'draft' } }); });
  openPost(slug);
}

// ---- Start ----
$('#ve-user').textContent = me.name ?? me.email;
$('#ve-site').textContent = site.name;
$('#ve-classic').href = './';
if (me.role !== 'administrator') $('#ve-users').remove();
$('#ve-signout').addEventListener('click', () => { signOut(); location.href = './visual.html'; });
$('#ve-app').hidden = false;
draw();
api('/tick').catch(() => {});
