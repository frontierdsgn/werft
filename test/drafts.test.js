// Unsaved changes kept in the browser (admin/drafts.js): what is kept and how it comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftKey, collectDraft, changedSince, applyDraft } from '../admin/drafts.js';

// The editor's files: path → { sha, saved (text as saved, null when new), data (null when deleted) }.
const saved = (sha, data) => ({ sha, saved: JSON.stringify(data), data: structuredClone(data) });

const editing = () => new Map([
  ['content/pages/index.json', { ...saved('a1', { title: 'Start' }), data: { title: 'Willkommen' } }],
  ['content/pages/alt.json', { ...saved('b1', { title: 'Alt' }), data: null }],
  ['content/pages/neu.json', { sha: null, saved: null, data: { title: 'Neu', status: 'draft' } }],
  ['content/pages/kontakt.json', saved('c1', { title: 'Kontakt' })],
]);
const changed = ['content/pages/index.json', 'content/pages/alt.json', 'content/pages/neu.json'];

test('one draft per user, site and branch', () => {
  const key = draftKey({ site: 'https://salon.example/', branch: 'main', email: 'Anna@Salon.example' });
  assert.equal(key, draftKey({ site: 'https://salon.example/', branch: 'main', email: 'anna@salon.example' }));
  assert.notEqual(key, draftKey({ site: 'https://salon.example/', branch: 'test', email: 'anna@salon.example' }));
  assert.notEqual(key, draftKey({ site: 'https://salon.example/classic/', branch: 'main', email: 'anna@salon.example' }));
  assert.notEqual(key, draftKey({ site: 'https://salon.example/', branch: 'main', email: 'ben@salon.example' }));
});

test('a draft keeps each change with the version it started from, and survives JSON', () => {
  const draft = JSON.parse(JSON.stringify(collectDraft({ files: editing(), changed, uploads: [{ path: 'assets/img/a.png', base64: 'iVBO', size: { width: 1, height: 1 } }], removed: new Set(['assets/img/b.jpg']), now: new Date('2026-10-24T10:00:00Z') })));
  assert.deepEqual(draft, {
    saved_at: '2026-10-24T10:00:00.000Z',
    files: [
      { path: 'content/pages/index.json', sha: 'a1', data: { title: 'Willkommen' } },
      { path: 'content/pages/alt.json', sha: 'b1', data: null },
      { path: 'content/pages/neu.json', sha: null, data: { title: 'Neu', status: 'draft' } },
    ],
    uploads: [{ path: 'assets/img/a.png', base64: 'iVBO', size: { width: 1, height: 1 } }],
    removed: ['assets/img/b.jpg'],
  });
});

test('restoring after a reload brings every change back as unsaved', () => {
  const draft = collectDraft({ files: editing(), changed });
  // The editor opened again: everything as saved.
  const files = new Map([
    ['content/pages/index.json', saved('a1', { title: 'Start' })],
    ['content/pages/alt.json', saved('b1', { title: 'Alt' })],
    ['content/pages/kontakt.json', saved('c1', { title: 'Kontakt' })],
  ]);
  assert.deepEqual(changedSince(draft, files), []);
  applyDraft(draft, files);
  assert.deepEqual(files.get('content/pages/index.json'), { sha: 'a1', saved: '{"title":"Start"}', data: { title: 'Willkommen' } });
  assert.equal(files.get('content/pages/alt.json').data, null);
  assert.deepEqual(files.get('content/pages/neu.json'), { sha: null, saved: null, data: { title: 'Neu', status: 'draft' } });
  assert.deepEqual(files.get('content/pages/kontakt.json').data, { title: 'Kontakt' });
  // The draft is not shared with the files: editing one leaves the other.
  files.get('content/pages/index.json').data.title = 'Anders';
  assert.equal(draft.files[0].data.title, 'Willkommen');
});

test('what someone saved since is named, and a deletion of a file that is gone is left out', () => {
  const draft = collectDraft({ files: editing(), changed });
  const files = new Map([
    ['content/pages/index.json', saved('a2', { title: 'Start, neu' })], // saved again by someone
    ['content/pages/neu.json', saved('n1', { title: 'Neu von Ben' })], // created by someone
    // alt.json was deleted by someone
  ]);
  assert.deepEqual(changedSince(draft, files), ['content/pages/index.json', 'content/pages/alt.json', 'content/pages/neu.json']);
  applyDraft(draft, files);
  assert.deepEqual(files.get('content/pages/index.json'), { sha: 'a2', saved: '{"title":"Start, neu"}', data: { title: 'Willkommen' } });
  assert.deepEqual(files.get('content/pages/neu.json').data, { title: 'Neu', status: 'draft' });
  assert.ok(!files.has('content/pages/alt.json'));
});
