// The admin configuration generated from the site and theme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmsConfig } from '../lib/cms-config.js';

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
