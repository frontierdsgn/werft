// The form view: one entry at a time as a large, plain form with a short explanation of what it is
// and what each part does, its earlier versions, and the image library and user list. Changes go
// into the editor's unsaved changes like those made on the page; "Speichern" stores both.
import { buildForm } from './visual-form.js';
import { versionDiff, diffHTML } from './diff.js';

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
};
const dateTime = (iso) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'long', timeStyle: 'short' });

// What a kind of entry is, in a sentence, above its form.
const LEADS = {
  page: 'Hier ändern Sie Titel, Texte und Bilder dieser Seite. Rechts sehen Sie, wie die Seite aussehen wird.',
  post: 'Hier ändern Sie diesen Eintrag. Rechts sehen Sie, wie er auf der Website erscheint.',
  pattern: 'Ein Muster ist eine Gruppe von Abschnitten, die auf mehreren Seiten gleich erscheint, zum Beispiel eine Anfahrtsbeschreibung.',
  form: 'Ein Formular, das Besucher auf der Website ausfüllen. Hier legen Sie seine Felder und Texte fest.',
  settings: 'Angaben, die für die ganze Website gelten.',
  menus: 'Die Menüs der Website. Ein Eintrag besteht aus dem Text, den Besucher sehen, und der Seite, zu der er führt.',
  redirects: 'Wenn sich die Adresse einer Seite ändert, leitet eine Weiterleitung Besucher der alten Adresse zur neuen.',
};
const STATUS_HELP = {
  draft: 'Nur hier im Editor zu sehen. Besucher der Website sehen es nicht.',
  pending: 'Wartet darauf, dass die Redaktion es freigibt.',
  published: 'Für alle Besucher sichtbar, sobald Sie speichern.',
};
const ROLE_HELP = {
  administrator: 'Darf alles, auch Website-Einstellungen und Benutzer.',
  editor: 'Darf alle Seiten, Beiträge und Bilder bearbeiten.',
  author: 'Darf eigene Beiträge schreiben und veröffentlichen und Bilder hochladen.',
  contributor: 'Darf eigene Beiträge schreiben, aber nicht veröffentlichen.',
};

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
    root.replaceChildren(el('div', { className: 've-form-page' }, head(app, kind, title, `Diese Seite gibt es auf ${app.languageName(from)}, aber noch nicht in dieser Sprache. „Übersetzen“ legt eine Kopie an; dann ersetzen Sie die Texte durch die Übersetzung.`),
      card(null, null, el('div', { className: 've-actions-row' }, app.button('Übersetzen', null, () => app.translate(slug), 've-primary')))));
    return { reveal() {} };
  }
  if (!data) {
    root.replaceChildren(el('div', { className: 've-form-page' }, head(app, kind, title, 'Dieser Eintrag ist gelöscht. Mit „Rückgängig“ holen Sie ihn zurück.')));
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
    confirmRemove: (label) => app.confirmDialog('Entfernen?', `„${label}“ wird entfernt. Mit „Rückgängig“ holen Sie es zurück, solange Sie nicht gespeichert haben.`, 'Entfernen'),
  };
  const page = el('div', { className: 've-form-page' });
  page.addEventListener('focusin', (event) => { if (event.target.closest('input, textarea, select, [contenteditable]')) { last = app.snapshot(); started = false; } });
  page.addEventListener('click', (event) => { if (event.target.closest('button')) { last = app.snapshot(); started = false; } }, true);

  const named = (...names) => fields.filter((f) => names.includes(f.name));
  const rest = fields.filter((f) => !['status', 'publish_date', 'seo', 'sections'].includes(f.name));
  page.append(head(app, kind, title, LEADS[type], app.sharedNote(source)));
  page.append(card(null, null, buildForm(rest, data, ctx)));
  if (type === 'page') page.append(card(null, null, app.addressCard(slug)));

  if (named('sections').length) {
    page.append(card('Abschnitte', type === 'page'
      ? 'Die Seite besteht aus Abschnitten, von oben nach unten. Öffnen Sie einen Abschnitt, um ihn zu bearbeiten, oder klicken Sie rechts in der Vorschau darauf.'
      : 'Die Abschnitte dieses Musters, von oben nach unten.',
    buildForm(named('sections'), data, ctx)));
  }

  const status = named('status')[0];
  if (status) {
    const options = (status.options ?? []).map((o) => (typeof o === 'object' ? o : { label: o, value: o }));
    const group = el('div', { className: 've-choices', role: 'radiogroup', 'aria-label': 'Sichtbarkeit' });
    for (const o of options) {
      const input = el('input', { type: 'radio', name: 've-status', checked: (data.status ?? 'published') === o.value });
      input.addEventListener('change', () => { last = app.snapshot(); started = false; data.status = o.value; ctx.onChange(); });
      group.append(el('label', { className: 've-choice' }, input, el('span', {}, el('strong', {}, o.label), el('small', {}, STATUS_HELP[o.value] ?? ''))));
    }
    page.append(card('Sichtbarkeit', null, group, buildForm(named('publish_date'), data, ctx)));
  }
  if (named('seo').length) page.append(buildForm(named('seo'), data, ctx));

  page.append(versions(app, source));
  const actions = [
    type === 'page' && app.can('content') ? app.button('Seite duplizieren …', null, () => app.duplicate(slug), 've-tool') : null,
    ['post', 'pattern', 'form'].includes(type) || (type === 'page' && slug !== 'index') ? app.button(`${kind} löschen …`, null, () => app.removeEntry(source), 've-tool ve-danger') : null,
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
  const load = app.button('Frühere Versionen anzeigen', null, async () => {
    load.disabled = true;
    load.textContent = 'Wird geladen …';
    try {
      const commits = await app.api(`${app.REPO}/commits?sha=${encodeURIComponent(app.branch)}&path=${encodeURIComponent(path)}&limit=30`);
      load.remove();
      if (!commits.length) { list.append(el('p', { className: 've-hint' }, 'Noch nicht gespeichert, daher gibt es keine früheren Versionen.')); return; }
      list.append(...commits.map((c, i) => version(app, source, path, c, i === 0)));
    } catch (error) {
      load.disabled = false;
      load.textContent = 'Frühere Versionen anzeigen';
      app.toast(`Versionen konnten nicht geladen werden: ${error.message}`, true);
    }
  }, 've-tool');
  return card('Frühere Versionen', 'Jedes Speichern legt eine Version an. Eine frühere Version können Sie ansehen und zurückholen.', list, load);
}

function version(app, source, path, commit, newest) {
  const { date, name } = commit.commit.author;
  const row = el('div', { className: 've-version' },
    el('div', {}, el('strong', {}, dateTime(date)), el('small', {}, `${name} · ${commit.commit.message.split('\n')[0]}`)));
  const read = async () => {
    const response = await app.api(`${app.REPO}/raw/${path.split('/').map(encodeURIComponent).join('/')}?ref=${commit.sha}`, { raw: true });
    if (!response.ok) throw new Error('Version nicht lesbar');
    return response.text();
  };
  if (newest && app.savedText(source) !== null) row.append(el('span', { className: 've-badge' }, 'Gespeicherter Stand'));
  const diff = el('details', { className: 've-diff' }, el('summary', {}, 'Unterschiede zu jetzt'));
  diff.addEventListener('toggle', async () => {
    if (!diff.open || diff.dataset.loaded) return;
    diff.dataset.loaded = '1';
    try {
      const lines = versionDiff(`${JSON.stringify(app.fileData(source) ?? {}, null, 2)}\n`, await read());
      const pre = el('pre');
      pre.innerHTML = lines.some(([k]) => k !== ' ') ? diffHTML(lines) : 'Keine inhaltlichen Unterschiede.';
      diff.append(el('p', { className: 've-hint' }, 'Rot: steht jetzt da. Grün: stand in dieser Version.'), pre);
    } catch (error) { diff.append(el('p', { className: 've-error' }, error.message)); }
  });
  row.append(app.button('Diese Version zurückholen', null, async () => {
    if (!(await app.confirmDialog('Version zurückholen?', `Der Inhalt vom ${dateTime(date)} ersetzt den jetzigen. Erst mit „Speichern“ wird er übernommen; mit „Rückgängig“ geht es zurück.`, 'Zurückholen'))) return;
    try {
      const data = JSON.parse(await read());
      app.change(() => app.replaceData(source, data));
      app.toast('Ältere Version übernommen. Prüfen Sie sie und klicken Sie dann auf „Speichern“.');
    } catch (error) { app.toast(`Zurückholen fehlgeschlagen: ${error.message}`, true); }
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
    app.toast([`${input.files.length === 1 ? 'Bild' : 'Bilder'} hinzugefügt. Mit „Speichern“ kommen sie auf die Website.`, ...notes.filter(Boolean)].join(' '), false, notes.some(Boolean));
    draw();
  });
  const upload = el('label', { className: 've-primary ve-upload' }, 'Bilder hochladen …', input);
  const fileName = (path) => path.split('/').pop();
  const images = app.images().sort((a, b) => fileName(a).localeCompare(fileName(b), 'de'))
    .map((path) => ({ path, name: fileName(path), used: app.usesOf(path), ...app.altsOf(path) }));
  const filters = {
    all: ['Alle Bilder', () => true],
    unused: ['Nirgends verwendet', (image) => !image.used.length],
    noalt: ['Ohne Alternativtext', (image) => image.missing.length > 0],
  };
  const matches = (image) => {
    const text = [image.name, ...image.alts, ...image.used].join(' ').toLocaleLowerCase('de');
    return filters[library.filter][1](image) && library.query.toLocaleLowerCase('de').split(/\s+/).every((word) => text.includes(word));
  };
  const replace = (image) => {
    const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp' });
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      const { path, note } = await app.upload(file.files[0]);
      app.replaceImage(image.path, path);
      const where = image.used.length ? `Überall, wo „${image.name}“ war (${image.used.join(', ')}), steht jetzt „${fileName(path)}“.` : `„${fileName(path)}“ ersetzt „${image.name}“.`;
      app.toast([where, 'Mit „Speichern“ kommt es auf die Website.', note].filter(Boolean).join(' '), false, true);
      draw();
    });
    const label = el('label', { className: 've-tool ve-upload', title: `${image.name} durch ein anderes Bild ersetzen` }, 'Ersetzen …', file);
    return label;
  };
  const item = (image) => {
    const node = el('li', {}, el('img', { src: app.mediaURL(image.path), alt: '', loading: 'lazy' }),
      el('strong', {}, image.name),
      el('small', {}, image.used.length ? `Verwendet auf: ${image.used.join(', ')}` : 'Wird nirgends verwendet.'),
      image.missing.length ? el('small', { className: 've-alt-missing' }, `Ohne Alternativtext auf: ${image.missing.join(', ')}`) : null);
    if (app.isUnsaved(image.path)) node.append(el('span', { className: 've-badge' }, 'Noch nicht gespeichert'));
    const tools = el('div', { className: 've-actions-row' });
    if (app.mayDeleteImages) tools.append(replace(image));
    if (app.mayDeleteImages && !image.used.length) {
      tools.append(app.button('Löschen', `${image.name} löschen`, async () => {
        if (await app.confirmDialog('Bild löschen?', `„${image.name}“ wird beim nächsten Speichern gelöscht.`, 'Löschen')) app.removeImage(image.path);
      }, 've-tool ve-danger'));
    }
    if (tools.childElementCount) node.append(tools);
    return node;
  };
  const list = el('div');
  const showList = () => {
    const shown = images.filter(matches);
    list.replaceChildren(shown.length ? el('ul', { className: 've-library' }, ...shown.map(item))
      : card(null, images.length ? 'Kein Bild passt dazu.' : 'Noch keine Bilder.'));
  };
  const search = el('input', { type: 'search', value: library.query, placeholder: 'Suchen: Dateiname, Alternativtext, Seite' });
  search.setAttribute('aria-label', 'Bilder durchsuchen');
  search.addEventListener('input', () => { library.query = search.value; showList(); });
  const filter = el('select', {}, ...Object.entries(filters).map(([value, [label, test]]) => el('option', { value, selected: value === library.filter }, `${label} (${images.filter(test).length})`)));
  filter.setAttribute('aria-label', 'Welche Bilder');
  filter.addEventListener('change', () => { library.filter = filter.value; showList(); });
  showList();
  root.replaceChildren(el('div', { className: 've-form-page ve-wide-page' },
    head(app, 'Website', 'Bilder', 'Alle Bilder der Website. Laden Sie neue Bilder hier hoch; auf einer Seite wählen Sie sie dann beim jeweiligen Bild aus. „Ersetzen“ tauscht ein Bild überall, wo es verwendet wird, gegen ein neues. Löschen lässt sich nur ein Bild, das nirgends verwendet wird.'),
    el('p', { className: 've-actions-row' }, upload),
    images.length ? el('p', { className: 've-actions-row ve-library-tools' }, search, filter) : null,
    list));
  return { reveal() {} };
}

// Pages, posts, patterns and forms deleted in the history, each restorable as an unsaved change.
export function deletedView(app, root) {
  const page = el('div', { className: 've-form-page' }, head(app, 'Website', 'Gelöschte Inhalte', 'Seiten, Einträge, Muster und Formulare, die gelöscht wurden. „Zurückholen“ legt eines wieder an, so wie es zuletzt gespeichert war; erst mit „Speichern“ ist es wieder da.'));
  root.replaceChildren(page);
  if (!app.can('content')) { page.append(card(null, 'Nur Administratoren und Redakteure holen gelöschte Inhalte zurück.')); return { reveal() {} }; }
  const list = card(null, null, el('p', { className: 've-hint' }, 'Wird gesucht …'));
  page.append(list);
  const load = (limit) => app.findDeleted(limit).then(({ entries, searched, more }) => {
    list.replaceChildren(
      el('p', { className: 've-hint' }, `Durchsucht: die letzten ${searched} gespeicherten Änderungen an Inhalten.`),
      entries.length ? el('ul', { className: 've-people' }, ...entries.map((e) => el('li', {},
        el('div', {}, el('strong', {}, `${e.kindName} „${e.title}“`), el('small', {}, `Gelöscht am ${dateTime(e.deleted.date)} von ${e.deleted.author}${e.language ? ` · ${e.language}` : ''}`)),
        app.button('Zurückholen', `${e.kindName} „${e.title}“ zurückholen`, () => app.restoreDeleted(e), 've-tool'))))
        : el('p', {}, 'Keine gelöschten Inhalte gefunden.'),
      ...(more ? [el('div', { className: 've-actions-row' }, app.button('Weiter zurück suchen', null, () => { list.replaceChildren(el('p', { className: 've-hint' }, 'Wird gesucht …')); load(100); }, 've-tool'))] : []));
  }, (e) => { list.replaceChildren(el('p', { className: 've-error', role: 'alert' }, `Gelöschte Inhalte konnten nicht geladen werden: ${e.message}`)); });
  load(30);
  return { reveal() {} };
}

// Who may edit the site. Each change applies at once.
// What visitors sent through the site's forms (gateway/submissions.js): read, download as CSV,
// delete. Like users, a deletion is stored at once.
export function submissionsView(app, root) {
  const page = el('div', { className: 've-form-page' }, head(app, 'Website', 'Einsendungen', 'Was Besucher über die Formulare der Website gesendet haben, neueste zuerst. Löschen gilt sofort und endgültig, ohne „Speichern“.'));
  root.replaceChildren(page);
  if (!app.can('content')) { page.append(card(null, 'Nur Administratoren und Redakteure sehen Einsendungen.')); return { reveal() {} }; }
  const list = el('div', {}, card(null, null, el('p', { className: 've-hint' }, 'Wird geladen …')));
  page.append(list);
  const text = (value) => [value].flat().join(', ');
  const download = (form) => {
    const names = [...new Set(form.submissions.flatMap((s) => Object.keys(s.fields)))];
    const cell = (value) => `"${String(value).replace(/"/g, '""')}"`;
    const rows = [['Eingegangen', ...names], ...form.submissions.map((s) => [s.received_at, ...names.map((n) => text(s.fields[n] ?? ''))])];
    // The byte order mark makes Excel read the file as UTF-8.
    const blob = new Blob([`﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const link = el('a', { href: URL.createObjectURL(blob), download: `${form.slug}.csv` });
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const draw = (forms) => {
    list.replaceChildren(...(forms.length ? forms.map((form) => card(`${form.title} (${form.submissions.length})`, form.submissions.length ? null : 'Noch keine Einsendungen.',
      form.submissions.length ? el('div', { className: 've-actions-row' }, app.button('Als Tabelle herunterladen (CSV)', `Einsendungen „${form.title}“ als CSV herunterladen`, () => download(form), 've-tool')) : null,
      el('ul', { className: 've-people ve-submissions' }, ...form.submissions.map((s) => el('li', {},
        el('div', {}, el('strong', {}, dateTime(s.received_at)), ...Object.entries(s.fields).map(([name, value]) => el('small', {}, `${name}: ${text(value)}`))),
        app.button('Löschen', `Einsendung vom ${dateTime(s.received_at)} löschen`, async () => {
          if (await app.confirmDialog('Einsendung löschen?', 'Sie wird endgültig gelöscht und lässt sich nicht wiederherstellen.', 'Löschen')) load({ method: 'POST', body: { delete: [s.id] } });
        }, 've-tool ve-danger'))))))
      : [card(null, 'Die Website hat keine Formulare.')]));
  };
  const load = (options) => app.api('/submissions', options).then(({ forms }) => { draw(forms); if (options) app.toast('Einsendung gelöscht.'); },
    (e) => { list.replaceChildren(card(null, null, el('p', { className: 've-error', role: 'alert' }, e.message))); });
  load();
  return { reveal() {} };
}

export function usersView(app, root) {
  const page = el('div', { className: 've-form-page' }, head(app, 'Website', 'Benutzer', 'Wer die Website bearbeiten darf. Änderungen an Benutzern gelten sofort, ohne „Speichern“.'));
  root.replaceChildren(page);
  if (app.me.role !== 'administrator') { page.append(card(null, 'Nur Administratoren verwalten Benutzer.')); return { reveal() {} }; }
  const listCard = card('Alle Benutzer', null, el('p', { className: 've-hint' }, 'Wird geladen …'));
  const formCard = el('section', { className: 've-card' });
  page.append(listCard, formCard);
  let users = [], roles = {};
  const error = el('p', { className: 've-error', role: 'alert' });

  const send = async (body) => {
    error.textContent = '';
    try { ({ users } = await app.api('/users', { method: 'POST', body })); drawList(); return true; } catch (e) { error.textContent = e.message; return false; }
  };
  const drawList = () => {
    listCard.replaceChildren(el('h2', {}, 'Alle Benutzer'), el('ul', { className: 've-people' }, ...users.map((u) => el('li', {},
      el('div', {}, el('strong', {}, u.name || u.email), el('small', {}, `${u.email} · ${roles[u.role]?.label ?? u.role}${u.email === app.me.email ? ' · Sie selbst' : ''}`)),
      el('div', { className: 've-actions-row' },
        app.button('Bearbeiten', `${u.name || u.email} bearbeiten`, () => drawForm(u), 've-tool'),
        app.button('Überall abmelden', `${u.name || u.email} auf allen Geräten abmelden`, async () => {
          const self = u.email === app.me.email;
          if (!(await app.confirmDialog('Überall abmelden?', self ? 'Sie werden auf allen Geräten abgemeldet, auch hier.' : `${u.name || u.email} wird auf allen Geräten abgemeldet und muss sich neu anmelden.`, 'Abmelden'))) return;
          if (self) app.signOut({ everywhere: true });
          else if (await send({ action: 'signout', email: u.email })) app.toast(`${u.name || u.email} ist überall abgemeldet.`);
        }, 've-tool'),
        u.email === app.me.email ? null : app.button('Löschen', `${u.name || u.email} löschen`, async () => {
          if (await app.confirmDialog('Benutzer löschen?', `${u.name || u.email} kann die Website danach nicht mehr bearbeiten.`, 'Löschen')) send({ action: 'delete', email: u.email });
        }, 've-tool ve-danger'))))));
  };
  const drawForm = (user = null) => {
    const form = el('form', { className: 've-form ve-user-form' });
    const field = (label, input, hint) => el('div', { className: 've-control' }, el('label', { className: 've-label', htmlFor: input.id }, label), hint ? el('small', { className: 've-hint' }, hint) : null, input);
    const name = el('input', { id: 've-user-name', type: 'text', value: user?.name ?? '', required: true, autocomplete: 'off' });
    const email = el('input', { id: 've-user-email', type: 'email', value: user?.email ?? '', required: true, readOnly: !!user, autocomplete: 'off' });
    const password = el('input', { id: 've-user-password', type: 'password', minLength: 10, required: !user, autocomplete: 'new-password' });
    const choices = el('div', { className: 've-choices', role: 'radiogroup', 'aria-label': 'Rolle' }, ...Object.entries(roles).map(([id, r]) => el('label', { className: 've-choice' },
      el('input', { type: 'radio', name: 've-role', value: id, checked: (user?.role ?? 'editor') === id }),
      el('span', {}, el('strong', {}, r.label), el('small', {}, ROLE_HELP[id] ?? '')))));
    form.append(field('Name', name), field('E-Mail-Adresse', email, user ? 'Die Adresse lässt sich nicht ändern.' : 'Mit dieser Adresse meldet sich die Person an.'),
      el('div', { className: 've-control' }, el('span', { className: 've-label' }, 'Was darf die Person?'), choices),
      field('Passwort', password, user ? 'Leer lassen, um es nicht zu ändern. Sonst mindestens 10 Zeichen.' : 'Mindestens 10 Zeichen. Teilen Sie es der Person persönlich mit.'),
      error,
      el('div', { className: 've-actions-row' }, el('button', { type: 'submit', className: 've-primary' }, user ? 'Änderungen übernehmen' : 'Benutzer anlegen'),
        user ? app.button('Abbrechen', null, () => drawForm(), 've-tool') : null));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = { email: email.value, name: name.value, role: form.querySelector('input[name=ve-role]:checked')?.value, ...(password.value && { password: password.value }) };
      if (await send(body)) { app.toast(user ? 'Benutzer geändert.' : 'Benutzer angelegt.'); drawForm(); }
    });
    formCard.replaceChildren(el('h2', {}, user ? `${user.name || user.email} bearbeiten` : 'Neuen Benutzer anlegen'), form);
    if (user) { formCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); name.focus({ preventScroll: true }); }
  };
  app.api('/users').then((result) => { ({ users, roles } = result); drawList(); drawForm(); }, (e) => { listCard.replaceChildren(el('p', { className: 've-error' }, e.message)); });
  return { reveal() {} };
}

// "Mein Konto", for every role: one's own name and password, and signing out on all devices.
export function accountView(app, root) {
  const page = el('div', { className: 've-form-page' }, head(app, 'Konto', 'Mein Konto', `Angemeldet als ${app.me.email}.`));
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
  const nameCard = form(card('Name', 'So erscheinen Sie bei Ihren Änderungen.'), [field('Name', name)], 'Namen speichern', async () => {
    const result = await app.api('/me', { method: 'POST', body: { name: name.value } });
    app.me.name = result.name;
    document.querySelector('#ve-user').textContent = result.name;
    app.toast('Name gespeichert.');
  });

  const current = el('input', { id: 've-account-current', type: 'password', required: true, autocomplete: 'current-password' });
  const next = el('input', { id: 've-account-new', type: 'password', required: true, minLength: 10, autocomplete: 'new-password' });
  const repeat = el('input', { id: 've-account-repeat', type: 'password', required: true, minLength: 10, autocomplete: 'new-password' });
  const passwordCard = form(card('Passwort ändern', 'Danach sind Sie auf anderen Geräten abgemeldet, hier nicht.'),
    [field('Bisheriges Passwort', current), field('Neues Passwort', next, 'Mindestens 10 Zeichen.'), field('Neues Passwort wiederholen', repeat)], 'Passwort ändern', async () => {
      if (next.value !== repeat.value) throw new Error('Die beiden neuen Passwörter sind nicht gleich.');
      await app.api('/me', { method: 'POST', body: { password: next.value, current_password: current.value } });
      for (const input of [current, next, repeat]) input.value = '';
      app.toast('Passwort geändert.');
    });

  const devices = card('Auf allen Geräten abmelden', 'Zum Beispiel, wenn Sie sich an einem fremden Computer nicht abgemeldet haben. Danach melden Sie sich überall neu an, auch hier.',
    el('div', { className: 've-actions-row' }, app.button('Überall abmelden', null, async () => {
      if (await app.confirmDialog('Überall abmelden?', 'Sie werden auf allen Geräten abgemeldet, auch hier.', 'Abmelden')) app.signOut({ everywhere: true });
    }, 've-tool')));
  page.append(nameCard, passwordCard, devices);
  return { reveal() {} };
}
