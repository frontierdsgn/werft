// The editor: the site's pages, posts and settings in two views that share the sidebar, the top bar
// and the unsaved changes. "Auf der Seite" shows each page as the site will publish it and edits it
// where it appears: texts are changed on the page, images replaced by clicking them, sections and
// list entries added, moved and removed once the layout is unlocked. "Formular" shows the same
// content as large, plain forms beside a live preview (form-view.js). Changes stay in the browser
// until "Speichern", which stores every changed file in one commit through the gateway.
import { schema as adminSchema } from 'werft/schema';
import { createContext, mediaPaths, markdown, raw, escape, imageSize, isPublic } from 'werft';
import { downscale, downscaleTarget, maxSize } from 'werft/images';
import { siteLanguages, languageDir, localize, deepMerge, differences, pageFile, pageLinks } from 'werft/content';
import { requireUser, loadSite, api, signOut } from './session.js';
import { disarm, postPreview } from './preview.js';
import { pageRenderer, mapDocument, getAt, setAt, textOf, unmark } from './visual-map.js';
import { buildForm, emptyValue } from './visual-form.js';
import { toMarkdown, formatBar, editableAsRich } from './visual-rich.js';
import { formView, mediaView, submissionsView, usersView } from './form-view.js';
import { retargetLink, retargetLinks, mentions, movedRedirects } from './rename.js';

const REPO = '/api/v1/repos/werft/site';
const { site, theme, base } = await loadSite();
const me = await requireUser(site.name);
const { branch } = await api('/status');
const contentDir = site.contentDir ?? site.content ?? 'content';
const mediaDir = site.mediaDirs?.[0] ?? 'assets/img';
const siteURL = new URL(base, location.origin).href;
const can = (kind) => (me.editable ?? []).includes(kind);
const schema = adminSchema({ site, theme, editable: me.editable, statuses: me.statuses });
const collection = (name) => schema.collections.find((c) => c.name === name);
const settingsFile = (name) => collection('settings')?.files.find((f) => f.name === name);
const postType = theme.postType;
// A site in several languages is edited one language at a time; its first language is the default.
const languages = siteLanguages(site);
const defaultLang = languages[0];
let lang = defaultLang;
const isDefault = (l = lang) => !languages.length || l === defaultLang;
const langDir = (l = lang) => languageDir(contentDir, languages, l);
const langPrefix = (l = lang) => (isDefault(l) ? '' : `${l}/`);
const languageName = (code) => { try { return new Intl.DisplayNames(['de'], { type: 'language' }).of(code); } catch { return code; } };

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
const removed = new Set(); // media files to delete with the next save

const FOLDERS = { page: 'pages', pattern: 'patterns', form: 'forms', post: postType?.name };
const SETTINGS = { settings: 'site', menus: 'menus', redirects: 'redirects' };
const slugOf = (path) => path.split('/').pop().replace(/\.json$/, '');
const slugsAt = (dir) => [...files].filter(([p, f]) => f.data && p.startsWith(`${dir}/`)).map(([p]) => slugOf(p));
// A language's posts: its own once it has some, else the default language's, shared by all.
const postDir = (l = lang) => (isDefault(l) || !slugsAt(`${langDir(l)}/${postType.name}`).length ? `${contentDir}/${postType.name}` : `${langDir(l)}/${postType.name}`);
// The file of a source in a language (the editor's, unless named). Redirects are shared.
function fileOf(source, l = lang) {
  const [kind, slug] = source.split(':');
  if (kind === 'redirects') return `${contentDir}/settings/redirects.json`;
  if (SETTINGS[kind]) return `${langDir(l)}/settings/${SETTINGS[kind]}.json`;
  if (kind === 'post') return `${postDir(l)}/${slug}.json`;
  return `${langDir(l)}/${FOLDERS[kind]}/${slug}.json`;
}
// Patterns and forms another language has not translated yet are the default language's; one is
// copied into the language when it is first opened there, and saved only once it was changed.
const copies = new Map(); // path → the copied text
function dataOf(source) {
  const kind = source.split(':')[0];
  if (!isDefault() && (kind === 'settings' || kind === 'menus')) return viewOf(kind);
  const path = fileOf(source);
  const original = !isDefault() && !files.has(path) && (kind === 'pattern' || kind === 'form') && files.get(fileOf(source, defaultLang))?.data;
  if (original) {
    files.set(path, { sha: null, saved: null, data: structuredClone(original) });
    copies.set(path, canon(original));
  }
  if (!files.has(path)) files.set(path, { sha: null, saved: null, data: SETTINGS[source] ? (source === 'redirects' ? { redirects: [] } : {}) : null });
  return files.get(path).data;
}
// A copy that was not changed is no change.
const unchangedCopy = (path, f) => f.saved === null && f.data !== null && copies.get(path) === canon(f.data);
// The slugs of a folder (pages, patterns, forms, the post type) in a language. A language shows
// the default language's patterns and forms it has not translated.
function slugsIn(folder, l = lang) {
  if (folder === postType?.name) return slugsAt(postDir(l));
  const own = slugsAt(`${langDir(l)}/${folder}`);
  return isDefault(l) || folder === 'pages' ? own : [...new Set([...own, ...slugsAt(`${contentDir}/${folder}`)])];
}

// Site settings and menus of a language other than the default are edited complete, as the site
// shows them; their file keeps only what differs from the default language (and what it held
// before), so a value changed in the default language still reaches every language.
const views = new Map(); // "lang:kind" → { kind, lang, data }
function viewOf(kind) {
  const key = `${lang}:${kind}`;
  if (!views.has(key)) {
    const base = files.get(fileOf(kind, defaultLang))?.data ?? {};
    const own = files.get(fileOf(kind))?.data ?? {};
    // Menus are replaced per location, settings merged key by key.
    views.set(key, { kind, lang, data: kind === 'menus' ? structuredClone({ ...base, ...own }) : deepMerge(base, own) });
  }
  return views.get(key).data;
}
function syncViews() {
  for (const { kind, lang: l, data } of views.values()) {
    const path = fileOf(kind, l);
    const f = files.get(path);
    const own = differences(data, files.get(fileOf(kind, defaultLang))?.data ?? {}, f?.saved ? JSON.parse(f.saved) : null, kind === 'menus' ? 1 : Infinity);
    if (f && (f.saved !== null || Object.keys(own).length)) f.data = own;
    else if (f) files.delete(path);
    else if (Object.keys(own).length) files.set(path, { sha: null, saved: null, data: own });
  }
}

// The content as the theme sees it, in the editor's language (or another).
function content(l = lang) {
  syncViews();
  const revive = mediaPaths(site);
  const copy = (data) => JSON.parse(JSON.stringify(data), revive);
  const folder = (dir) => [...files].filter(([p, f]) => f.data && p.startsWith(`${dir}/`)).map(([p, f]) => ({ ...copy(f.data), slug: slugOf(p) })).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const one = (path, fallback) => (files.get(path)?.data ? copy(files.get(path).data) : fallback);
  const of = (dir) => ({
    pages: folder(`${dir}/pages`), posts: postType ? folder(`${dir}/${postType.name}`) : [], patterns: folder(`${dir}/patterns`), forms: folder(`${dir}/forms`),
    settings: one(`${dir}/settings/site.json`, {}), menus: one(`${dir}/settings/menus.json`, {}),
  });
  const all = { ...of(contentDir), redirects: one(`${contentDir}/settings/redirects.json`, { redirects: [] }).redirects ?? [] };
  if (languages.length) all.languages = Object.fromEntries(languages.slice(1).map((l) => [l, of(langDir(l))]));
  return localize(all, { site, lang: l });
}

const changedPaths = () => {
  syncViews();
  return [...files].filter(([p, f]) => (f.data === null ? f.saved !== null : canon(f.data) !== (f.saved ?? copies.get(p)))).map(([p]) => p);
};
const isDirty = () => changedPaths().length > 0 || [...uploads.values()].some((u) => !u.saved) || removed.size > 0;

// ---- Schema: the field definitions the CMS uses, looked up by path ----
function topFields(source) {
  const kind = source.split(':')[0];
  if (kind === 'page') return collection('pages')?.fields;
  if (kind === 'pattern') return collection('patterns')?.fields;
  if (kind === 'form') return collection('forms')?.fields;
  if (kind === 'post') return collection(postType?.name)?.fields;
  return settingsFile(SETTINGS[kind])?.fields;
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
  if (kind === 'redirects') return 'Weiterleitungen';
  if (kind === 'form') return `Formular „${dataOf(source)?.title ?? slug}“`;
  if (kind === 'post') return `${postType?.singular ?? 'Beitrag'} „${dataOf(source)?.title ?? slug}“`;
  return 'Seite';
}
// Whether a pattern or form is shown in the default language because the editor's language has
// none of its own yet.
const untranslated = (source) => !isDefault() && (!files.get(fileOf(source))?.data || unchangedCopy(fileOf(source), files.get(fileOf(source))));
function sharedNote(source) {
  const kind = source.split(':')[0];
  const note = {
    pattern: 'Erscheint auf mehreren Seiten: Änderungen wirken überall.',
    settings: 'Website-Einstellung: Änderungen wirken auf allen Seiten.',
    menus: 'Menü: Änderungen wirken auf allen Seiten.',
    form: 'Formular: Änderungen wirken überall, wo es erscheint.',
  }[kind];
  if (!note || isDefault()) return note;
  const original = `der Fassung auf ${languageName(defaultLang)}`;
  if (kind === 'settings') return `${note} Was Sie hier nicht ändern, kommt aus ${original}.`;
  if (kind === 'menus') return `${note} Ein Menü, das Sie hier nicht ändern, kommt aus ${original}.`;
  return untranslated(source) ? `${note} Noch nicht übersetzt: Es zeigt den Inhalt aus ${original}, bis Sie es hier ändern.` : note;
}

// ---- Editor state ----
// The language comes from the address too (#view/source/lang).
const [hashView, hashOpen, hashLang] = decodeURIComponent(location.hash.slice(1)).split('/');
if (languages.includes(hashLang)) lang = hashLang;
let current = slugsIn('pages').includes('index') ? 'index' : slugsIn('pages')[0];
// What the form view opens when the language has no page yet: the default language's home page,
// which it offers to translate.
const pageSource = () => `page:${current ?? (slugsIn('pages', defaultLang).includes('index') ? 'index' : slugsIn('pages', defaultLang)[0] ?? 'index')}`;
// The view, and what the form view shows: a source (page:<slug>, post:<slug>, settings, …), or
// `media`, `submissions` or `users`. Both come from the address, then from the last visit.
let view = ['visual', 'form'].includes(hashView) ? hashView : localStorage.getItem('werft.view') === 'visual' ? 'visual' : 'form';
let selection = pageSource();
let showPreview = innerWidth >= 1200;
let editing = false;
let locked = true;
let device = 'desktop';
let model = null; // what the page shows where: mapDocument's lookups plus texts and images
let hover = {};
let selected = null; // section index
let active = null; // { el, source, path, mode }
const undoStack = [];
const redoStack = [];
const onPage = () => editing && view === 'visual';

const snapshot = () => { syncViews(); return JSON.stringify([...files].map(([p, f]) => [p, f.data]).concat([['', [...removed]]])); };
function restore(snap) {
  views.clear();
  const data = new Map(JSON.parse(snap));
  removed.clear();
  for (const path of data.get('') ?? []) removed.add(path);
  data.delete('');
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
// After a change outside a form: the page and the form are drawn again.
function refresh() {
  closePanel();
  draw();
  if (view === 'form') drawForm();
}
// A change made by a toolbar or dialog: one undo step, then the page is drawn again.
function change(fn) {
  checkpoint();
  fn();
  refresh();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  refresh();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  refresh();
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
  [contenteditable]:empty::before{content:"…";opacity:.4}
  .ve-preview-note{position:sticky;top:0;z-index:1000;margin:0;padding:10px 16px;background:#1f1c19;color:#fff;font:600 15px/1.4 system-ui,sans-serif}
  [data-werft-focus]{outline:4px solid #2563eb!important;outline-offset:4px}`;
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

// The page the form view previews for its selection: the page itself; for a pattern or a form the
// first page that shows it; for site settings and menus the page last open.
function previewPage(data) {
  const [kind, slug] = selection.split(':');
  if (kind === 'page') return slug;
  const shows = (sections, seen = new Set()) => (sections ?? []).some((s) => (kind === 'pattern' ? s.pattern === slug : s.form === slug)
    || (s.type === 'pattern' && !seen.has(s.pattern) && seen.add(s.pattern) && shows(data.patterns.find((p) => p.slug === s.pattern)?.sections, seen)));
  if (kind === 'pattern' || kind === 'form') {
    const page = [...data.pages].sort((a, b) => (b.slug === current) - (a.slug === current)).find((p) => shows(p.sections));
    if (page) return page.slug;
    // A pattern no page uses yet is shown alone.
    if (kind === 'pattern') { data.pages.push({ slug: '', title: dataOf(selection)?.title ?? '', sections: [{ type: 'pattern', pattern: slug }] }); return ''; }
  }
  return current;
}
const hasPreview = () => view === 'visual' || !['media', 'submissions', 'users', 'redirects'].includes(selection);

function draw() {
  const pageList = slugsIn('pages');
  if (!pageList.includes(current)) current = pageList.includes('index') ? 'index' : pageList[0];
  if (view === 'form' && selection.startsWith('page:') && pageList.includes(selection.slice(5))) current = selection.slice(5);
  const data = content();
  let result;
  // Relative addresses on the page lead from where the page is published (below <lang>/ for a
  // language other than the default, in a post's folder for a post page).
  let folder = langPrefix();
  if (view === 'form' && selection.startsWith('post:') && dataOf(selection)) {
    // A post as the site shows it: its own page, or marked on the page that lists it. A post all
    // languages share is shown in the default language, where it is published.
    const shared = !isDefault() && languageOf(selection) !== lang;
    if (shared) folder = '';
    const entry = { ...JSON.parse(JSON.stringify(dataOf(selection)), mediaPaths(site)), slug: selection.slice(5) };
    const post = postPreview(entry, shared ? content(defaultLang) : data, { site, theme, media });
    if (!post.note) folder += String(theme.postType.url(entry) ?? '').replace(/[^/]*$/, '');
    result = { html: post.html, texts: [], images: [], note: post.note };
  } else {
    const slug = view === 'form' ? previewPage(data) : current;
    result = slug === undefined
      ? { html: '<!doctype html><html><head></head><body></body></html>', texts: [], images: [], note: `Auf ${languageName(lang)} gibt es noch keine Seite. Legen Sie links unter „Noch nicht übersetzt“ eine Übersetzung an.` }
      : renderer(data, slug);
  }
  baseEl.href = new URL(folder, siteURL).href;
  const parsed = new DOMParser().parseFromString(result.html, 'text/html');
  if (result.note) parsed.body.prepend(Object.assign(parsed.createElement('p'), { className: 've-preview-note', textContent: result.note }));
  // Nothing of the page runs in the editor: no scripts, handlers, redirects or frames.
  parsed.querySelectorAll('script, noscript, base, meta[http-equiv], iframe, object, embed').forEach((n) => n.remove());
  disarm(parsed);
  // Links to pages the language lacks lead to the default language's, as on the site.
  if (!isDefault() && folder.startsWith(langPrefix())) {
    const link = pageLinks({ site, content: data, preview: true });
    for (const a of parsed.querySelectorAll('a[href]')) {
      const href = unmark(a.getAttribute('href'));
      const next = link(href, `${folder}index.html`);
      if (next !== href) a.setAttribute('href', next);
    }
  }
  // Files uploaded but not saved yet come from the browser's copy.
  const pending = [...uploads].filter(([, u]) => !u.saved).map(([path, u]) => [new URL(path, siteURL).href, u.url, path]);
  if (pending.length) {
    for (const node of parsed.querySelectorAll('[src], [srcset]')) {
      const src = node.getAttribute('src');
      const upload = src && pending.find(([href]) => href === new URL(src, baseEl.href).href);
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
  // A post marked on its listing page comes into view when it is first shown, not on every change.
  const focus = doc.querySelector('[data-werft-focus]');
  if (focus && focused !== selection) focus.scrollIntoView({ block: 'center' });
  focused = view === 'form' ? selection : null;
  hover = {};
  active = null;
  applyMode();
  drawBar();
  drawPages();
}
let focused = null;

// How a text is edited: in place as plain text, in place as rich text, or in a small dialog.
function modeOf(text, entry) {
  if (!entry.el) return 'dialog';
  const def = schemaAt(text.source, text.path);
  const block = entry.el.dataset.werftField !== undefined && entry.el.localName !== 'span' && !/^(a|button|label)$/.test(entry.el.localName);
  if (def?.widget === 'richtext' && block) return editableAsRich(text.value) ? 'rich' : 'dialog';
  return entry.plain ? 'plain' : 'dialog';
}

function applyMode() {
  doc.documentElement.classList.toggle('ve-editing', onPage());
  for (const [id, entries] of model.fields) {
    const text = model.texts.get(id);
    for (const entry of entries) {
      if (!entry.el) continue;
      const mode = modeOf(text, entry);
      if (onPage() && mode !== 'dialog') entry.el.contentEditable = mode === 'rich' ? 'true' : PLAIN;
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
  if (!onPage() || !node?.isContentEditable) return;
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
    field: onPage() ? (fieldOf(t) ?? t.closest?.('[data-werft-part]')) : null,
    image: onPage() ? t.closest?.('[data-werft-image]') : null,
  };
  if (next.section !== hover.section || next.item !== hover.item || next.field !== hover.field || next.image !== hover.image) { hover = next; paint(); }
});
win.addEventListener('scroll', () => paint(), { passive: true });
win.addEventListener('resize', () => paint());
doc.addEventListener('submit', (event) => event.preventDefault(), true);
doc.addEventListener('click', (event) => {
  const t = event.target;
  const link = t.closest?.('a[href]');
  if (view === 'form') {
    // A click on a section of the previewed page opens it in the form.
    event.preventDefault();
    const index = sectionOf(t);
    if (index != null && selection === `page:${current}`) formHandle?.reveal(['sections', index]);
    return;
  }
  if (!editing) {
    if (!link) return;
    event.preventDefault();
    const target = pageOfURL(link.href);
    if (target && target.lang !== lang) switchLanguage(target.lang, `page:${target.slug}`);
    else if (target) openPage(target.slug);
    else if (link.hash && new URL(link.href).pathname === new URL(pageURL(current)).pathname) doc.querySelector(link.hash)?.scrollIntoView({ behavior: 'smooth' });
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

// The page a link leads to, { slug, lang }, when it is another page of the site.
function pageOfURL(href) {
  const url = new URL(href, siteURL);
  const root = new URL(siteURL);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return null;
  let rest = decodeURIComponent(url.pathname.slice(root.pathname.length));
  const other = languages.slice(1).find((l) => rest === l || rest.startsWith(`${l}/`));
  if (other) rest = rest.slice(other.length + 1);
  const slug = rest === '' ? 'index' : rest.replace(/\.html$/, '');
  const target = other ?? defaultLang;
  return (slug !== current || target !== lang) && slugsIn('pages', target).includes(slug) ? { slug, lang: target } : null;
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

const pageData = () => (current ? dataOf(`page:${current}`) : null);

function paintNow() {
  overlay.replaceChildren();
  const page = pageData();
  if (!model || !page) return;
  if (onPage() && !page.sections?.length) {
    // The empty page gets room where its sections will be.
    const main = doc.querySelector('main') ?? doc.body;
    main.style.minHeight = '320px';
    const rect = rectOf([main]);
    const empty = box(rect, 've-empty');
    empty.append(el('p', {}, 'Diese Seite hat noch keine Abschnitte.'), button('+ Abschnitt hinzufügen', null, () => addSection(0), 've-primary'));
    overlay.append(empty);
  }
  if (!onPage()) return;

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

// What a form needs from the editor (see buildForm).
const titleOf = (folder, slug) => {
  const source = `${Object.keys(FOLDERS).find((k) => FOLDERS[k] === folder)}:${slug}`;
  return (files.get(fileOf(source))?.data ?? files.get(fileOf(source, defaultLang))?.data)?.title ?? slug;
};
const formContext = (onChange) => ({
  onChange, pickImage, mediaURL,
  suggest: (field) => (field.name === 'url' ? slugsIn('pages').map((slug) => ({ value: `${slug}.html`, label: titleOf('pages', slug) })) : []),
  choices: (name) => slugsIn(name).map((slug) => ({ label: titleOf(name, slug), value: slug })),
  // A new entry of a list with several kinds: a section from the picker with examples. Other such
  // lists (none in today's schema) start with the first kind.
  pickItem: (field) => (field.name === 'sections' ? pickSection({ patterns: field.types.some((t) => t.name === 'pattern') }) : undefined),
});

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
  const form = buildForm(defs, holder, formContext(() => {
    if (!started) { undoStack.push(snapshotBefore); redoStack.length = 0; started = true; }
    drawBar();
    clearTimeout(drawSoon);
    drawSoon = setTimeout(() => { const keep = panel.scrollTop; draw(); panel.scrollTop = keep; }, 300);
  }));
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
  const rich = def?.widget === 'richtext' && editableAsRich(text.value);
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
    editor = el('textarea', { value: text.value, rows: def?.widget === 'richtext' ? 10 : 4 });
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
    grid.replaceChildren(...images().map((path) => {
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
      const { path, note } = await upload(file);
      if (note) toast(note);
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
  return `<!doctype html><html lang="${escape(out.documentElement.lang)}"><head><base href="${escape(new URL(langPrefix(), siteURL).href)}">${styles}<style>html,body{overflow:hidden;pointer-events:none}</style></head><body class="${escape(out.body.className)}"><main>${inner}</main></body></html>`;
}
function addSection(at) {
  pickSection().then((section) => section && sectionTo(at, () => (pageData().sections ??= []).splice(at, 0, section)));
}
// Resolves with a new section chosen from the theme's blocks (and the patterns), or null.
function pickSection({ patterns: withPatterns = true } = {}) {
  const dialog = $('#ve-sections');
  const grid = dialog.querySelector('.ve-section-grid');
  const found = examples();
  let resolve;
  const picked = new Promise((r) => { resolve = r; });
  const insert = (section) => {
    resolve(section);
    dialog.close();
  };
  dialog.addEventListener('close', () => resolve(null), { once: true });
  const card = (label, section, note) => {
    const b = button('', label, () => insert(structuredClone(section)), 've-section-card');
    const thumb = el('div', { className: 've-thumb-frame' });
    let html = '';
    try { html = sectionHTML(section); } catch { /* a section without content cannot be shown */ }
    if (html) thumb.append(Object.assign(document.createElement('iframe'), { sandbox: '', srcdoc: html, tabIndex: -1, loading: 'lazy', title: '' }));
    else thumb.append(el('span', {}, 'Leerer Abschnitt'));
    b.append(thumb, el('strong', {}, label), note ? el('small', {}, note) : null);
    return b;
  };
  const cards = Object.entries(theme.blocks).map(([type, block]) => {
    const example = found.get(type);
    const fields = topFields('page:')?.find((f) => f.name === 'sections')?.types?.find((t) => t.name === type)?.fields ?? block.fields ?? [];
    return card(block.label ?? type, example ?? { type, ...emptyValue({ widget: 'object', fields }) }, example ? 'mit Beispielinhalt' : null);
  });
  const patterns = withPatterns ? slugsIn('patterns').map((slug) => card(`Muster: ${titleOf('patterns', slug)}`, { type: 'pattern', pattern: slug }, 'auf mehreren Seiten gleich')) : [];
  grid.replaceChildren(...cards, ...patterns);
  dialog.querySelector('.ve-cancel').onclick = () => dialog.close();
  dialog.showModal();
  for (const thumb of grid.querySelectorAll('.ve-thumb-frame')) thumb.style.setProperty('--ve-scale', thumb.clientWidth / 1200);
  return picked;
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
function promptDialog(title, label, value = '', { yes = 'Anlegen', hint = '' } = {}) {
  const dialog = $('#ve-prompt');
  dialog.querySelector('h2').textContent = title;
  Object.assign(dialog.querySelector('.ve-hint'), { textContent: hint, hidden: !hint });
  dialog.querySelector('label span').textContent = label;
  dialog.querySelector('button[value=ok]').textContent = yes;
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
const pageURL = (slug) => `${siteURL}${langPrefix()}${slug === 'index' ? '' : pageFile(slug)}`;

// The name of a source and what it is, for the top bar and the sidebar.
function describe(source) {
  const [kind, slug] = source.split(':');
  const data = slug !== undefined ? dataOf(source) : null;
  // A page not translated yet is named as in the language it exists in.
  const name = data?.title ?? (FOLDERS[kind] ? titleOf(FOLDERS[kind], slug) : slug);
  return {
    page: { kind: 'Seite', title: name },
    post: { kind: postType?.singular ?? 'Beitrag', title: name },
    pattern: { kind: 'Muster', title: name },
    form: { kind: 'Formular', title: name },
    settings: { kind: 'Website', title: 'Website-Einstellungen' },
    menus: { kind: 'Website', title: 'Menüs' },
    redirects: { kind: 'Website', title: 'Weiterleitungen' },
    media: { kind: 'Website', title: 'Bilder' },
    submissions: { kind: 'Website', title: 'Einsendungen' },
    users: { kind: 'Website', title: 'Benutzer' },
  }[kind];
}

// The language whose file a source is: none for what all languages share; the default language's
// for posts of a language that has none of its own.
function languageOf(source) {
  if (!languages.length || /^(redirects|media|submissions|users)$/.test(source)) return null;
  return source.startsWith('post:') && postDir() === `${contentDir}/${postType.name}` ? defaultLang : lang;
}

function drawBar() {
  const bar = $('#ve-top');
  const shown = view === 'form' ? selection : current ? `page:${current}` : null;
  const { kind, title } = (shown && describe(shown)) ?? {};
  const language = shown && languageOf(shown);
  const data = /^(page|post|pattern|form):/.test(shown) ? dataOf(shown) : null;
  const left = el('div', { className: 've-top-left' });
  if (editing || view === 'form') {
    const saveButton = button('Speichern', 'Speichern (Strg+S)', save, 've-primary ve-save');
    saveButton.disabled = !isDirty();
    const undoButton = button('', 'Rückgängig (Strg+Z)', undo);
    const redoButton = button('', 'Wiederholen (Strg+Umschalt+Z)', redo);
    undoButton.append(el('span', { ariaHidden: 'true' }, '↶'), el('span', { className: 've-btn-text' }, 'Rückgängig'));
    redoButton.append(el('span', { ariaHidden: 'true' }, '↷'), el('span', { className: 've-btn-text' }, 'Wiederholen'));
    undoButton.disabled = !undoStack.length;
    redoButton.disabled = !redoStack.length;
    left.append(saveButton, ...(view === 'visual' ? [button('Beenden', null, finish, 've-tool')] : []), undoButton, redoButton);
  } else left.append(button('Bearbeiten', null, startEditing, 've-primary'));
  const state = el('span', { className: isDirty() ? 've-state ve-unsaved' : 've-state' }, isDirty() ? 'Nicht gespeichert' : 'Alles gespeichert');
  const center = el('div', { className: 've-top-center' }, el('strong', {}, title ?? ''),
    el('span', {}, `${kind ?? ''}${language ? ` · ${languageName(language)}` : ''}${data && /^(page|post):/.test(shown) ? ` · ${statusOf(data)}` : ''} · `, state));
  const right = el('div', { className: 've-top-right' });
  if (view === 'form') {
    if (hasPreview()) {
      const toggle = button(showPreview ? 'Vorschau ausblenden' : 'Vorschau zeigen', null, () => { showPreview = !showPreview; layout(); drawBar(); }, `ve-tool${showPreview ? ' ve-on' : ''}`);
      toggle.setAttribute('aria-pressed', String(showPreview));
      right.append(toggle);
    }
    if (shown.startsWith('page:') && data) right.append(el('a', { href: pageURL(shown.slice(5)), target: '_blank', rel: 'noopener', className: 've-tool', title: 'Veröffentlichte Seite in neuem Tab' }, 'Ansehen ↗'));
    bar.replaceChildren(left, center, right);
    return;
  }
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
  right.append(devices, current ? el('a', { href: pageURL(current), target: '_blank', rel: 'noopener', className: 've-tool', title: 'Veröffentlichte Seite in neuem Tab' }, 'Ansehen ↗') : '');
  bar.replaceChildren(left, center, right);
}

let saving = null;
async function save() {
  // One save at a time; a click during a save saves what changed meanwhile once it is done.
  if (saving) { await saving; return save(); }
  const changes = [];
  // What each file is saved as: edits made while the request runs stay unsaved.
  const sent = new Map();
  for (const path of changedPaths()) {
    const f = files.get(path);
    sent.set(path, f.data === null ? null : canon(f.data));
    if (f.data === null) changes.push({ operation: 'delete', path, sha: f.sha });
    else changes.push({ operation: f.saved === null ? 'create' : 'update', path, ...(f.sha && { sha: f.sha }), content: encodeBase64(new TextEncoder().encode(fileText(f.data))) });
  }
  for (const [path, u] of uploads) if (!u.saved) changes.push({ operation: 'create', path, content: u.base64 });
  for (const path of removed) changes.push({ operation: 'delete', path });
  if (!changes.length) return;
  const titles = changes.filter((c) => c.path.endsWith('.json')).map((c) => {
    const data = files.get(c.path)?.data ?? JSON.parse(files.get(c.path)?.saved ?? '{}');
    return data.title ?? describe(Object.keys(SETTINGS).find((k) => fileOf(k) === c.path) ?? '')?.title ?? c.path.split('/').pop().replace(/\.json$/, '');
  });
  const images = changes.filter((c) => !c.path.endsWith('.json')).map((c) => c.path.split('/').pop());
  toast('Wird gespeichert …');
  const message = `Geändert: ${[...new Set(titles), ...images].join(', ')}`;
  const request = api(`${REPO}/contents`, { method: 'POST', body: { branch, message, files: changes } });
  saving = request.catch(() => {});
  try {
    const result = await request;
    for (const [i, c] of changes.entries()) {
      if (uploads.has(c.path)) { uploads.get(c.path).saved = true; continue; }
      if (removed.has(c.path)) { removed.delete(c.path); delete media[c.path]; continue; }
      const f = files.get(c.path);
      if (!f) continue;
      if (c.operation === 'delete') {
        if (f.data === null) files.delete(c.path);
        else Object.assign(f, { saved: null, sha: undefined });
      } else Object.assign(f, { saved: sent.get(c.path), sha: result.files?.[i]?.sha ?? f.sha });
    }
    toast('Gespeichert. Die Website wird neu erstellt.');
  } catch (error) {
    toast(error.status === 403 ? `Nicht erlaubt: ${error.message}` : `Speichern fehlgeschlagen: ${error.message}`, true);
  } finally {
    saving = null;
  }
  drawBar();
  drawPages();
  if (view === 'form' && selection === 'media') drawForm();
}

async function finish() {
  if (isDirty()) {
    const choice = await confirmDialog('Ohne Speichern beenden?', 'Alle nicht gespeicherten Änderungen werden verworfen.', 'Verwerfen', { other: 'Speichern' });
    if (!choice) return;
    if (choice === 'other') { await save(); if (isDirty()) return; } else {
      for (const [path, f] of [...files]) { if (f.saved === null) files.delete(path); else f.data = JSON.parse(f.saved); }
      for (const [path, u] of [...uploads]) if (!u.saved) { uploads.delete(path); delete media[path]; }
      removed.clear();
      views.clear();
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
  toastTimer = setTimeout(() => { node.hidden = true; }, error || text.length > 100 ? 8000 : 3000);
}

function shortcuts(event, inField) {
  const mod = event.ctrlKey || event.metaKey;
  const on = editing || view === 'form';
  if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); if (on) save(); return; }
  if (!on || inField || !mod) return;
  if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  if (event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
}
document.addEventListener('keydown', (event) => {
  if (event.target.closest?.('input, textarea, [contenteditable], select')) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') shortcuts(event, true); return; }
  shortcuts(event, false);
});
window.addEventListener('beforeunload', (event) => { if (isDirty()) event.preventDefault(); });
$('#ve-stage').addEventListener('mouseleave', () => { hover = {}; paint(); });

// ---- Sidebar: everything that can be opened, the same in both views ----
function openPage(slug) {
  current = slug;
  if (view === 'form') selection = `page:${slug}`;
  selected = null;
  closePanel();
  win.scrollTo(0, 0);
  draw();
  if (view === 'form') drawForm(); else layout();
}

// Opens a source (page:<slug>, post:<slug>, pattern:<slug>, form:<slug>, settings, menus,
// redirects) or `media` / `submissions` / `users`. The page view shows pages and opens the rest in
// its side panel; what has no page of its own (patterns, images, submissions, users) opens in the
// form view.
function open(source) {
  const [kind, slug] = source.split(':');
  if (view === 'visual') {
    if (kind === 'page') return openPage(slug);
    if (kind === 'post') return openPost(slug);
    if (['settings', 'menus', 'redirects', 'form'].includes(kind)) return openPanel(describe(source).title, source, []);
    return setView('form', source);
  }
  if (kind === 'page') return openPage(slug);
  selection = source;
  closePanel();
  win.scrollTo(0, 0);
  draw();
  drawForm();
}

function setView(next, source) {
  const target = source ?? (next === 'form' ? pageSource() : selection);
  view = next;
  localStorage.setItem('werft.view', view);
  hover = {};
  selected = null;
  closePanel();
  // Unsaved changes made in the form keep "Speichern" in view on the page.
  if (view === 'visual' && isDirty()) editing = true;
  if (view === 'form') selection = target;
  else if (target.startsWith('page:') && dataOf(target)) current = target.slice(5);
  layout();
  draw();
  if (view === 'form') drawForm();
  else if (!target.startsWith('page:') && /^(post|settings|menus|redirects|form)\b/.test(target) && dataOf(target)) open(target);
}

// The view and whether the form view shows its preview, for the stylesheet; the address keeps both.
function layout() {
  const app = $('#ve-app');
  app.dataset.view = view;
  app.dataset.preview = String(view === 'visual' || (showPreview && hasPreview()));
  for (const b of document.querySelectorAll('.ve-views button[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  $('#ve-form').hidden = view !== 'form';
  history.replaceState(null, '', `#${view}/${encodeURIComponent(view === 'form' ? selection : pageSource())}${isDefault() ? '' : `/${lang}`}`);
}

// The form view's preview: the page at a common laptop width, scaled down to the room beside the
// form.
const stage = $('#ve-stage');
const PREVIEW_WIDTH = 1200;
new ResizeObserver(() => {
  if (!stage.clientWidth) return;
  const scale = Math.min(1, stage.clientWidth / PREVIEW_WIDTH);
  const style = $('#ve-app').style;
  style.setProperty('--ve-preview-width', `${Math.max(PREVIEW_WIDTH, stage.clientWidth)}px`);
  style.setProperty('--ve-preview-scale', scale);
  style.setProperty('--ve-preview-height', `${stage.clientHeight / scale}px`);
}).observe(stage);

let formHandle = null;
let formShows = null;
function drawForm() {
  const main = $('#ve-form');
  const scroll = formShows === selection ? main.scrollTop : 0;
  const pages = { media: mediaView, submissions: submissionsView, users: usersView };
  const show = Object.hasOwn(pages, selection) ? pages[selection] : formView;
  formHandle = show(app, main);
  main.scrollTop = scroll;
  formShows = selection;
  layout();
}

let postsOpen = false;
let moreOpen = false;
function drawPages() {
  const list = $('#ve-pages');
  const shown = view === 'form' ? selection : `page:${current}`;
  const changed = new Set(changedPaths());
  const order = (a, b) => (b.slug === 'index') - (a.slug === 'index') || String(a.data.title ?? a.slug).localeCompare(String(b.data.title ?? b.slug), 'de');
  const pages = slugsIn('pages').map((slug) => ({ slug, data: files.get(fileOf(`page:${slug}`)).data })).sort(order);
  // The second line names only what is worth noticing: the home page, a status other than published.
  const note = (...parts) => parts.filter(Boolean).join(' · ');
  const unusual = (data) => (statusOf(data) === STATUS.published ? '' : statusOf(data));
  const item = (source, label, sub, onSettings) => {
    const isCurrent = source === shown;
    const row = el('li', { className: isCurrent ? 've-current' : '' });
    const openButton = button('', null, () => open(source), 've-page');
    const edited = /:/.test(source) && changed.has(fileOf(source));
    openButton.append(el('span', {}, label));
    if (sub || edited) openButton.append(el('small', {}, sub, edited ? el('b', { className: 've-edited' }, `${sub ? ' · ' : ''}geändert`) : null));
    if (isCurrent) openButton.setAttribute('aria-current', 'page');
    row.append(openButton);
    if (onSettings && view === 'visual') row.append(button('⚙', `Einstellungen: ${label}`, onSettings, 've-icon'));
    return row;
  };
  const group = (title, ...children) => el('section', { className: 've-group' }, el('h2', {}, title), ...children);
  const folded = (title, isOpen, onToggle, ...children) => {
    const details = el('details', { className: 've-group ve-folded', open: isOpen }, el('summary', {}, title), ...children);
    details.addEventListener('toggle', () => onToggle(details.open));
    return details;
  };
  const sections = [];
  // The languages a page is missing in, worth noticing.
  const missing = (slug) => {
    const without = languages.filter((l) => l !== lang && !slugsIn('pages', l).includes(slug)).map(languageName);
    return without.length ? `nicht auf ${without.join(', ')}` : '';
  };
  if (can('content')) {
    sections.push(group('Seiten', el('ul', {}, ...pages.map(({ slug, data }) => item(`page:${slug}`, data.title ?? slug, note(slug === 'index' && 'Startseite', unusual(data), missing(slug)),
      () => { if (slug !== current) openPage(slug); pageSettings(); }))),
    button('+ Neue Seite', null, newPage, 've-tool ve-wide')));
    // Pages of other languages this one lacks, offered as a copy to translate.
    const untranslatedPages = [...new Set(languages.filter((l) => l !== lang).flatMap((l) => slugsIn('pages', l)))].filter((slug) => !slugsIn('pages').includes(slug))
      .map((slug) => ({ slug, data: { title: titleOf('pages', slug) } })).sort(order);
    if (untranslatedPages.length) {
      sections.push(group('Noch nicht übersetzt', el('p', { className: 've-hint' }, `Diese Seiten gibt es auf ${languageName(lang)} noch nicht. „Übersetzen“ legt eine Kopie an, die Sie hier übersetzen.`),
        el('ul', {}, ...untranslatedPages.map(({ slug, data }) => {
          const row = item(`page:${slug}`, data.title, slug === 'index' ? 'Startseite' : '');
          row.append(button('Übersetzen', `„${data.title}“ auf ${languageName(lang)} anlegen`, () => translate(slug), 've-tool'));
          return row;
        }))));
    }
  }
  if (postType && can('post')) {
    const date = postType.date ?? 'publish_date';
    const posts = slugsIn(postType.name).map((slug) => ({ slug, data: files.get(fileOf(`post:${slug}`)).data }))
      .sort((a, b) => String(b.data[date] ?? '').localeCompare(String(a.data[date] ?? '')));
    const when = (data) => (data[date] ? new Date(data[date]).toLocaleDateString('de-DE') : '');
    // A language without posts of its own shows the default language's; its first own post ends that.
    const shared = !isDefault() && languageOf('post:') !== lang;
    // Own posts of the language that are not public yet: the site still shows the default ones.
    const waiting = !isDefault() && !shared && !posts.some(({ data }) => isPublic(data));
    // Starting own posts changes what the public site shows, so it is for roles that may publish.
    const mayPublish = (me.statuses ?? []).includes('published');
    sections.push(folded(`${postType.label} (${posts.length})`, postsOpen || shown.startsWith('post:'), (o) => { postsOpen = o; },
      shared && el('p', { className: 've-hint' }, `Auf ${languageName(lang)} zeigt die Website die ${postType.label} auf ${languageName(defaultLang)}. Was Sie hier anlegen oder ändern, gilt für alle Sprachen.`),
      waiting && el('p', { className: 've-hint' }, `Bis einer dieser Einträge veröffentlicht ist, zeigt die Website auf ${languageName(lang)} weiter die ${postType.label} auf ${languageName(defaultLang)}.`),
      button(`+ ${postType.singular ?? 'Beitrag'} anlegen${shared ? ' (für alle Sprachen)' : ''}`, null, () => newPost(), 've-tool ve-wide'),
      shared && mayPublish && button(`Eigene ${postType.label} auf ${languageName(lang)} beginnen …`, null, () => newPost({ own: true }), 've-tool ve-wide'),
      el('ul', {}, ...posts.map(({ slug, data }) => item(`post:${slug}`, data.title ?? slug, note(when(data), unusual(data)))))));
  }
  const siteList = el('ul', {});
  if (can('settings')) siteList.append(item('settings', 'Website-Einstellungen', 'Name, Kontakt, Kopf- und Fußzeile'));
  if (can('structure') && settingsFile('menus')) siteList.append(item('menus', 'Menüs', 'Navigation'));
  if (can('media')) siteList.append(item('media', 'Bilder', 'Alle Bilder, neue hochladen'));
  if (can('content') && slugsIn('forms').length) siteList.append(item('submissions', 'Einsendungen', 'Was Besucher über Formulare gesendet haben'));
  if (me.role === 'administrator') siteList.append(item('users', 'Benutzer', 'Wer die Website bearbeiten darf'));
  if (siteList.children.length) sections.push(group('Website', siteList));
  const more = [];
  if (can('content')) {
    more.push(el('h3', {}, 'Muster'), el('p', { className: 've-hint' }, 'Abschnitte, die auf mehreren Seiten gleich erscheinen.'),
      el('ul', {}, ...slugsIn('patterns').map((slug) => item(`pattern:${slug}`, titleOf('patterns', slug), untranslated(`pattern:${slug}`) ? 'Muster · noch nicht übersetzt' : 'Muster'))),
      button('+ Neues Muster', null, () => newEntry('pattern'), 've-tool ve-wide'));
    if (collection('forms')) {
      more.push(el('h3', {}, 'Formulare'), el('ul', {}, ...slugsIn('forms').map((slug) => item(`form:${slug}`, titleOf('forms', slug), untranslated(`form:${slug}`) ? 'Formular · noch nicht übersetzt' : 'Formular'))),
        button('+ Neues Formular', null, () => newEntry('form'), 've-tool ve-wide'));
    }
  }
  if (can('structure')) more.push(el('h3', {}, 'Weiterleitungen'), el('ul', {}, item('redirects', 'Weiterleitungen', 'Alte Adressen auf neue umleiten')));
  if (more.length) sections.push(folded('Weitere Inhalte', moreOpen || /^(pattern|form:|redirects)/.test(shown), (o) => { moreOpen = o; }, ...more));
  list.replaceChildren(...sections);
  drawLanguages();
}

// The language switch at the top of the sidebar, for a site in several languages.
function drawLanguages() {
  const box = $('#ve-languages');
  box.hidden = languages.length < 2;
  box.querySelector('.ve-views').replaceChildren(...languages.map((l) => {
    const b = el('button', { type: 'button' }, languageName(l));
    b.setAttribute('aria-pressed', String(l === lang));
    b.addEventListener('click', () => switchLanguage(l));
    return b;
  }));
}

// Edits another language: the same page, or what else is open, in that language where it exists.
function switchLanguage(next, source) {
  if (next === lang) { if (source) open(source); return; }
  syncViews();
  views.clear();
  // Copies of patterns and forms that were not changed are made again when needed.
  for (const [path, f] of [...files]) if (unchangedCopy(path, f)) files.delete(path);
  lang = next;
  closePanel();
  selected = null;
  const target = source ?? (view === 'form' ? selection : pageSource());
  const [kind, slug] = target.split(':');
  if (kind === 'page') current = slug;
  if (view === 'visual') return setView(view, target.startsWith('page:') ? target : pageSource());
  setView(view, kind === 'post' && !slugsIn(postType.name).includes(slug) ? pageSource() : target);
}

// A page of another language as a copy in the editor's language, to be translated in place. It is
// a draft until it is published.
function translate(slug) {
  const from = languages.find((l) => l !== lang && slugsIn('pages', l).includes(slug));
  const original = files.get(fileOf(`page:${slug}`, from))?.data;
  if (!original) return;
  startEditing();
  change(() => { files.set(fileOf(`page:${slug}`), { sha: null, saved: null, data: { ...structuredClone(original), status: 'draft' } }); });
  openPage(slug);
  toast(`Kopie angelegt. Übersetzen Sie die Texte, wählen Sie „Veröffentlicht“ und speichern Sie.`);
}

function pageSettings() {
  const fields = (collection('pages')?.fields ?? []).filter((f) => f.name !== 'sections');
  const extra = el('div', { className: 've-page-extra' }, addressCard(current),
    current === 'index' ? null : button('Seite löschen', null, () => removeEntry(`page:${current}`), 've-tool ve-danger'));
  openPanel('Seiteneinstellungen', `page:${current}`, [], { fields, extra });
}

// ---- A page's address ----
// The address of a page on the site, from the host's root.
const pageAddress = (slug, l = lang) => `${base}${langPrefix(l)}${slug === 'index' ? '' : pageFile(slug)}`;
// Changing an address adds a redirect, and redirects are for administrators (gateway/roles.js).
const mayRename = (slug) => slug !== 'index' && can('content') && can('structure');
function addressCard(slug) {
  const why = slug === 'index' ? 'Die Startseite ist immer unter der Adresse der Website zu finden.'
    : mayRename(slug) ? 'Ändern Sie die Adresse, leitet die alte zur neuen weiter, und Links auf der Website führen zur neuen.'
      : 'Nur Administratoren ändern die Adresse einer Seite, weil dabei eine Weiterleitung entsteht.';
  return el('div', { className: 've-address' }, el('span', { className: 've-label' }, 'Adresse'), el('code', {}, pageAddress(slug)), el('small', { className: 've-hint' }, why),
    mayRename(slug) ? button('Adresse ändern …', null, () => renamePage(slug), 've-tool') : null);
}

// Moves a page (with its translations, which share its slug) to a new address as one unsaved
// change: the files are renamed, links in the content lead to the new address, and a page that was
// published gets a redirect from its old address.
async function renamePage(slug) {
  const answer = await promptDialog('Adresse ändern', 'Neue Adresse', slug, {
    yes: 'Ändern',
    hint: `Kleinbuchstaben, Ziffern und Bindestriche; „.html“ kommt dazu.${languages.length ? ' Die Adresse gilt für die Seite in allen Sprachen.' : ''}`,
  });
  if (!answer) return;
  const next = slugify(answer.replace(/^\/+|\.html$/gi, ''));
  if (next === slug) return;
  const all = languages.length ? languages : [lang];
  if (all.some((l) => files.has(fileOf(`page:${next}`, l)))) { toast(`Unter „${pageFile(next)}“ gibt es schon eine Seite. Bitte eine andere Adresse wählen.`, true); return; }
  startEditing();
  let unresolved = [];
  let redirected = false;
  change(() => {
    const moves = [];
    for (const l of all) {
      const path = fileOf(`page:${slug}`, l);
      const f = files.get(path);
      if (!f?.data) continue;
      files.set(fileOf(`page:${next}`, l), { sha: null, saved: null, data: f.data });
      const saved = f.saved && JSON.parse(f.saved);
      if (f.saved === null) files.delete(path); else f.data = null;
      if (saved && (saved.status ?? 'published') === 'published') moves.push({ from: pageAddress(slug, l), to: pageAddress(next, l) });
    }
    // Settings and menus of other languages are rewritten in their files; untouched copies of
    // patterns and forms are made again from the rewritten originals.
    syncViews();
    views.clear();
    for (const [path, f] of [...files]) if (unchangedCopy(path, f)) files.delete(path);
    const retarget = retargetLink(slug, next, { base, languages });
    for (const [path, f] of files) {
      if (!f.data || path === fileOf('redirects')) continue;
      const result = retargetLinks(f.data, retarget);
      if (result.changed) f.data = result.data;
      if (mentions(f.data, slug)) unresolved.push(entryTitle(path, f.data) ?? path);
    }
    if (moves.length) {
      const redirects = dataOf('redirects');
      redirects.redirects = movedRedirects(redirects.redirects, moves);
      redirected = true;
    }
    if (current === slug) current = next;
    if (selection === `page:${slug}`) selection = `page:${next}`;
  });
  unresolved = [...new Set(unresolved)];
  toast(`Neue Adresse: ${pageAddress(next)}.${redirected ? ' Die alte leitet dorthin weiter.' : ''} Mit „Speichern“ wird sie übernommen.${unresolved.length ? ` Die alte Adresse steht noch in: ${unresolved.join(', ')}. Bitte dort prüfen.` : ''}`, unresolved.length > 0);
}

// Deletes a page, post, pattern or form with the next save, after asking.
async function removeEntry(source) {
  const { kind, title } = describe(source);
  const language = languageOf(source);
  const which = language ? ` (Fassung auf ${languageName(language)})` : '';
  if (!(await confirmDialog(`${kind} löschen?`, `„${title}“${which} wird beim nächsten Speichern gelöscht. Bis dahin können Sie es mit „Rückgängig“ zurückholen.`, 'Löschen'))) return;
  // Leave the entry first: the preview cannot render a page that is gone.
  const home = slugsIn('pages').find((slug) => slug === 'index') ?? slugsIn('pages').find((slug) => `page:${slug}` !== source);
  if (source === `page:${current}`) open(`page:${home}`);
  else if (view === 'form' && selection === source) open(`page:${current}`);
  change(() => { files.get(fileOf(source)).data = null; });
}

const slugify = (title) => title.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'seite';
// A slug no entry of the folder has; a new page also takes none another language uses, which would
// make it that page's translation.
const KIND = { pages: 'page', patterns: 'pattern', forms: 'form', [postType?.name]: 'post' };
const taken = (folder, slug) => (folder === 'pages' && languages.length ? languages : [lang]).some((l) => slugsIn(folder, l).includes(slug)) || files.has(fileOf(`${KIND[folder]}:${slug}`));
const unique = (folder, slug) => { let s = slug; for (let n = 2; taken(folder, s); n++) s = `${slug}-${n}`; return s; };

async function newPage() {
  const title = await promptDialog('Neue Seite', 'Titel der Seite');
  if (!title) return;
  const slug = unique('pages', slugify(title));
  startEditing();
  change(() => { files.set(fileOf(`page:${slug}`), { sha: null, saved: null, data: { title, status: 'draft', sections: [] } }); });
  openPage(slug);
}

// A new pattern or form, opened in the form view.
async function newEntry(kind) {
  const title = await promptDialog(kind === 'pattern' ? 'Neues Muster' : 'Neues Formular', 'Name');
  if (!title) return;
  const slug = unique(FOLDERS[kind], slugify(title));
  change(() => { files.set(fileOf(`${kind}:${slug}`), { sha: null, saved: null, data: kind === 'pattern' ? { title, sections: [] } : { title } }); });
  setView('form', `${kind}:${slug}`);
}

function openPost(slug) {
  if (view === 'form') { open(`post:${slug}`); return; }
  // The page that lists the posts stays in view beside the post's details.
  const listing = postType.previewPage;
  if (listing && listing !== current && slugsIn('pages').includes(listing)) openPage(listing);
  openPanel(`${postType.singular ?? 'Beitrag'}: ${titleOf(postType.name, slug)}`, `post:${slug}`, [], {
    extra: button('Löschen', null, () => removeEntry(`post:${slug}`), 've-tool ve-danger'),
  });
}
// own: the first post of a language that has shown the default language's posts so far.
async function newPost({ own = false } = {}) {
  if (own && !(await confirmDialog(`Eigene ${postType.label} auf ${languageName(lang)}?`,
    `Sie legen den ersten Eintrag auf ${languageName(lang)} an. Sobald einer veröffentlicht ist, zeigt die Website auf ${languageName(lang)} nur noch ${postType.label}, die Sie in dieser Sprache anlegen; die auf ${languageName(defaultLang)} erscheinen dort nicht mehr.`, 'Weiter'))) return;
  const title = await promptDialog(`Neu: ${postType.singular ?? 'Beitrag'}`, 'Titel');
  if (!title) return;
  const slug = unique(postType.name, slugify(title));
  const path = own ? `${langDir()}/${postType.name}/${slug}.json` : fileOf(`post:${slug}`);
  change(() => { files.set(path, { sha: null, saved: null, data: { title, status: 'draft' } }); });
  openPost(slug);
}

// ---- Images ----
// Adds a file as an upload that is saved with the next save, scaled down first when it is larger
// than the site allows (images.js); returns its path on the site and, if it was scaled, a sentence
// that says so.
async function upload(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  let note = '';
  if (downscaleTarget(bytes, maxSize(site))) {
    toast(`„${file.name}“ wird verkleinert …`);
    const smaller = await downscale(bytes, maxSize(site)).catch(() => null);
    if (smaller) {
      const mb = (n) => `${(n / 1e6).toLocaleString('de', { maximumFractionDigits: 1 })} MB`;
      note = `„${file.name}“ war sehr groß und wurde verkleinert: ${smaller.width} × ${smaller.height} statt ${smaller.from.width} × ${smaller.from.height} Pixel, ${mb(smaller.bytes.length)} statt ${mb(bytes.length)}.`;
      bytes = smaller.bytes;
    }
  }
  const stem = file.name.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
  let path = `${mediaDir}/${stem}`;
  for (let n = 2; path in media || uploads.has(path); n++) path = `${mediaDir}/${stem.replace(/(\.[^.]+)?$/, `-${n}$1`)}`;
  uploads.set(path, { base64: encodeBase64(bytes), url: URL.createObjectURL(note ? new Blob([bytes], { type: file.type }) : file), saved: false });
  // The theme sees the new file as one of the site's images, with its size.
  media[path] = imageSize(bytes) ?? {};
  drawBar();
  return { path, note };
}
const images = () => [...new Set([...uploads.keys(), ...Object.keys(media).filter((p) => p.startsWith(`${mediaDir}/`))])].filter((p) => !removed.has(p));
// The name of a content file's entry for a list, with its language; undefined for other files.
function entryTitle(path, data) {
  let rest = path.slice(contentDir.length + 1).replace(/\.json$/, '');
  const language = languages.slice(1).find((l) => rest.startsWith(`${l}/`));
  if (language) rest = rest.slice(language.length + 1);
  const [folder, slug] = rest.split('/');
  const setting = folder === 'settings' && Object.keys(SETTINGS).find((k) => SETTINGS[k] === slug);
  const title = KIND[folder] ? data.title ?? slug : setting && describe(setting).title;
  return title ? (language ? `${title} (${languageName(language)})` : title) : undefined;
}
// The entries that name an image.
function usesOf(path) {
  return [...files].filter(([p, f]) => f.data && !unchangedCopy(p, f) && JSON.stringify(f.data).includes(path)).map(([p, f]) => entryTitle(p, f.data)).filter(Boolean);
}
function removeImage(path) {
  const u = uploads.get(path);
  if (u && !u.saved) { uploads.delete(path); delete media[path]; refresh(); drawBar(); } else change(() => removed.add(path));
}

// What the form view, the image library and the user list use of the editor.
const app = {
  site, theme, me, can, schema, branch, REPO, api, el, button,
  get selection() { return selection; },
  dataOf, describe, topFields, schemaAt, statusOf, sharedNote, fileOf,
  savedText: (source) => files.get(fileOf(source))?.saved ?? null,
  // The file's content as it will be saved (for a language's settings: what differs).
  fileData: (source) => { syncViews(); return files.get(fileOf(source))?.data ?? null; },
  // For a page the editor's language lacks: the language it exists in, to translate it from.
  translatableFrom: (source) => source.startsWith('page:') && !dataOf(source) && languages.find((l) => l !== lang && slugsIn('pages', l).includes(source.slice(5))),
  translate, languageName, addressCard,
  snapshot, pushUndo: (snap) => { undoStack.push(snap); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; },
  // After a change in a form: the top bar at once, the preview once typing pauses.
  changed() { drawBar(); clearTimeout(drawSoon); drawSoon = setTimeout(draw, 300); },
  change, open, removeEntry, confirmDialog, toast, formContext,
  replaceData: (source, data) => {
    syncViews();
    const path = fileOf(source);
    if (!files.has(path)) files.set(path, { sha: null, saved: null, data: null });
    files.get(path).data = data;
    views.clear();
  },
  images, mediaURL, upload, usesOf, removeImage, mayDeleteImages: ['administrator', 'editor'].includes(me.role),
  isUnsaved: (path) => uploads.has(path) && !uploads.get(path).saved,
};

// ---- Start ----
$('#ve-user').textContent = me.name ?? me.email;
$('#ve-site').textContent = site.name;
$('#ve-signout').addEventListener('click', () => { signOut(); location.href = './'; });
for (const b of document.querySelectorAll('.ve-views button[data-view]')) b.addEventListener('click', () => { if (b.dataset.view !== view) setView(b.dataset.view); });
$('#ve-app').hidden = false;
if (hashOpen && /^(page|post|pattern|form):/.test(hashOpen) ? dataOf(hashOpen) : ['settings', 'menus', 'redirects', 'media', 'submissions', 'users'].includes(hashOpen)) {
  if (hashOpen.startsWith('page:')) current = hashOpen.slice(5);
  selection = hashOpen;
}
setView(view, selection);
api('/tick').catch(() => {});
