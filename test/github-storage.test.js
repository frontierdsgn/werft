// GitHub storage details the gateway contract does not reach: paged history, conflicts, branches,
// GitHub App tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { githubStorage } from '../gateway/storage/github.js';
import { githubApp } from '../gateway/storage/github-app.js';
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
  assert.ok(!hub.requests.some((r) => r.startsWith('POST') && r.includes('/git/blobs')), 'text needs no request of its own');
  const image = Uint8Array.from([0xff, 0xd8, 0xff]);
  const second = await storage.commit({ branch: 'main', parent: first.sha, message: 'image', author: { name: 'A', email: 'a@test' }, changes: [{ path: 'x.jpg', data: image }] });
  assert.deepEqual(await storage.read(second.sha, 'x.jpg'), image);
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

test('reuses a GitHub App token until five minutes before it expires', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let now = Date.now();
  const hub = fakeGitHub({ app: { id: 42, slug: 'werft', publicKey: keys.publicKey }, now: () => now });
  // Line breaks pasted as spaces still give a usable key.
  const app = (clock) => githubApp({ appId: 42, privateKey: keys.privateKey.replace(/\n/g, ' '), owner: hub.owner, repo: hub.repo, api: hub.api, fetch: hub.fetch, now: clock });
  const auth = app(() => now);
  const [first, same] = await Promise.all([auth(), auth()]);
  assert.equal(same.token, first.token);
  now += 54 * 60 * 1000;
  assert.equal((await auth()).token, first.token);
  now += 2 * 60 * 1000;
  assert.notEqual((await auth()).token, first.token);
  assert.deepEqual(hub.requests.filter((r) => !r.startsWith('POST /app/')), ['GET /repos/o/r/installation', 'GET /users/werft%5Bbot%5D'], 'installation and bot are looked up once');
  assert.equal(hub.tokens.size, 2);
  // GitHub refuses a JWT from a clock that runs ahead.
  await assert.rejects(app(() => now + 15 * 60 * 1000)(), /401/);
});

test('finds the GitHub App again after it was reinstalled', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let now = Date.now();
  const hub = fakeGitHub({ app: { id: 42, slug: 'werft', publicKey: keys.publicKey }, now: () => now });
  const auth = githubApp({ appId: 42, privateKey: keys.privateKey, owner: hub.owner, repo: hub.repo, api: hub.api, fetch: hub.fetch, now: () => now });
  await auth();
  hub.reinstall();
  now += 56 * 60 * 1000;
  await assert.rejects(auth(), /404/);
  assert.ok((await auth()).token);
});

test('explains a PKCS#1 key and a repository without the GitHub App', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const hub = fakeGitHub({ app: { id: 42, slug: 'werft', publicKey: keys.publicKey } });
  const app = (privateKey, repo) => githubApp({ appId: 42, privateKey, owner: hub.owner, repo, api: hub.api, fetch: hub.fetch })();
  const pkcs1 = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  await assert.rejects(app(pkcs1, hub.repo), /openssl pkcs8 -topk8/);
  await assert.rejects(app(keys.privateKey, 'other'), /not installed on o\/other/);
});
