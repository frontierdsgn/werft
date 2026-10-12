// GitHub storage details the gateway contract does not reach: paged history, conflicts, branches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubStorage } from '../gateway/storage/github.js';
import { fakeGitHub } from './fake-github.js';

const setup = () => {
  const hub = fakeGitHub();
  hub.seed({ 'site/a.json': '{}', 'b.txt': 'root' }, { author: { name: 'First', email: 'first@test' } });
  return { hub, storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', dir: 'site', api: hub.api, fetch: hub.fetch }) };
};
const bytes = (text) => new TextEncoder().encode(text);

test('finds who added a file beyond the first page of its history', async () => {
  const { storage } = setup();
  for (let i = 0; i < 105; i++) {
    const { sha } = await storage.head('main');
    await storage.commit({ branch: 'main', parent: sha, message: `edit ${i}`, author: { name: 'Later', email: 'later@test' }, changes: [{ path: 'a.json', data: bytes(`{"n":${i}}`) }] });
  }
  assert.equal(await storage.creator('main', 'a.json'), 'first@test');
  const log = await storage.log({ branch: 'main', path: 'a.json', limit: 3 });
  assert.deepEqual(log.map((c) => c.message), ['edit 104', 'edit 103', 'edit 102']);
});

test('refuses a commit on a stale parent and keeps files outside the site', async () => {
  const { storage, hub } = setup();
  const { sha: parent } = await storage.head('main');
  const first = await storage.commit({ branch: 'main', parent, message: 'one', author: { name: 'A', email: 'a@test' }, changes: [{ path: 'new/c.json', data: bytes('c') }] });
  assert.equal(new TextDecoder().decode(await storage.read(first.sha, 'new/c.json')), 'c');
  assert.equal(first.blobs['new/c.json'], (await storage.tree(first.sha)).find((e) => e.path === 'new/c.json').sha);
  await assert.rejects(storage.commit({ branch: 'main', parent, message: 'two', author: { name: 'A', email: 'a@test' }, changes: [{ path: 'a.json', data: null }] }), { status: 409 });
  assert.equal(hub.fileAt('main', 'b.txt'), 'root');
  assert.equal(hub.fileAt('main', 'site/a.json'), '{}');
  await assert.rejects(storage.head('nope'), { status: 404 });
});

test('reads many files with one request', async () => {
  const { storage, hub } = setup();
  const { sha } = await storage.head('main');
  await storage.tree(sha);
  const before = hub.requests.length;
  const files = await storage.readMany(sha, ['a.json', 'nope.json', 'a.json']);
  assert.deepEqual(files.map((b) => b && new TextDecoder().decode(b)), ['{}', null, '{}']);
  assert.deepEqual(hub.requests.slice(before), ['POST /graphql']);
});
