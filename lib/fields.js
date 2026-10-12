// Builders for Sveltia CMS field definitions, so themes describe their blocks and settings briefly.
// Every builder returns a plain Sveltia field object; extra options pass straight through.
// https://sveltiacms.app/en/docs/fields

const field = (widget) => (name, label, options = {}) => ({ name, label, widget, ...options });

export const string = field('string');
export const text = field('text');
export const number = field('number');
export const boolean = (name, label, options = {}) => ({ name, label, widget: 'boolean', required: false, ...options });
export const datetime = field('datetime');
// A calendar date without time. The browser shows it in the editor's locale (14.11.2026 in a German
// browser); the file stores "2026-11-14", which sorts and parses everywhere.
export const date = (name, label, options = {}) => ({ name, label, widget: 'datetime', type: 'date', format: 'YYYY-MM-DD', ...options });
export const hidden = field('hidden');
export const markdown = (name, label, options = {}) =>
  ({ name, label, widget: 'richtext', buttons: ['bold', 'italic', 'link', 'heading-two', 'heading-three', 'heading-four', 'bulleted-list', 'numbered-list'], editor_components: [], modes: ['rich_text', 'raw'], ...options });
export const image = field('image');
export const select = (name, label, options, more = {}) => ({ name, label, widget: 'select', options, ...more });
export const object = (name, label, fields, options = {}) => ({ name, label, widget: 'object', fields, ...options });
export const list = (name, label, fields, options = {}) =>
  Array.isArray(fields) ? { name, label, widget: 'list', fields, ...options } : { name, label, widget: 'list', field: fields, ...options };
export const relation = (name, label, collection, options = {}) =>
  ({ name, label, widget: 'relation', collection, value_field: '{{slug}}', search_fields: ['title'], display_fields: ['title'], ...options });

export const optional = (definition) => ({ ...definition, required: false });

// Common shapes shared by many themes.
export const link = (name = 'link', label = 'Link', options = {}) => object(name, label, [
  string('label', 'Text'),
  string('url', 'Adresse', { hint: 'Seite (z. B. kontakt.html), Anker (#anfrage) oder volle Adresse' }),
  select('style', 'Darstellung', [{ label: 'Textlink', value: 'text' }, { label: 'Schaltfläche', value: 'button' }], { default: 'text', required: false }),
  select('arrow', 'Pfeil', [{ label: 'keiner', value: '' }, { label: '↗', value: '↗' }, { label: '→', value: '→' }], { default: '', required: false }),
], { summary: '{{fields.label}}', ...options });

export const picture = (name = 'image', label = 'Bild', { caption = true, ...options } = {}) => object(name, label, [
  image('src', 'Datei'),
  string('alt', 'Alternativtext', { hint: 'Beschreibt das Bild für Menschen, die es nicht sehen.' }),
  ...(caption ? [optional(string('caption', 'Bildunterschrift'))] : []),
], { summary: '{{fields.alt}}', ...options });

export const seo = () => object('seo', 'SEO', [
  optional(string('title', 'Titel im Browser und in Suchmaschinen', { hint: 'Leer: Seitentitel' })),
  optional(text('description', 'Beschreibung für Suchmaschinen')),
  boolean('noindex', 'Nicht von Suchmaschinen indexieren'),
], { collapsed: true, required: false });

export const status = () => [
  select('status', 'Status', [
    { label: 'Entwurf', value: 'draft' },
    { label: 'Zur Prüfung', value: 'pending' },
    { label: 'Veröffentlicht', value: 'published' },
  ], { default: 'draft' }),
  // Entered in the editor's time zone, stored in UTC: build hosts and Workers run in UTC and would
  // read a time without offset as UTC.
  optional(datetime('publish_date', 'Veröffentlichen am', { output_utc: true, hint: 'Leer: sofort. Ein Datum in der Zukunft plant die Veröffentlichung.' })),
];
