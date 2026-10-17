// The admin: the schema derived from the site and theme, and the comparison of versions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schema } from '../lib/schema.js';
import { versionDiff } from '../admin/diff.js';

test('a theme without menus gets no menu settings', () => {
  // The editor would offer an empty "Menüs" form.
  const files = (theme) => schema({ site: { name: 'S' }, theme }).collections.find((c) => c.name === 'settings').files.map((f) => f.name);
  assert.deepEqual(files({ blocks: {} }), ['site', 'redirects']);
  assert.deepEqual(files({ blocks: {}, menus: { main: 'Hauptmenü' } }), ['site', 'menus', 'redirects']);
});

test('the status field offers only the statuses the user may save', () => {
  // A contributor who picks "Veröffentlicht" is refused by the gateway after filling in the form.
  const theme = { blocks: {}, postType: { name: 'events', label: 'E', singular: 'E', fields: [] } };
  const options = (statuses) => schema({ site: { name: 'S' }, theme, editable: ['post'], statuses })
    .collections.find((c) => c.name === 'events').fields.find((f) => f.name === 'status').options.map((o) => o.value);
  assert.deepEqual(options(['draft', 'pending']), ['draft', 'pending']);
  assert.deepEqual(options(undefined), ['draft', 'pending', 'published']);
});

test('versions are compared by content, not by key order or unset booleans', () => {
  // Older saves wrote keys in another order and added "noindex": false; neither is a change.
  const before = '{\n  "title": "Kontakt",\n  "seo": { "description": "Adresse" },\n  "status": "published"\n}\n';
  const after = '{\n  "title": "Kontakt neu",\n  "status": "published",\n  "seo": {\n    "description": "Adresse",\n    "noindex": false\n  }\n}\n';
  const changes = versionDiff(before, after).filter(([kind]) => kind !== ' ');
  assert.deepEqual(changes, [['-', '  "title": "Kontakt",'], ['+', '  "title": "Kontakt neu",']]);
  assert.equal(versionDiff(after, after.replace('"noindex": false', '"noindex": true')).filter(([kind]) => kind !== ' ').length, 2, 'a boolean set to true is a change');
});
