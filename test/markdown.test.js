// Text editors write: Markdown with some HTML, and URLs in theme templates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdown, inline } from '../lib/markdown.js';
import { html, attr } from '../lib/html.js';

test('Markdown keeps simple HTML and drops anything that could run', () => {
  assert.equal(markdown('<p class="price-rate"><span class="nobr">32 €</span></p>\n\nAb **10**'), '<p class="price-rate"><span class="nobr">32 €</span></p><p>Ab <strong>10</strong></p>');
  assert.equal(markdown('<img src="x.jpg" alt="A" onerror="alert(1)">'), '<img src="x.jpg" alt="A">');
  assert.equal(markdown('<script>alert(1)</script>'), '&lt;script>alert(1)&lt;/script>');
  assert.equal(inline('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)>');
  assert.equal(inline('[a](javascript:alert(1)) <a href="jav&#x61;script:alert(1)">b</a>'), '<a>a</a> <a>b</a>');
  assert.equal(inline('[a](https://example.org/?a=1&b=2) [m](mailto:a@b.de)'), '<a href="https://example.org/?a=1&amp;b=2">a</a> <a href="mailto:a@b.de">m</a>');
});

test('theme templates turn unsafe link targets into #', () => {
  const link = (url) => html`<a href="${url}">x</a>`.value;
  assert.equal(link('kontakt.html#anfrage'), '<a href="kontakt.html#anfrage">x</a>');
  assert.equal(link('https://example.org/'), '<a href="https://example.org/">x</a>');
  assert.equal(link(' JavaScript:alert(1)'), '<a href="#">x</a>');
  assert.equal(attr('src', 'data:text/html,<script>').value, ' src="#"');
  assert.equal(html`<p title="${'javascript:x'}"></p>`.value, '<p title="javascript:x"></p>', 'only URL attributes');
});
