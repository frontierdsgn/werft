// Sveltia CMS configuration derived from the site and its theme, so a site never writes CMS config
// by hand. `editable` (from the gateway's /me) hides what the signed-in role cannot change; the
// gateway enforces the same rules on every save.
import { string, select, object, list, relation, optional, seo, status } from './fields.js';

const SETTINGS_FIELDS = [
  string('title', 'Name der Website'),
  optional(string('title_suffix', 'Anhang an jeden Seitentitel', { hint: 'z. B. „ | Firmenname“' })),
  optional(string('lang', 'Sprache (Code)', { default: 'de' })),
  optional(string('url', 'Adresse der Website', { hint: 'https://…, für Sitemap und robots.txt' })),
  select('search_visibility', 'Suchmaschinen', [{ label: 'Indexieren erlaubt', value: 'index' }, { label: 'Nicht indexieren', value: 'noindex' }], { default: 'index' }),
];

const menuItem = [string('label', 'Text'), string('url', 'Adresse', { hint: 'Seite (z. B. kontakt.html), Anker (#anfrage) oder volle Adresse' })];

function sectionTypes(theme, { patterns = true } = {}) {
  const types = Object.entries(theme.blocks).map(([name, block]) => ({
    name, label: block.label, widget: 'object', fields: block.fields, ...(block.summary && { summary: block.summary }),
  }));
  if (patterns) types.push({ name: 'pattern', label: 'Muster (auf mehreren Seiten)', widget: 'object', fields: [relation('pattern', 'Muster', 'patterns')], summary: '{{fields.pattern}}' });
  return types;
}

const sections = (theme, options) => ({ name: 'sections', label: 'Abschnitte', widget: 'list', types: sectionTypes(theme, options), typeKey: 'type', required: false });

// origin: where the admin runs, e.g. https://example.org. editable: kinds the user may change.
export function cmsConfig({ site, theme, origin, branch = 'main', editable = ['settings', 'structure', 'content', 'post', 'media'] }) {
  const contentDir = site.contentDir ?? site.content ?? 'content';
  const mediaFolder = site.mediaDirs?.[0] ?? 'assets/img';
  const base = site.base ? `/${site.base.replace(/^\/+|\/+$/g, '')}/` : '/';
  const can = (kind) => editable.includes(kind);
  const postType = theme.postType;
  const folder = (name, label, singular, fields, more = {}) => ({
    name, label, label_singular: singular, folder: `${contentDir}/${name}`, format: 'json', extension: 'json',
    create: true, delete: true, identifier_field: 'title', slug: '{{slug}}', summary: '{{title}}', fields, ...more,
  });

  const collections = [];
  if (can('content')) {
    collections.push(folder('pages', 'Seiten', 'Seite', [string('title', 'Titel'), ...status(), seo(), sections(theme)], {
      preview_path: '{{slug}}.html', sortable_fields: ['title'],
    }));
  }
  if (postType && can('post')) {
    collections.push(folder(postType.name, postType.label, postType.singular, [...postType.fields, ...status()], {
      sortable_fields: ['title', ...postType.fields.filter((f) => f.widget === 'datetime').map((f) => f.name)],
    }));
  }
  if (can('content')) {
    collections.push(folder('patterns', 'Muster', 'Muster', [string('title', 'Name'), sections(theme, { patterns: false })], {
      description: 'Abschnitte, die auf mehreren Seiten gleich erscheinen. Eine Änderung wirkt überall.',
    }));
    if (theme.formFields) collections.push(folder('forms', 'Formulare', 'Formular', theme.formFields));
  }
  const files = [];
  if (can('settings')) files.push({ name: 'site', label: 'Website', file: `${contentDir}/settings/site.json`, fields: [...SETTINGS_FIELDS, ...(theme.settingsFields ?? [])] });
  if (can('structure')) {
    files.push({
      name: 'menus', label: 'Menüs', file: `${contentDir}/settings/menus.json`,
      fields: Object.entries(theme.menus ?? {}).map(([id, label]) => object(id, label, [
        string('label', 'Bezeichnung (für Screenreader)'),
        list('items', 'Einträge', menuItem, { summary: '{{fields.label}}', required: false }),
      ])),
    });
    files.push({
      name: 'redirects', label: 'Weiterleitungen', file: `${contentDir}/settings/redirects.json`,
      fields: [list('redirects', 'Weiterleitungen', [
        string('from', 'Von', { hint: 'Pfad, z. B. /alt.html' }),
        string('to', 'Nach', { hint: 'Pfad oder volle Adresse' }),
        select('status', 'Art', [{ label: 'Dauerhaft (301)', value: 301 }, { label: 'Vorübergehend (302)', value: 302 }], { default: 301 }),
      ], { required: false, summary: '{{fields.from}} → {{fields.to}}' })],
    });
  }
  if (files.length) collections.push({ name: 'settings', label: 'Einstellungen', files, editor: { preview: false } });

  return {
    load_config_file: false,
    backend: {
      name: 'gitea', repo: 'werft/site', branch,
      base_url: `${origin}/api/werft`, api_root: `${origin}/api/werft/api/v1`, app_id: 'werft',
      commit_messages: {
        create: 'Neu: {{collection}} „{{slug}}“', update: 'Geändert: {{collection}} „{{slug}}“', delete: 'Gelöscht: {{collection}} „{{slug}}“',
        uploadMedia: 'Hochgeladen: {{path}}', deleteMedia: 'Gelöscht: {{path}}',
      },
    },
    site_url: `${origin}${base}`,
    display_url: `${origin}${base}`,
    media_folder: mediaFolder,
    public_folder: mediaFolder,
    output: { omit_empty_optional_fields: true },
    slug: { encoding: 'ascii', clean_accents: true },
    collections,
  };
}

