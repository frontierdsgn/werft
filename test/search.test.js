// The admin's search in the sidebar (admin/search.js): what an entry's texts are and what matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textsOf, search, normalize } from '../admin/search.js';

test('an entry\'s texts are what people read, without Markdown, addresses or kinds', () => {
  const page = {
    title: 'Start',
    status: 'published',
    seo: { description: 'Der Salon am Fluss' },
    sections: [
      { type: 'hero', heading: 'Willkommen', image: { src: 'assets/img/a.jpg', alt: 'Die Fähre' }, link: { label: 'Anfragen', url: 'kontakt.html' } },
      { type: 'text', body: '**Geöffnet** ab [Mai](termine.html). <em>Täglich</em>' },
      { type: 'pattern', pattern: 'anfahrt' },
    ],
  };
  assert.deepEqual(textsOf(page), ['Start', 'Der Salon am Fluss', 'Willkommen', 'Anfragen', 'Geöffnet ab Mai. Täglich']);
  assert.deepEqual(textsOf({ title: 'Kontakt', email: 'mailto:a@b.example', web: 'https://salon.example' }), ['Kontakt']);
});

test('every word must match, in the title or a text, whatever the case and accents', () => {
  const entries = [
    { source: 'page:index', title: 'Start', texts: ['Willkommen im Salon', 'Die Fähre fährt stündlich.'] },
    { source: 'page:faehre', title: 'Fährplan', texts: ['Abfahrt 9 Uhr'] },
    { source: 'post:konzert', title: 'Konzert am Fluss', texts: ['Jazz'] },
    { source: 'image:assets/img/faehre.jpg', title: 'faehre.jpg', texts: [] },
  ];
  assert.equal(normalize('Fähre ÜBER'), 'fahre uber');
  assert.deepEqual(search(entries, 'fähr').map((r) => r.source), ['page:faehre', 'page:index'], 'title first');
  assert.deepEqual(search(entries, 'FAHRE stundlich').map((r) => r.source), ['page:index']);
  assert.deepEqual(search(entries, 'faehre').map((r) => r.source), ['image:assets/img/faehre.jpg']);
  assert.deepEqual(search(entries, 'fluss konzert').map((r) => r.source), ['post:konzert']);
  assert.deepEqual(search(entries, 'salon garten'), [], 'all words');
  assert.deepEqual(search(entries, '   '), []);
});

test('a match in a text comes with the text around it', () => {
  const long = `${'Vorher '.repeat(10)}Die Fähre fährt stündlich ab dem Anleger am Fluss, im Winter seltener und bei Hochwasser gar nicht.`;
  const [result] = search([{ source: 'page:index', title: 'Start', texts: ['Kurz', long] }], 'fähre');
  assert.equal(result.snippet, '…Vorher Vorher Vorher Vorher Die Fähre fährt stündlich ab dem Anleger am Fluss, im…');
  assert.equal(search([{ source: 'page:faehre', title: 'Fähre', texts: [] }], 'fähre')[0].snippet, '', 'none when the title matches');
});
