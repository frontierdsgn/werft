// What the admin edits, derived from the site and its theme, so a site never describes its admin by
// hand: one entry per kind of content with its fields. `editable` (from the gateway's /me) leaves
// out what the signed-in role cannot change; the gateway enforces the same rules on every save.
import { string, text, boolean, select, image, object, list, relation, optional, seo, status as statusFields } from './fields.js';
import { siteLanguages, languageDir } from './content.js';

const SETTINGS_FIELDS = [
  string('title', 'Name der Website'),
  optional(string('title_suffix', 'Anhang an jeden Seitentitel', { hint: 'z. B. „| Firmenname“, mit Leerzeichen angehängt' })),
  optional(string('lang', 'Sprache (Code)', { default: 'de' })),
  optional(string('url', 'Adresse der Website', { hint: 'https://… (die Startseite), für Sitemap, robots.txt und die Vorschau beim Teilen' })),
  optional(image('share_image', 'Bild beim Teilen', { hint: 'Für jede Seite ohne eigenes Bild beim Teilen (unter „Suchmaschinen“ der Seite)' })),
  select('search_visibility', 'Suchmaschinen', [{ label: 'Indexieren erlaubt', value: 'index' }, { label: 'Nicht indexieren', value: 'noindex' }], { default: 'index' }),
];

// werft's own fields of every form (gateway/submissions.js): the text after sending and e-mail for
// a new submission. Who gets e-mail is set in the default language; a translation has its texts.
function formFields(theme, translated) {
  const standard = translated ? 'werfts Text dieser Sprache (Deutsch oder Englisch), sonst der Text der ersten Sprache' : '„Vielen Dank, Ihre Nachricht ist angekommen.“';
  const texts = [
    optional(string('confirm_subject', 'Betreff der Bestätigung', { hint: translated ? 'Leer: werfts Betreff dieser Sprache (Deutsch oder Englisch), sonst der Betreff der ersten Sprache' : 'Leer: „Ihre Nachricht an …“ mit dem Namen der Website' })),
    optional(text('confirm_text', 'Text der Bestätigung', { hint: `Leer: ${standard}${translated ? '. Gesendet wird sie nur, wenn das Formular in der ersten Sprache der Website die Bestätigung einschaltet.' : ''}` })),
  ];
  const own = [
    optional(text('thanks', 'Text nach dem Absenden', { hint: `Leer: ${standard}` })),
    translated
      ? object('notify', 'Bestätigung per E-Mail in dieser Sprache', texts, { collapsed: true, required: false })
      : object('notify', 'E-Mail bei neuer Einsendung', [
        optional(string('to', 'Benachrichtigung an', { hint: 'E-Mail-Adressen, durch Komma getrennt; leer: keine E-Mail. Eine Antwort darauf geht an die Adresse, die im Formular steht.' })),
        boolean('confirm', 'Bestätigung an die Person senden, die das Formular abschickt', { hint: 'Höchstens eine am Tag an dieselbe Adresse. Sie enthält nur den Text unten, nichts aus dem Formular.' }),
        ...texts,
      ], { collapsed: true, required: false }),
  ];
  return [...theme.formFields, ...own.filter((f) => !theme.formFields.some((t) => t.name === f.name))];
}

const menuItem = [string('label', 'Text'), string('url', 'Adresse', { hint: 'Seite (z. B. kontakt.html), Anker (#anfrage) oder volle Adresse' })];

function sectionTypes(theme, { patterns = true } = {}) {
  const types = Object.entries(theme.blocks).map(([name, block]) => ({
    name, label: block.label, widget: 'object', fields: block.fields, ...(block.summary && { summary: block.summary }),
  }));
  if (patterns) types.push({ name: 'pattern', label: 'Muster (auf mehreren Seiten)', widget: 'object', fields: [relation('pattern', 'Muster', 'patterns')] });
  return types;
}

const sections = (theme, options) => ({ name: 'sections', label: 'Abschnitte', widget: 'list', types: sectionTypes(theme, options), typeKey: 'type', required: false });

// editable: kinds the user may change. statuses: the statuses the user may save (contributors
// cannot publish). lang: for a site in several languages, the language whose files are edited
// (default: the first); redirects are shared by all languages.
export function schema({ site, theme, editable = ['settings', 'structure', 'content', 'post', 'media'], statuses, lang }) {
  const sharedDir = site.contentDir ?? site.content ?? 'content';
  const languages = siteLanguages(site);
  const contentDir = languageDir(sharedDir, languages, lang);
  const can = (kind) => editable.includes(kind);
  const status = () => statusFields().map((f) => (f.name === 'status' && statuses ? { ...f, options: f.options.filter((o) => statuses.includes(o.value)) } : f));
  const postType = theme.postType;
  const folder = (name, label, singular, fields, more = {}) => ({ name, label, singular, folder: `${contentDir}/${name}`, fields, ...more });

  const collections = [];
  if (can('content')) collections.push(folder('pages', 'Seiten', 'Seite', [string('title', 'Titel'), ...status(), seo(), sections(theme)]));
  if (postType && can('post')) collections.push(folder(postType.name, postType.label, postType.singular, [...postType.fields, ...status()]));
  if (can('content')) {
    collections.push(folder('patterns', 'Muster', 'Muster', [string('title', 'Name'), sections(theme, { patterns: false })], {
      description: 'Abschnitte, die auf mehreren Seiten gleich erscheinen. Eine Änderung wirkt überall.',
    }));
    if (theme.formFields) collections.push(folder('forms', 'Formulare', 'Formular', formFields(theme, contentDir !== sharedDir)));
  }
  const files = [];
  // In a site with languages, each version's language is the one werft.config.js names.
  const settingsFields = languages.length ? SETTINGS_FIELDS.filter((f) => f.name !== 'lang') : SETTINGS_FIELDS;
  if (can('settings')) files.push({ name: 'site', label: 'Website', file: `${contentDir}/settings/site.json`, fields: [...settingsFields, ...(theme.settingsFields ?? [])] });
  if (can('structure')) {
    // A theme without menus gets no Menüs entry.
    if (Object.keys(theme.menus ?? {}).length) {
      files.push({
        name: 'menus', label: 'Menüs', file: `${contentDir}/settings/menus.json`,
        fields: Object.entries(theme.menus).map(([id, label]) => object(id, label, [
          string('label', 'Bezeichnung (für Screenreader)'),
          list('items', 'Einträge', menuItem, { summary: '{{fields.label}}', required: false }),
        ])),
      });
    }
    files.push({
      name: 'redirects', label: 'Weiterleitungen', file: `${sharedDir}/settings/redirects.json`,
      fields: [list('redirects', 'Weiterleitungen', [
        string('from', 'Von', { hint: 'Pfad, z. B. /alt.html; /alt/* nimmt alles darunter mit' }),
        string('to', 'Nach', { hint: 'Pfad oder volle Adresse; :splat steht für den Teil, den * erfasst hat' }),
        select('status', 'Art', [{ label: 'Dauerhaft (301)', value: 301 }, { label: 'Vorübergehend (302)', value: 302 }], { default: 301 }),
      ], { required: false, summary: '{{fields.from}} → {{fields.to}}' })],
    });
  }
  if (files.length) collections.push({ name: 'settings', label: 'Einstellungen', files });
  return { collections };
}
