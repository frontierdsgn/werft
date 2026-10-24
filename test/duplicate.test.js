// "Seite duplizieren" in the editor (admin/duplicate.js): what the copy of a page holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicatePage } from '../admin/duplicate.js';

test('the copy keeps the sections and settings, as a draft under its new title', () => {
  const page = {
    title: 'Sommerfest',
    status: 'published',
    publish_date: '2026-06-01T10:00:00.000Z',
    seo: { title: 'Sommerfest im Salon', description: 'Feiern am Fluss', noindex: false },
    sections: [{ type: 'hero', heading: 'Sommer', image: { src: 'assets/img/a.jpg', alt: 'Fluss' } }, { type: 'pattern', pattern: 'anfahrt' }],
  };
  const copy = duplicatePage(page, 'Winterfest');
  assert.deepEqual(copy, {
    title: 'Winterfest',
    status: 'draft',
    seo: { description: 'Feiern am Fluss', noindex: false },
    sections: [{ type: 'hero', heading: 'Sommer', image: { src: 'assets/img/a.jpg', alt: 'Fluss' } }, { type: 'pattern', pattern: 'anfahrt' }],
  });
  // Changing the copy leaves the original as it was.
  copy.sections[0].image.alt = 'Schnee';
  assert.equal(page.sections[0].image.alt, 'Fluss');
  assert.equal(page.seo.title, 'Sommerfest im Salon');
  assert.equal(page.status, 'published');
  // An SEO part with only a title goes with it.
  assert.ok(!('seo' in duplicatePage({ title: 'A', seo: { title: 'A!' } }, 'B')));
});
