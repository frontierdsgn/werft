// A page's new address in the editor (admin/rename.js): links in the content and the redirects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retargetLink, retargetLinks, mentions, movedRedirects, retargetParents } from '../admin/rename.js';

test('links to the old address lead to the new one, other links stay', () => {
  const retarget = retargetLink('angebot', 'leistungen', { base: '/', languages: ['de', 'en'] });
  const moved = {
    'angebot.html': 'leistungen.html',
    './angebot.html': './leistungen.html',
    '../angebot.html': '../leistungen.html',
    'angebot.html#preise': 'leistungen.html#preise',
    'angebot.html?x=1': 'leistungen.html?x=1',
    '/angebot.html': '/leistungen.html',
    'en/angebot.html': 'en/leistungen.html',
    '/en/angebot.html': '/en/leistungen.html',
  };
  for (const [from, to] of Object.entries(moved)) assert.equal(retarget(from), to, from);
  for (const same of ['sonderangebot.html', 'angebot.htm', 'angebot.html.bak', 'fr/angebot.html', 'https://example.org/angebot.html', 'kontakt.html', 'angebot']) {
    assert.equal(retarget(same), same, same);
  }
  // Below a base path, a root-relative link names the base.
  const below = retargetLink('angebot', 'leistungen', { base: '/salon/' });
  assert.equal(below('/salon/angebot.html'), '/salon/leistungen.html');
  assert.equal(below('/angebot.html'), '/angebot.html');
});

test('the content is rewritten: link fields, menus, Markdown and HTML', () => {
  const retarget = retargetLink('angebot', 'leistungen');
  const page = {
    title: 'Start',
    sections: [
      { type: 'hero', link: { label: 'Unser Angebot', url: 'angebot.html' } },
      { type: 'text', body: 'Siehe [das Angebot](angebot.html "Angebot") und [Preise](angebot.html#preise), nicht [das](sonderangebot.html).' },
      { type: 'html', body: '<a href="angebot.html">Angebot</a> <a href=\'kontakt.html\'>Kontakt</a>' },
    ],
  };
  const { data, changed } = retargetLinks(page, retarget);
  assert.ok(changed);
  assert.equal(data.sections[0].link.url, 'leistungen.html');
  assert.equal(data.sections[0].link.label, 'Unser Angebot');
  assert.equal(data.sections[1].body, 'Siehe [das Angebot](leistungen.html "Angebot") und [Preise](leistungen.html#preise), nicht [das](sonderangebot.html).');
  assert.equal(data.sections[2].body, '<a href="leistungen.html">Angebot</a> <a href=\'kontakt.html\'>Kontakt</a>');
  assert.equal(page.sections[0].link.url, 'angebot.html', 'the original is left as it was');

  const menus = { main: { items: [{ label: 'Angebot', url: 'angebot.html' }, { label: 'Kontakt', url: 'kontakt.html' }] } };
  assert.deepEqual(retargetLinks(menus, retarget).data.main.items.map((i) => i.url), ['leistungen.html', 'kontakt.html']);
  assert.equal(retargetLinks({ title: 'Kontakt', count: 3, on: true, none: null }, retarget).changed, false);
});

test('an address the editor cannot rewrite is found for the list', () => {
  assert.ok(mentions({ body: 'https://salon.example/angebot.html' }, 'angebot'));
  assert.ok(!mentions({ body: 'sonderangebot.html' }, 'angebot'));
  assert.ok(!mentions({ body: 'leistungen.html' }, 'angebot'));
});

test('the old address redirects to the new one, without chains or loops', () => {
  const before = [
    { from: '/alt.html', to: '/angebot.html', status: 301 },
    { from: '/leistungen.html', to: '/angebot.html', status: 301 },
    { from: '/blog/*', to: '/news/:splat', status: 302 },
  ];
  const after = movedRedirects(before, [{ from: '/angebot.html', to: '/leistungen.html' }, { from: '/en/angebot.html', to: '/en/leistungen.html' }]);
  assert.deepEqual(after, [
    { from: '/alt.html', to: '/leistungen.html', status: 301 },
    { from: '/blog/*', to: '/news/:splat', status: 302 },
    { from: '/angebot.html', to: '/leistungen.html', status: 301 },
    { from: '/en/angebot.html', to: '/en/leistungen.html', status: 301 },
  ]);
  assert.deepEqual(movedRedirects(undefined, [{ from: '/a.html', to: '/b.html' }]), [{ from: '/a.html', to: '/b.html', status: 301 }]);
});

test('pages below a renamed page keep their place below it', () => {
  const pages = [{ title: 'Preise', parent: 'tagen' }, { title: 'Räume', parent: 'preise' }, { title: 'Kontakt' }, null];
  assert.equal(retargetParents(pages, 'tagen', 'tagungen'), 1);
  assert.deepEqual(pages.map((p) => p?.parent), ['tagungen', 'preise', undefined, undefined]);
});
