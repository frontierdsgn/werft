// "Gelöschte Inhalte" in the editor (admin/deleted.js): deleted entries found through the gateway's
// history API (commits of the content, the tree at each, files at a commit) and brought back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryOf, deletedEntries, restoredEntry } from '../admin/deleted.js';
import { createGateway } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { fakeGitHub } from './fake-github.js';

const folders = { page: 'pages', pattern: 'patterns', form: 'forms', post: 'events' };

test('entries are pages, posts, patterns and forms, in every language', () => {
  const site = { contentDir: 'content', languages: ['de', 'en'], folders };
  assert.deepEqual(entryOf('content/pages/kontakt.json', site), { kind: 'page', slug: 'kontakt', lang: null });
  assert.deepEqual(entryOf('content/en/events/konzert.json', site), { kind: 'post', slug: 'konzert', lang: 'en' });
  assert.deepEqual(entryOf('content/en/patterns/anfahrt.json', site), { kind: 'pattern', slug: 'anfahrt', lang: 'en' });
  for (const other of ['content/settings/menus.json', 'content/fr/pages/a.json', 'content/pages/a.txt', 'assets/img/pages/a.json', 'content/en/settings/site.json']) assert.equal(entryOf(other, site), null, other);
  assert.equal(entryOf('content/events/a.json', { ...site, folders: { ...folders, post: undefined } }), null, 'a theme without posts');
});

test('a deleted entry is listed, restored from its last version and saved again', async () => {
  const hub = fakeGitHub();
  hub.seed({
    '.werft/users.json': serializeUsers([{ email: 'admin@test', name: 'Ada', role: 'administrator', password: await hashPassword('admin-password', 1000) }]),
    'content/pages/index.json': '{"title":"Start","status":"published"}\n',
    'content/pages/sommer.json': '{"title":"Sommer","status":"published"}\n',
    'content/pages/angebot.json': '{"title":"Angebot","status":"published"}\n',
    'content/settings/menus.json': '{}\n',
  });
  const gateway = createGateway({
    storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch: hub.fetch }),
    secret: 'x'.repeat(32), branch: 'main', iterations: 1000,
    site: { name: 'S', contentDir: 'content', postType: 'events', mediaDirs: [], languages: [] },
  });
  const REPO = '/api/v1/repos/werft/site';
  let token;
  const call = async (url, { method = 'GET', body } = {}) => {
    const response = await gateway(new Request(`https://site.test/api/werft${url}`, { method, headers: { ...(token && { authorization: `token ${token}` }), ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) }));
    assert.ok(response.ok, `${url}: ${response.status}`);
    return response.json();
  };
  token = (await call('/session', { method: 'POST', body: { email: 'admin@test', password: 'admin-password' } })).access_token;
  const text = (data) => Buffer.from(`${JSON.stringify(data, null, 2)}\n`).toString('base64');
  const save = (files) => call(`${REPO}/contents`, { method: 'POST', body: { branch: 'main', message: 'Geändert', files } });

  await save([{ operation: 'update', path: 'content/pages/sommer.json', content: text({ title: 'Sommerfest', status: 'published', sections: [{ type: 'text', body: 'Am Fluss' }] }) }]);
  await save([{ operation: 'delete', path: 'content/pages/sommer.json' }]);
  // A new address (#43): the page moves, it is not deleted.
  await save([{ operation: 'delete', path: 'content/pages/angebot.json' }, { operation: 'create', path: 'content/pages/leistungen.json', content: Buffer.from('{"title":"Angebot","status":"published"}\n').toString('base64') }]);
  await save([{ operation: 'update', path: 'content/settings/menus.json', content: text({ main: { items: [] } }) }]);

  // What the editor does: the commits of the content, the tree each left, compared in order.
  const commits = await call(`${REPO}/commits?sha=main&path=content&limit=30`);
  const snapshots = await Promise.all(commits.map(async (c) => ({ commit: { sha: c.sha, date: c.commit.author.date, author: c.commit.author.name }, files: (await call(`${REPO}/git/trees/${c.sha}?recursive=1`)).tree })));
  const now = new Set((await call(`${REPO}/git/trees/main?recursive=1`)).tree.map((f) => f.path));
  const entries = deletedEntries(snapshots, { isEntry: (p) => !!entryOf(p, { folders }), exists: (p) => now.has(p) });
  assert.deepEqual(entries.map((e) => e.path), ['content/pages/sommer.json']);
  assert.equal(entries[0].deleted.sha, commits[2].sha, 'the commit that deleted it');
  assert.equal(entries[0].deleted.author, 'Ada');

  // Its last version, read at the commit before the deletion.
  const [last] = await call(`${REPO}/file-contents?ref=${entries[0].from}`, { method: 'POST', body: { files: [entries[0].path] } });
  const data = restoredEntry(JSON.parse(Buffer.from(last.content, 'base64').toString()), 'page');
  assert.deepEqual(data, { title: 'Sommerfest', status: 'draft', sections: [{ type: 'text', body: 'Am Fluss' }] });
  assert.deepEqual(restoredEntry({ title: 'Anfahrt', sections: [] }, 'pattern'), { title: 'Anfahrt', sections: [] }, 'a pattern has no status');

  // Saved as a new file, it is there again and no longer listed.
  await save([{ operation: 'create', path: entries[0].path, content: text(data) }]);
  assert.equal(JSON.parse(hub.fileAt('main', 'content/pages/sommer.json')).title, 'Sommerfest');
  const after = new Set((await call(`${REPO}/git/trees/main?recursive=1`)).tree.map((f) => f.path));
  assert.deepEqual(deletedEntries(snapshots, { isEntry: (p) => !!entryOf(p, { folders }), exists: (p) => after.has(p) }), []);
});

test('only the newest deletion of a file counts', () => {
  const commit = (sha) => ({ sha, date: '', author: '' });
  const snapshots = [
    { commit: commit('c4'), files: [] },
    { commit: commit('c3'), files: [{ path: 'content/pages/a.json', sha: 'b2' }] },
    { commit: commit('c2'), files: [] },
    { commit: commit('c1'), files: [{ path: 'content/pages/a.json', sha: 'b1' }] },
  ];
  assert.deepEqual(deletedEntries(snapshots).map((e) => [e.path, e.deleted.sha, e.from]), [['content/pages/a.json', 'c4', 'c3']]);
});
