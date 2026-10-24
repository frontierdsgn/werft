// Builders for the admin's field definitions, so themes describe their blocks and settings briefly.
// Every builder returns a plain object { name, label, widget, … }; extra options pass straight
// through (`hint`, `default`, `required: false`, `summary: '{{fields.label}}'` for list entries).

const field = (widget) => (name, label, options = {}) => ({ name, label, widget, ...options });

export const string = field('string');
export const text = field('text');
export const number = field('number');
export const boolean = (name, label, options = {}) => ({ name, label, widget: 'boolean', required: false, ...options });
export const datetime = field('datetime');
// A calendar date without time. The browser shows it in the editor's locale (14.11.2026 in a German
// browser); the file stores "2026-11-14", which sorts and parses everywhere.
export const date = (name, label, options = {}) => ({ name, label, widget: 'datetime', type: 'date', ...options });
export const hidden = field('hidden');
export const markdown = field('richtext');
export const image = field('image');
export const select = (name, label, options, more = {}) => ({ name, label, widget: 'select', options, ...more });
export const object = (name, label, fields, options = {}) => ({ name, label, widget: 'object', fields, ...options });
export const list = (name, label, fields, options = {}) =>
  Array.isArray(fields) ? { name, label, widget: 'list', fields, ...options } : { name, label, widget: 'list', field: fields, ...options };
export const relation = (name, label, collection, options = {}) => ({ name, label, widget: 'relation', collection, ...options });

export const optional = (definition) => ({ ...definition, required: false });

// Common shapes shared by many themes.
export const link = (name = 'link', label = 'Link', options = {}) => object(name, label, [
  string('label', 'Text'),
  string('url', 'Adresse', { hint: 'Seite (z. B. kontakt.html), Anker (#anfrage) oder volle Adresse' }),
  select('style', 'Darstellung', [{ label: 'Textlink', value: 'text' }, { label: 'Schaltfläche', value: 'button' }], { default: 'text', required: false }),
  select('arrow', 'Pfeil', [{ label: 'keiner', value: '' }, { label: '↗', value: '↗' }, { label: '→', value: '→' }], { default: '', required: false }),
], { summary: '{{fields.label}}', ...options });

// `focus` (on unless false) lets the editor mark the part of the image that must stay visible when
// the theme crops it; it is stored as "30% 70%" and ctx.img() turns it into object-position.
export const picture = (name = 'image', label = 'Bild', { caption = true, focus = true, ...options } = {}) => object(name, label, [
  image('src', 'Datei'),
  string('alt', 'Alternativtext', { hint: 'Beschreibt das Bild für Menschen, die es nicht sehen.' }),
  ...(caption ? [optional(string('caption', 'Bildunterschrift'))] : []),
  ...(focus ? [{ name: 'focus', label: 'Wichtiger Bildteil', widget: 'focus', image: 'src', required: false, hint: 'Klicken Sie auf das, was immer zu sehen sein soll, wenn die Website das Bild zuschneidet.' }] : []),
], { summary: '{{fields.alt}}', ...options });

export const seo = () => object('seo', 'Suchmaschinen (SEO)', [
  optional(string('title', 'Titel im Browser und in Suchmaschinen', { hint: 'Leer: Seitentitel' })),
  optional(text('description', 'Beschreibung für Suchmaschinen')),
  optional(image('image', 'Bild beim Teilen', { hint: 'Erscheint, wenn jemand die Seite in einem Messenger oder sozialen Netzwerk teilt. Leer: das Bild aus den Einstellungen der Website' })),
  boolean('noindex', 'Nicht von Suchmaschinen indexieren'),
], { collapsed: true, required: false });

// The days of the week as stored (Mo … So) with the schema.org day each stands for.
export const WEEKDAYS = { Mo: 'Monday', Di: 'Tuesday', Mi: 'Wednesday', Do: 'Thursday', Fr: 'Friday', Sa: 'Saturday', So: 'Sunday' };
const DAY_NAMES = { Mo: 'Montag', Di: 'Dienstag', Mi: 'Mittwoch', Do: 'Donnerstag', Fr: 'Freitag', Sa: 'Samstag', So: 'Sonntag' };
const days = Object.keys(WEEKDAYS).map((day) => ({ label: DAY_NAMES[day], value: day }));

// Site settings for search engines: who runs the site, where and when it is open. A theme adds
// `fields.organization()` to its `settingsFields`; ctx.head() writes them as structured data
// (JSON-LD) on each language's home page. `types` replaces the kinds editors choose from with
// schema.org types (e.g. [{ label: 'Friseursalon', value: 'HairSalon' }]).
// Stored as `organization`: { type, name, street, postal_code, city, country, phone, email,
// hours: [{ from: 'Mo', to: 'Fr', opens: '09:00', closes: '18:00' }] }.
const KINDS = [{ label: 'Geschäft, Praxis oder Lokal mit Adresse', value: 'LocalBusiness' }, { label: 'Firma, Verein oder Organisation', value: 'Organization' }];
const TIME_HINT = 'Uhrzeit wie 09:00 oder 9.30; sonst erscheint die Zeile nicht';
export const organization = ({ label = 'Firma, Adresse und Öffnungszeiten für Suchmaschinen', types } = {}) => {
  const kinds = types?.length ? types.map((t) => (typeof t === 'string' ? { label: t, value: t } : t)) : KINDS;
  return object('organization', label, [
    select('type', 'Art', kinds, { default: kinds[0].value }),
    optional(string('name', 'Name', { hint: 'Leer: Name der Website' })),
    optional(string('street', 'Straße und Hausnummer')),
    optional(string('postal_code', 'Postleitzahl')),
    optional(string('city', 'Ort')),
    optional(string('country', 'Land', { default: 'DE', hint: 'Kürzel, z. B. DE, AT oder CH' })),
    optional(string('phone', 'Telefon')),
    optional(string('email', 'E-Mail')),
    list('hours', 'Öffnungszeiten', [
      select('from', 'Von Tag', days, { default: 'Mo' }),
      optional(select('to', 'Bis Tag', days, { hint: 'Leer: nur dieser Tag' })),
      string('opens', 'Öffnet um', { hint: TIME_HINT }),
      string('closes', 'Schließt um', { hint: TIME_HINT }),
    ], { required: false, summary: '{{fields.from}} {{fields.to}} {{fields.opens}}–{{fields.closes}}' }),
  ], { collapsed: true, required: false, structuredData: true });
};

export const status = () => [
  select('status', 'Status', [
    { label: 'Entwurf', value: 'draft' },
    { label: 'Zur Prüfung', value: 'pending' },
    { label: 'Veröffentlicht', value: 'published' },
  ], { default: 'draft' }),
  // Entered in the editor's time zone, stored in UTC: build hosts and Workers run in UTC and would
  // read a time without offset as UTC.
  optional(datetime('publish_date', 'Veröffentlichen am', { hint: 'Leer: sofort. Ein Datum in der Zukunft plant die Veröffentlichung.' })),
];
