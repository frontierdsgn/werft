// The visual editor: which texts of a page it can mark for editing in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from '../lib/index.js';
import { pageRenderer, unmark } from '../admin/visual-map.js';

const theme = {
  blocks: {
    intro: {
      label: 'Intro',
      // The heading also names the anchor; the link's style picks a class.
      render: (s, ctx) => html`<section id="${s.heading.toLowerCase().replace(/[^a-z]+/g, '-')}"><h2>${s.heading}</h2>${ctx.md(s.body)}
        <a class="${s.link.style === 'button' ? 'button' : 'text'}" href="${s.link.url}">${s.link.label}</a></section>`,
    },
  },
  renderPage: (page, ctx) => html`<!doctype html><html><head><title>${page.title}</title></head><body><main>${ctx.blocks(page.sections)}</main>
    <footer>${ctx.settings.footer}</footer></body></html>`,
};
const content = () => ({
  pages: [{ slug: 'index', title: 'Start', sections: [
    { type: 'intro', heading: 'Willkommen', body: 'Ein **Raum** am Wasser.', link: { label: 'Anfragen', url: 'kontakt.html', style: 'button' } },
    { type: 'intro', heading: 'Garten', body: 'Grün.', link: { label: 'Mehr', url: 'garten.html', style: 'text' } },
  ] }],
  posts: [], patterns: [], forms: [], settings: { footer: 'Am Fluss' }, menus: {}, redirects: [],
});

test('every text the theme only shows is marked, and the marked page is the page', () => {
  const result = pageRenderer({ site: {}, theme })(content(), 'index');
  const marked = result.texts.map((t) => `${t.source} ${t.path.join('.')}`);
  for (const path of ['page:index title', 'page:index sections.0.body', 'page:index sections.0.link.label', 'page:index sections.0.link.url', 'settings footer']) {
    assert.ok(marked.includes(path), path);
  }
  // Without its markers the page is exactly what the site publishes, with each section between comments.
  const unmarked = unmark(result.html);
  assert.match(unmarked, /<!--werft-section:0--><section id="willkommen">/);
  assert.match(unmarked, /<!--\/werft-section--><!--werft-section:1--><section id="garten">/);
  assert.match(unmarked, /<a class="button" href="kontakt.html">Anfragen<\/a>/);
});

test('texts the theme compares or turns into names stay unmarked', () => {
  const result = pageRenderer({ site: {}, theme })(content(), 'index');
  const marked = new Set(result.texts.map((t) => t.path.join('.')));
  // A marked heading would change the anchor, a marked style would lose the button class.
  assert.ok(!marked.has('sections.0.heading'));
  assert.ok(!marked.has('sections.0.link.style'));
  assert.ok(result.all.some((t) => t.path.join('.') === 'sections.0.heading'));
});

test('the signed-in role leaves out what it cannot change', () => {
  const result = pageRenderer({ site: {}, theme, editable: (source) => source !== 'settings' })(content(), 'index');
  assert.ok(!result.texts.some((t) => t.source === 'settings'));
  assert.ok(result.texts.some((t) => t.source === 'page:index'));
});

test('a page without sections opens', () => {
  const data = content();
  delete data.pages[0].sections;
  const result = pageRenderer({ site: {}, theme })(data, 'index');
  assert.match(unmark(result.html), /<main><\/main>/);
});
