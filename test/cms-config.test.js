// The admin: the configuration generated from the site and theme, and the logic of its pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmsConfig } from '../lib/cms-config.js';
import * as fields from '../lib/fields.js';
import { versionDiff } from '../admin/diff.js';

test('preview links of a site below a base path include the base', () => {
  // Sveltia keeps only the origin of site_url, so "kontakt.html" would open /kontakt.html.
  const config = cmsConfig({ site: { name: 'S', base: 'classic' }, theme: { blocks: {} }, origin: 'https://example.org' });
  assert.equal(config.collections.find((c) => c.name === 'pages').preview_path, '/classic/{{slug}}.html');
});

test('publish dates are stored in UTC', () => {
  // Build hosts run in UTC: "2026-08-01T10:00:00" entered in Berlin would publish two hours late.
  const config = cmsConfig({ site: { name: 'S' }, theme: { blocks: {} }, origin: 'https://example.org' });
  const field = config.collections.find((c) => c.name === 'pages').fields.find((f) => f.name === 'publish_date');
  assert.equal(field.output_utc, true);
});

test('a theme without menus gets no menu settings', () => {
  // Sveltia rejects the whole configuration when a file has no fields.
  const files = (theme) => cmsConfig({ site: { name: 'S' }, theme, origin: 'https://example.org' }).collections.find((c) => c.name === 'settings').files.map((f) => f.name);
  assert.deepEqual(files({ blocks: {} }), ['site', 'redirects']);
  assert.deepEqual(files({ blocks: {}, menus: { main: 'Hauptmenü' } }), ['site', 'menus', 'redirects']);
});

test('the admin lists posts newest first and stores dates as ISO dates', () => {
  // A German "14.11.2026" in the file cannot be sorted; the browser still shows the date in the editor's locale.
  const theme = { blocks: {}, postType: { name: 'events', label: 'V', singular: 'V', date: 'date', fields: [fields.string('title', 'Titel'), fields.date('date', 'Datum')] } };
  const events = cmsConfig({ site: { name: 'S' }, theme, origin: 'https://example.org' }).collections.find((c) => c.name === 'events');
  assert.deepEqual(events.sortable_fields.default, { field: 'date', direction: 'descending' });
  assert.equal(events.fields.find((f) => f.name === 'date').format, 'YYYY-MM-DD');
});

test('the status field offers only the statuses the user may save', () => {
  // A contributor who picks "Veröffentlicht" is refused by the gateway after filling in the form.
  const theme = { blocks: {}, postType: { name: 'events', label: 'E', singular: 'E', fields: [] } };
  const options = (statuses) => cmsConfig({ site: { name: 'S' }, theme, origin: 'https://example.org', editable: ['post'], statuses })
    .collections.find((c) => c.name === 'events').fields.find((f) => f.name === 'status').options.map((o) => o.value);
  assert.deepEqual(options(['draft', 'pending']), ['draft', 'pending']);
  assert.deepEqual(options(undefined), ['draft', 'pending', 'published']);
});

test('versions are compared by content, not by key order or unset booleans', () => {
  // The CMS writes keys in its field order and adds "noindex": false; neither is a change.
  const before = '{\n  "title": "Kontakt",\n  "seo": { "description": "Adresse" },\n  "status": "published"\n}\n';
  const after = '{\n  "title": "Kontakt neu",\n  "status": "published",\n  "seo": {\n    "description": "Adresse",\n    "noindex": false\n  }\n}\n';
  const changes = versionDiff(before, after).filter(([kind]) => kind !== ' ');
  assert.deepEqual(changes, [['-', '  "title": "Kontakt",'], ['+', '  "title": "Kontakt neu",']]);
  assert.equal(versionDiff(after, after.replace('"noindex": false', '"noindex": true')).filter(([kind]) => kind !== ' ').length, 2, 'a boolean set to true is a change');
});
