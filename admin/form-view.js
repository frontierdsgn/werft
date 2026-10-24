// The form view: one entry at a time as a large, plain form with a short explanation of what it is
// and what each part does, its earlier versions, and the image library and user list. Changes go
// into the editor's unsaved changes like those made on the page; "Speichern" stores both.
import { buildForm } from './visual-form.js';
import { versionDiff, diffHTML } from './diff.js';
import { setupTwoFactor, recoveryCodes } from './two-factor.js';
import { t, locale, intlLocale } from './i18n.js';

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
};
const dateTime = (iso) => new Date(iso).toLocaleString(intlLocale(), { dateStyle: 'long', timeStyle: 'short' });

// What a kind of entry is, in a sentence, above its form.
const lead = (kind) => ({
  page: t('lead.page'),
  post: t('lead.post'),
  pattern: t('lead.pattern'),
  form: t('lead.form'),
  settings: t('lead.settings'),
  menus: t('lead.menus'),
  redirects: t('lead.redirects'),
})[kind];
const statusHelp = (status) => ({
  draft: t('status.draftHelp'),
  pending: t('status.pendingHelp'),
  published: t('status.publishedHelp'),
})[status];
// A role's name; one the admin does not know by the gateway's label.
const roleName = (role, roles = {}) => ({
  administrator: t('role.administrator'),
  editor: t('role.editor'),
  author: t('role.author'),
  contributor: t('role.contributor'),
})[role] ?? roles[role]?.label ?? role;
const roleHelp = (role) => ({
  administrator: t('role.administratorHelp'),
  editor: t('role.editorHelp'),
  author: t('role.authorHelp'),
  contributor: t('role.contributorHelp'),
})[role];

// Which list entries are open, per entry, while the editor is open.
const openByEntry = new Map();

function head(app, kind, title, lead, note) {
  return el('header', { className: 've-form-head' },
    el('p', { className: 've-kind' }, kind),
    el('h1', {}, title),
    lead ? el('p', { className: 've-lead' }, lead) : null,
    note ? el('p', { className: 've-note' }, note) : null);
}
const card = (title, lead, ...children) => el('section', { className: 've-card' }, title ? el('h2', {}, title) : null, lead ? el('p', { className: 've-hint' }, lead) : null, ...children);

// One entry (page, post, pattern, form) or settings file. Returns { reveal(path) }, which opens and
// shows a list entry, e.g. the section clicked in the preview.
export function formView(app, root) {
  const source = app.selection;
  const data = app.dataOf(source);
  const [type, slug] = source.split(':');
  const { kind, title } = app.describe(source);
  const from = !data && app.translatableFrom(source);
  if (from) {
    // A page of another language, not translated into the editor's language yet.
    root.replaceChildren(el('div', { className: 've-form-page' }, head(app, kind, title, t('translate.lead', { language: app.languageName(from) })),
      card(null, null, el('div', { className: 've-actions-row' }, app.button(t('translate'), null, () => app.translate(slug), 've-primary')))));
    return { reveal() {} };
  }
  if (!data) {
    root.replaceChildren(el('div', { className: 've-form-page' }, head(app, kind, title, t('entry.deleted'))));
    return { reveal() {} };
  }
  const fields = app.topFields(source) ?? [];
  if (!openByEntry.has(source)) openByEntry.set(source, new Set());

  // Undo steps: everything typed into one field is one step, each button press another.
  let last = app.snapshot();
  let started = false;
  const ctx = {
    ...app.formContext(() => {
      if (!started) { app.pushUndo(last); started = true; }
      app.changed();
      page.querySelector('.ve-form-head h1').textContent = app.describe(source).title;
    }),
    openItems: openByEntry.get(source),
    radios: true,
    confirmRemove: (label) => app.confirmDialog(t('remove.title'), t('remove.text', { label }), t('remove')),
  };
  const page = el('div', { className: 've-form-page' });
  page.addEventListener('focusin', (event) => { if (event.target.closest('input, textarea, select, [contenteditable]')) { last = app.snapshot(); started = false; } });
  page.addEventListener('click', (event) => { if (event.target.closest('button')) { last = app.snapshot(); started = false; } }, true);

  const named = (...names) => fields.filter((f) => names.includes(f.name));
  const rest = fields.filter((f) => !['status', 'publish_date', 'seo', 'sections'].includes(f.name));
  page.append(head(app, kind, title, lead(type), app.sharedNote(source)));
  page.append(card(null, null, buildForm(rest, data, ctx)));
  if (type === 'page') page.append(card(null, null, app.addressCard(slug)));

  if (named('sections').length) {
    page.append(card(t('sections'), type === 'page' ? t('sections.pageLead') : t('sections.patternLead'),
    buildForm(named('sections'), data, ctx)));
  }

  const status = named('status')[0];
  if (status) {
    const options = (status.options ?? []).map((o) => (typeof o === 'object' ? o : { label: o, value: o }));
    const group = el('div', { className: 've-choices', role: 'radiogroup', 'aria-label': t('visibility') });
    for (const o of options) {
      const input = el('input', { type: 'radio', name: 've-status', checked: (data.status ?? 'published') === o.value });
      input.addEventListener('change', () => { last = app.snapshot(); started = false; data.status = o.value; ctx.onChange(); });
      group.append(el('label', { className: 've-choice' }, input, el('span', {}, el('strong', {}, o.label), el('small', {}, statusHelp(o.value) ?? ''))));
    }
    page.append(card(t('visibility'), null, group, buildForm(named('publish_date'), data, ctx)));
  }
  if (named('seo').length) page.append(buildForm(named('seo'), data, ctx));

  page.append(versions(app, source));
  if (type === 'page' || type === 'post') page.append(previewLinks(app, source));
  const actions = [
    type === 'page' && app.can('content') ? app.button(t('page.duplicateMore'), null, () => app.duplicate(slug), 've-tool') : null,
    ['post', 'pattern', 'form'].includes(type) || (type === 'page' && slug !== 'index') ? app.button(t('delete.kindMore', { kind }), null, () => app.removeEntry(source), 've-tool ve-danger') : null,
  ].filter(Boolean);
  if (actions.length) page.append(card(null, null, el('div', { className: 've-actions-row' }, ...actions)));
  root.replaceChildren(page);

  return {
    reveal(path) {
      const item = page.querySelector(`[data-path='${JSON.stringify(path)}']`);
      if (!item) return;
      item.open = true;
      item.scrollIntoView({ block: 'start', behavior: 'smooth' });
      item.classList.remove('ve-flash');
      void item.offsetWidth;
      item.classList.add('ve-flash');
    },
  };
}

// The saved versions of an entry, newest first, each restorable as an unsaved change.
function versions(app, source) {
  const path = app.fileOf(source);
  const list = el('div', { className: 've-versions' });
  const load = app.button(t('versions.show'), null, async () => {
    load.disabled = true;
    load.textContent = t('loading');
    try {
      const commits = await app.api(`${app.REPO}/commits?sha=${encodeURIComponent(app.branch)}&path=${encodeURIComponent(path)}&limit=30`);
      load.remove();
      if (!commits.length) { list.append(el('p', { className: 've-hint' }, t('versions.none'))); return; }
      list.append(...commits.map((c, i) => version(app, source, path, c, i === 0)));
    } catch (error) {
      load.disabled = false;
      load.textContent = t('versions.show');
      app.toast(t('versions.failed', { message: error.message }), true);
    }
  }, 've-tool');
  return card(t('versions'), t('versions.lead'), list, load);
}

// Links that show the saved entry, drafts too, to people without an account, until they expire or
// are revoked (gateway/core.js). Loaded on request, since listing them reads the repository.
function previewLinks(app, source) {
  const path = app.fileOf(source);
  const list = el('div', { className: 've-versions' });
  const days = el('select', { ariaLabel: t('previewLink.validFor') }, ...[1, 7, 30].map((value) => el('option', { value, selected: value === 7 }, t('previewLink.days', { count: value }))));
  const draw = (previews) => list.replaceChildren(...(previews.length ? previews.map((link) => {
    const url = new URL(link.url, location.origin).href;
    const field = el('input', { type: 'text', readOnly: true, value: url, ariaLabel: t('previewLink') });
    return el('div', { className: 've-version' },
      el('div', { className: 've-control' }, field, el('small', {}, t('previewLink.validUntil', { date: dateTime(link.expires_at), by: link.by }))),
      el('div', { className: 've-actions-row' },
        app.button(t('copy'), null, async () => {
          try { await navigator.clipboard.writeText(url); app.toast(t('previewLink.copied')); } catch { field.select(); app.toast(t('previewLink.selected')); }
        }, 've-tool'),
        app.button(t('previewLink.revoke'), null, async () => {
          if (!(await app.confirmDialog(t('previewLink.revokeTitle'), t('previewLink.revokeText'), t('previewLink.revoke')))) return;
          send({ path, revoke: link.id }, t('previewLink.revoked'));
        }, 've-tool ve-danger')));
  }) : [el('p', { className: 've-hint' }, t('previewLink.none'))]));
  const send = async (body, done) => {
    try { draw((await app.api('/previews', body ? { method: 'POST', body } : undefined)).previews); if (done) app.toast(done); } catch (error) { app.toast(error.message, true); }
  };
  const load = app.button(t('previewLink.show'), null, async () => {
    load.disabled = true;
    try { draw((await app.api(`/previews?path=${encodeURIComponent(path)}`)).previews); load.replaceWith(el('div', { className: 've-actions-row' }, el('div', { className: 've-control' }, days), app.button(t('previewLink.create'), null, () => send({ path, days: Number(days.value) }, t('previewLink.created')), 've-tool'))); } catch (error) { load.disabled = false; app.toast(error.message, true); }
  }, 've-tool');
  return card(t('previewLink'), t('previewLink.lead'), list, load);
}

function version(app, source, path, commit, newest) {
  const { date, name } = commit.commit.author;
  const row = el('div', { className: 've-version' },
    el('div', {}, el('strong', {}, dateTime(date)), el('small', {}, `${name} · ${commit.commit.message.split('\n')[0]}`)));
  const read = async () => {
    const response = await app.api(`${app.REPO}/raw/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commit.sha}`, { raw: true });
    if (!response.ok) throw new Error(t('version.unreadable'));
    return response.text();
  };
  if (newest && app.savedText(source) !== null) row.append(el('span', { className: 've-badge' }, t('version.saved')));
  const diff = el('details', { className: 've-diff' }, el('summary', {}, t('version.diff')));
  diff.addEventListener('toggle', async () => {
    if (!diff.open || diff.dataset.loaded) return;
    diff.dataset.loaded = '1';
    try {
      const lines = versionDiff(`${JSON.stringify(app.fileData(source) ?? {}, null, 2)}\n`, await read());
      const pre = el('pre');
      if (lines.some(([k]) => k !== ' ')) pre.innerHTML = diffHTML(lines); else pre.textContent = t('version.same');
      diff.append(el('p', { className: 've-hint' }, t('version.diffHint')), pre);
    } catch (error) { diff.append(el('p', { className: 've-error' }, error.message)); }
  });
  row.append(app.button(t('version.restore'), null, async () => {
    if (!(await app.confirmDialog(t('version.restoreTitle'), t('version.restoreText', { date: dateTime(date) }), t('version.restoreYes')))) return;
    try {
      const data = JSON.parse(await read());
      app.change(() => app.replaceData(source, data));
      app.toast(t('version.restored'));
    } catch (error) { app.toast(t('version.restoreFailed', { message: error.message }), true); }
  }, 've-tool'), diff);
  return row;
}

// What the image library is narrowed to, kept while the editor is open.
const library = { query: '', filter: 'all' };

// All images of the site, with where they are used and whether an alternative text is missing
// there; new ones are uploaded here, and one can be replaced everywhere at once.
export function mediaView(app, root) {
  const draw = () => mediaView(app, root);
  const input = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp', multiple: true });
  input.addEventListener('change', async () => {
    const notes = [];
    for (const file of input.files) notes.push((await app.upload(file)).note);
    app.toast([t('images.added', { count: input.files.length }), ...notes.filter(Boolean)].join(' '), false, notes.some(Boolean));
    draw();
  });
  const upload = el('label', { className: 've-primary ve-upload' }, t('images.upload'), input);
  const fileName = (path) => path.split('/').pop();
  const images = app.images().sort((a, b) => fileName(a).localeCompare(fileName(b), locale()))
    .map((path) => ({ path, name: fileName(path), used: app.usesOf(path), ...app.altsOf(path) }));
  const filters = {
    all: [t('images.all'), () => true],
    unused: [t('images.unused'), (image) => !image.used.length],
    noalt: [t('images.noAlt'), (image) => image.missing.length > 0],
  };
  const matches = (image) => {
    const text = [image.name, ...image.alts, ...image.used].join(' ').toLocaleLowerCase(locale());
    return filters[library.filter][1](image) && library.query.toLocaleLowerCase(locale()).split(/\s+/).every((word) => text.includes(word));
  };
  const replace = (image) => {
    const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp' });
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      let added;
      try { added = await app.upload(file.files[0]); } catch (error) { app.toast(t('images.uploadFailed', { message: error.message }), true); return; }
      const left = app.replaceImage(image.path, added.path);
      const name = fileName(added.path);
      const where = left.length ? t('images.replacedLeft', { name, old: image.name, entries: left.join(', ') })
        : image.used.length ? t('images.replacedAll', { name, old: image.name, entries: image.used.join(', ') }) : t('images.replaced', { name, old: image.name });
      app.toast([where, t('images.saveToPublish'), added.note].filter(Boolean).join(' '), false, true);
      draw();
    });
    const label = el('label', { className: 've-tool ve-upload', title: t('images.replaceTitle', { name: image.name }) }, t('images.replace'), file);
    return label;
  };
  const item = (image) => {
    const node = el('li', {}, el('img', { src: app.mediaURL(image.path), alt: '', loading: 'lazy' }),
      el('strong', {}, image.name),
      el('small', {}, image.used.length ? t('images.usedOn', { entries: image.used.join(', ') }) : t('images.notUsed')),
      image.missing.length ? el('small', { className: 've-alt-missing' }, t('images.noAltOn', { entries: image.missing.join(', ') })) : null);
    if (app.isUnsaved(image.path)) node.append(el('span', { className: 've-badge' }, t('images.unsaved')));
    const tools = el('div', { className: 've-actions-row' });
    if (app.mayDeleteImages) tools.append(replace(image));
    if (app.mayDeleteImages && !image.used.length) {
      tools.append(app.button(t('delete'), t('deleteThing', { name: image.name }), async () => {
        if (await app.confirmDialog(t('images.deleteTitle'), t('images.deleteText', { name: image.name }), t('delete'))) app.removeImage(image.path);
      }, 've-tool ve-danger'));
    }
    if (tools.childElementCount) node.append(tools);
    return node;
  };
  const list = el('div');
  const showList = () => {
    const shown = images.filter(matches);
    list.replaceChildren(shown.length ? el('ul', { className: 've-library' }, ...shown.map(item))
      : card(null, images.length ? t('images.noMatch') : t('images.none')));
  };
  const search = el('input', { type: 'search', value: library.query, placeholder: t('images.searchPlaceholder') });
  search.setAttribute('aria-label', t('images.search'));
  search.addEventListener('input', () => { library.query = search.value; showList(); });
  const filter = el('select', {}, ...Object.entries(filters).map(([value, [label, test]]) => el('option', { value, selected: value === library.filter }, `${label} (${images.filter(test).length})`)));
  filter.setAttribute('aria-label', t('images.filter'));
  filter.addEventListener('change', () => { library.filter = filter.value; showList(); });
  showList();
  root.replaceChildren(el('div', { className: 've-form-page ve-wide-page' },
    head(app, t('site'), t('images'), t('images.lead')),
    el('p', { className: 've-actions-row' }, upload),
    images.length ? el('p', { className: 've-actions-row ve-library-tools' }, search, filter) : null,
    list));
  return { reveal() {} };
}

// Pages, posts, patterns and forms deleted in the history, each restorable as an unsaved change.
export function deletedView(app, root) {
  const page = el('div', { className: 've-form-page' }, head(app, t('site'), t('deleted'), t('deleted.lead')));
  root.replaceChildren(page);
  if (!app.can('content')) { page.append(card(null, t('deleted.notAllowed'))); return { reveal() {} }; }
  const list = card(null, null, el('p', { className: 've-hint' }, t('searching')));
  page.append(list);
  const load = (limit) => app.findDeleted(limit).then(({ entries, searched, more }) => {
    list.replaceChildren(
      el('p', { className: 've-hint' }, t('deleted.searched', { count: searched })),
      entries.length ? el('ul', { className: 've-people' }, ...entries.map((e) => el('li', {},
        el('div', {}, el('strong', {}, t('deleted.entry', { kind: e.kindName, title: e.title })), el('small', {}, `${t('deleted.when', { date: dateTime(e.deleted.date), author: e.deleted.author })}${e.language ? ` · ${e.language}` : ''}`)),
        app.button(t('deleted.restore'), t('deleted.restoreTitle', { kind: e.kindName, title: e.title }), () => app.restoreDeleted(e), 've-tool'))))
        : el('p', {}, t('deleted.none')),
      ...(more ? [el('div', { className: 've-actions-row' }, app.button(t('deleted.searchMore'), null, () => { list.replaceChildren(el('p', { className: 've-hint' }, t('searching'))); load(100); }, 've-tool'))] : []));
  }, (e) => { list.replaceChildren(el('p', { className: 've-error', role: 'alert' }, t('deleted.failed', { message: e.message }))); });
  load(30);
  return { reveal() {} };
}

// Who may edit the site. Each change applies at once.
// What visitors sent through the site's forms (gateway/submissions.js): read, download as CSV,
// delete. Like users, a deletion is stored at once.
export function submissionsView(app, root) {
  const page = el('div', { className: 've-form-page' }, head(app, t('site'), t('submissions'), t('submissions.lead')));
  root.replaceChildren(page);
  if (!app.can('content')) { page.append(card(null, t('submissions.notAllowed'))); return { reveal() {} }; }
  const list = el('div', {}, card(null, null, el('p', { className: 've-hint' }, t('loading'))));
  page.append(list);
  const text = (value) => [value].flat().join(', ');
  const download = (form) => {
    const names = [...new Set(form.submissions.flatMap((s) => Object.keys(s.fields)))];
    const cell = (value) => `"${String(value).replace(/"/g, '""')}"`;
    const rows = [[t('submissions.received'), ...names], ...form.submissions.map((s) => [s.received_at, ...names.map((n) => text(s.fields[n] ?? ''))])];
    // The byte order mark makes Excel read the file as UTF-8.
    const blob = new Blob([`﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const link = el('a', { href: URL.createObjectURL(blob), download: `${form.slug}.csv` });
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const draw = (forms) => {
    list.replaceChildren(...(forms.length ? forms.map((form) => card(`${form.title} (${form.submissions.length})`, form.submissions.length ? null : t('submissions.none'),
      form.submissions.length ? el('div', { className: 've-actions-row' }, app.button(t('submissions.download'), t('submissions.downloadTitle', { title: form.title }), () => download(form), 've-tool')) : null,
      el('ul', { className: 've-people ve-submissions' }, ...form.submissions.map((s) => el('li', {},
        el('div', {}, el('strong', {}, dateTime(s.received_at)), ...Object.entries(s.fields).map(([name, value]) => el('small', {}, `${name}: ${text(value)}`))),
        app.button(t('delete'), t('submissions.deleteThing', { date: dateTime(s.received_at) }), async () => {
          if (await app.confirmDialog(t('submissions.deleteTitle'), t('submissions.deleteText'), t('delete'))) load({ method: 'POST', body: { delete: [s.id] } });
        }, 've-tool ve-danger'))))))
      : [card(null, t('submissions.noForms'))]));
  };
  const load = (options) => app.api('/submissions', options).then(({ forms }) => { draw(forms); if (options) app.toast(t('submissions.deleted')); },
    (e) => { list.replaceChildren(card(null, null, el('p', { className: 've-error', role: 'alert' }, e.message))); });
  load();
  return { reveal() {} };
}

export function usersView(app, root) {
  const page = el('div', { className: 've-form-page' }, head(app, t('site'), t('users'), t('users.lead')));
  root.replaceChildren(page);
  if (app.me.role !== 'administrator') { page.append(card(null, t('users.notAllowed'))); return { reveal() {} }; }
  const listCard = card(t('users.all'), null, el('p', { className: 've-hint' }, t('loading')));
  const formCard = el('section', { className: 've-card' });
  page.append(listCard, formCard);
  let users = [], roles = {};
  const error = el('p', { className: 've-error', role: 'alert' });

  const send = async (body) => {
    error.textContent = '';
    try { ({ users } = await app.api('/users', { method: 'POST', body })); drawList(); return true; } catch (e) { error.textContent = e.message; return false; }
  };
  const drawList = () => {
    listCard.replaceChildren(el('h2', {}, t('users.all')), el('ul', { className: 've-people' }, ...users.map((u) => el('li', {},
      el('div', {}, el('strong', {}, u.name || u.email), el('small', {}, `${u.email} · ${roleName(u.role, roles)}${u.two_factor ? ` · ${t('users.twoFactor')}` : ''}${u.email === app.me.email ? ` · ${t('users.you')}` : ''}`)),
      el('div', { className: 've-actions-row' },
        app.button(t('edit'), t('editThing', { name: u.name || u.email }), () => drawForm(u), 've-tool'),
        app.button(t('signOutEverywhere'), t('users.signOutTitle', { name: u.name || u.email }), async () => {
          const self = u.email === app.me.email;
          if (!(await app.confirmDialog(t('signOutEverywhere.title'), self ? t('signOutEverywhere.self') : t('users.signOutText', { name: u.name || u.email }), t('signOut')))) return;
          if (self) app.signOut({ everywhere: true });
          else if (await send({ action: 'signout', email: u.email })) app.toast(t('users.signedOut', { name: u.name || u.email }));
        }, 've-tool'),
        u.two_factor && u.email !== app.me.email ? app.button(t('users.twoFactorReset'), t('users.twoFactorResetTitle', { name: u.name || u.email }), async () => {
          if (!(await app.confirmDialog(t('users.twoFactorResetQuestion'), t('users.twoFactorResetText', { name: u.name || u.email }), t('reset')))) return;
          if (await send({ action: 'two-factor-off', email: u.email })) app.toast(t('users.twoFactorResetDone'));
        }, 've-tool') : null,
        u.email === app.me.email ? null : app.button(t('delete'), t('deleteThing', { name: u.name || u.email }), async () => {
          if (await app.confirmDialog(t('users.deleteTitle'), t('users.deleteText', { name: u.name || u.email }), t('delete'))) send({ action: 'delete', email: u.email });
        }, 've-tool ve-danger'))))));
  };
  const drawForm = (user = null) => {
    const form = el('form', { className: 've-form ve-user-form' });
    const field = (label, input, hint) => el('div', { className: 've-control' }, el('label', { className: 've-label', htmlFor: input.id }, label), hint ? el('small', { className: 've-hint' }, hint) : null, input);
    const name = el('input', { id: 've-user-name', type: 'text', value: user?.name ?? '', required: true, autocomplete: 'off' });
    const email = el('input', { id: 've-user-email', type: 'email', value: user?.email ?? '', required: true, readOnly: !!user, autocomplete: 'off' });
    const password = el('input', { id: 've-user-password', type: 'password', minLength: 10, required: !user, autocomplete: 'new-password' });
    const choices = el('div', { className: 've-choices', role: 'radiogroup', 'aria-label': t('users.role') }, ...Object.keys(roles).map((id) => el('label', { className: 've-choice' },
      el('input', { type: 'radio', name: 've-role', value: id, checked: (user?.role ?? 'editor') === id }),
      el('span', {}, el('strong', {}, roleName(id, roles)), el('small', {}, roleHelp(id) ?? '')))));
    form.append(field(t('name'), name), field(t('users.email'), email, user ? t('users.emailFixed') : t('users.emailNew')),
      el('div', { className: 've-control' }, el('span', { className: 've-label' }, t('users.mayDo')), choices),
      field(t('password'), password, user ? t('users.passwordKeep') : t('users.passwordNew')),
      error,
      el('div', { className: 've-actions-row' }, el('button', { type: 'submit', className: 've-primary' }, user ? t('users.apply') : t('users.create')),
        user ? app.button(t('cancel'), null, () => drawForm(), 've-tool') : null));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = { email: email.value, name: name.value, role: form.querySelector('input[name=ve-role]:checked')?.value, ...(password.value && { password: password.value }) };
      if (await send(body)) { app.toast(user ? t('users.changed') : t('users.created')); drawForm(); }
    });
    formCard.replaceChildren(el('h2', {}, user ? t('editThing', { name: user.name || user.email }) : t('users.new')), form);
    if (user) { formCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); name.focus({ preventScroll: true }); }
  };
  app.api('/users').then((result) => { ({ users, roles } = result); drawList(); drawForm(); }, (e) => { listCard.replaceChildren(el('p', { className: 've-error' }, e.message)); });
  return { reveal() {} };
}

// "Mein Konto", for every role: one's own name and password, and signing out on all devices.
export function accountView(app, root) {
  const page = el('div', { className: 've-form-page' }, head(app, t('account.kind'), t('account'), t('account.lead', { email: app.me.email })));
  root.replaceChildren(page);
  const field = (label, input, hint) => el('div', { className: 've-control' }, el('label', { className: 've-label', htmlFor: input.id }, label), hint ? el('small', { className: 've-hint' }, hint) : null, input);
  const form = (card, inputs, submit, onSubmit) => {
    const error = el('p', { className: 've-error', role: 'alert' });
    const f = el('form', { className: 've-form ve-user-form' }, ...inputs, error, el('div', { className: 've-actions-row' }, el('button', { type: 'submit', className: 've-primary' }, submit)));
    f.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.textContent = '';
      try { await onSubmit(); } catch (e) { error.textContent = e.message; }
    });
    card.append(f);
    return card;
  };

  const name = el('input', { id: 've-account-name', type: 'text', value: app.me.name ?? '', required: true, maxLength: 100, autocomplete: 'name' });
  const nameCard = form(card(t('name'), t('account.nameLead')), [field(t('name'), name)], t('account.saveName'), async () => {
    const result = await app.api('/me', { method: 'POST', body: { name: name.value } });
    app.me.name = result.name;
    document.querySelector('#ve-user').textContent = result.name;
    app.toast(t('account.nameSaved'));
  });

  const current = el('input', { id: 've-account-current', type: 'password', required: true, autocomplete: 'current-password' });
  const next = el('input', { id: 've-account-new', type: 'password', required: true, minLength: 10, autocomplete: 'new-password' });
  const repeat = el('input', { id: 've-account-repeat', type: 'password', required: true, minLength: 10, autocomplete: 'new-password' });
  const passwordCard = form(card(t('account.password'), t('account.passwordLead')),
    [field(t('account.currentPassword'), current), field(t('password.new'), next, t('password.min')), field(t('password.repeat'), repeat)], t('account.password'), async () => {
      if (next.value !== repeat.value) throw new Error(t('account.passwordsDiffer'));
      await app.api('/me', { method: 'POST', body: { password: next.value, current_password: current.value } });
      for (const input of [current, next, repeat]) input.value = '';
      app.toast(t('account.passwordChanged'));
    });

  const devices = card(t('account.devices'), t('account.devicesLead'),
    el('div', { className: 've-actions-row' }, app.button(t('signOutEverywhere'), null, async () => {
      if (await app.confirmDialog(t('signOutEverywhere.title'), t('signOutEverywhere.self'), t('signOut'))) app.signOut({ everywhere: true });
    }, 've-tool')));
  page.append(nameCard, passwordCard, twoFactorCard(app), devices);
  return { reveal() {} };
}

// "Zwei-Faktor-Anmeldung" in "Mein Konto": off, it offers to set it up; on, new recovery codes and
// switching it off (not where the site requires it), each with the password.
function twoFactorCard(app) {
  const section = card(t('twoFactor'), null);
  const body = el('div');
  section.append(body);
  const withPassword = (label, action, then) => {
    const password = el('input', { id: `ve-2fa-${action}`, type: 'password', autocomplete: 'current-password', required: true });
    const error = el('p', { className: 've-error', role: 'alert' });
    const form = el('form', { className: 've-form ve-user-form' }, el('div', { className: 've-control' }, el('label', { className: 've-label', htmlFor: password.id }, t('twoFactor.confirmPassword')), password), error,
      el('div', { className: 've-actions-row' }, el('button', { type: 'submit', className: 've-primary' }, label), app.button(t('cancel'), null, draw, 've-tool')));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try { then(await app.api('/me/two-factor', { method: 'POST', body: { action, current_password: password.value } })); } catch (e) { error.textContent = e.message; }
    });
    body.replaceChildren(form);
    password.focus();
  };
  const draw = () => {
    if (!app.me.two_factor) {
      body.replaceChildren(el('p', { className: 've-hint' }, t('twoFactor.off')), el('div'));
      setupTwoFactor(body.lastChild, { api: app.api, siteName: app.site.name, onDone: (result) => { Object.assign(app.me, { two_factor: true, recovery_left: result.recovery_codes.length }); app.toast(t('twoFactor.enabled')); draw(); } });
      return;
    }
    body.replaceChildren(
      el('p', { className: 've-hint' }, t('twoFactor.on', { count: app.me.recovery_left ?? 0 })),
      el('div', { className: 've-actions-row' },
        app.button(t('twoFactor.newCodes'), null, () => withPassword(t('twoFactor.makeCodes'), 'recovery', (result) => {
          app.me.recovery_left = result.recovery_codes.length;
          body.replaceChildren(el('p', { className: 've-hint' }, t('twoFactor.oldCodes')), recoveryCodes(result.recovery_codes, app.site.name, draw, t('done')));
        }), 've-tool'),
        app.me.two_factor_mandatory ? null : app.button(t('twoFactor.disable'), null, () => withPassword(t('twoFactor.disable'), 'disable', () => { Object.assign(app.me, { two_factor: false, recovery_left: null }); app.toast(t('twoFactor.disabled')); draw(); }), 've-tool ve-danger')));
  };
  draw();
  return section;
}
