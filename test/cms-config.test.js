// The admin configuration generated from the site and theme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmsConfig } from '../lib/cms-config.js';

test('preview links of a site below a base path include the base', () => {
  // Sveltia keeps only the origin of site_url, so "kontakt.html" would open /kontakt.html.
  const config = cmsConfig({ site: { name: 'S', base: 'classic' }, theme: { blocks: {} }, origin: 'https://example.org' });
  assert.equal(config.collections.find((c) => c.name === 'pages').preview_path, '/classic/{{slug}}.html');
});
