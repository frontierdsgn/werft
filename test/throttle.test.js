// Throttled sign-in: failed attempts per account, per address and per device token, through the
// gateway's /api/werft/session, with the store shared between processes or not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { addressKey, throttle } from '../gateway/throttle.js';
import { fakeGitHub } from './fake-github.js';

const minute = 60 * 1000;

async function setup({ store, clock = { t: Date.parse('2026-06-01T00:00:00Z') }, iterations = 1000, down = { now: false } } = {}) {
  const hub = fakeGitHub();
  hub.seed({ '.werft/users.json': serializeUsers([{ email: 'ada@test', name: 'Ada', role: 'administrator', password: await hashPassword('right-password', iterations) }]) });
  const fetch = (...args) => (down.now ? Promise.resolve(new Response('{}', { status: 503 })) : hub.fetch(...args));
  const instance = () => createGateway({
    storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch }),
    secret: 'x'.repeat(32), site: { name: 'Test', contentDir: 'content' }, now: () => clock.t, throttleStore: store,
  });
  const signInWith = (gateway) => async (email, password, { address = '198.51.100.7', device } = {}) => {
    const response = await gateway(new Request('https://site.test/api/werft/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, device }) }), { address });
    return { status: response.status, retry: response.headers.get('retry-after'), data: await response.json() };
  };
  return { clock, instance, signIn: signInWith(instance()), signInWith };
}

test('slows down failed sign-ins of an account, the same for unknown ones', async () => {
  const { clock, signIn } = await setup();
  for (const email of ['ada@test', 'nobody@test']) {
    for (let i = 0; i < 5; i++) assert.equal((await signIn(email, 'wrong')).status, 401);
    const refused = await signIn(email, 'right-password', { address: '203.0.113.9' });
    assert.deepEqual([refused.status, refused.retry, refused.data.message], [429, '60', 'Zu viele Anmeldeversuche. Bitte in einer Minute noch einmal versuchen.'], 'even the right password waits, from any address');
  }
  clock.t += minute;
  assert.equal((await signIn('ada@test', 'wrong')).status, 401);
  const longer = await signIn('ada@test', 'right-password');
  assert.deepEqual([longer.status, longer.retry, longer.data.message], [429, '120', 'Zu viele Anmeldeversuche. Bitte in 2 Minuten noch einmal versuchen.'], 'each further failure doubles the wait');
  clock.t += 2 * minute;
  assert.equal((await signIn('ada@test', 'right-password')).status, 200);
  assert.equal((await signIn('ada@test', 'wrong')).status, 401, 'a success clears the count');
});

test('waits at most 15 minutes and forgets attempts after an hour', async () => {
  const { clock, signIn } = await setup();
  for (let i = 0; i < 5; i++) await signIn('ada@test', 'wrong');
  for (const wait of [1, 2, 4, 8, 15, 15]) {
    assert.equal((await signIn('ada@test', 'wrong')).retry, String(wait * 60));
    clock.t += wait * minute;
    assert.equal((await signIn('ada@test', 'wrong')).status, 401);
  }
  clock.t += 61 * minute;
  for (let i = 0; i < 5; i++) assert.equal((await signIn('ada@test', 'wrong')).status, 401, 'five free attempts again');
});

test('limits one address across accounts', async () => {
  const { signIn } = await setup();
  for (let i = 0; i < 20; i++) assert.equal((await signIn(`guess${i}@test`, 'wrong')).status, 401);
  assert.equal((await signIn('ada@test', 'right-password')).status, 429);
  assert.equal((await signIn('ada@test', 'right-password', { address: '203.0.113.9' })).status, 200, 'another address is not affected');
  for (let i = 0; i < 20; i++) await signIn(`guess${i}@test`, 'wrong', { address: '2001:db8:1:2::1' });
  assert.equal((await signIn('ada@test', 'right-password', { address: '2001:db8:1:2:aaaa::5' })).status, 429, 'IPv6 counts by /64');
});

test('a browser that signed in before is not locked out by guesses from elsewhere', async () => {
  const { signIn } = await setup();
  const { device } = (await signIn('ada@test', 'right-password')).data;
  for (let i = 0; i < 5; i++) await signIn('ada@test', 'wrong', { address: `192.0.2.${i}` });
  assert.equal((await signIn('ada@test', 'right-password')).status, 429);
  assert.equal((await signIn('ada@test', 'right-password', { device })).status, 200);
  assert.equal((await signIn('nobody@test', 'wrong', { device })).status, 401);
  for (let i = 0; i < 5; i++) await signIn('ada@test', 'wrong', { device });
  assert.equal((await signIn('ada@test', 'right-password', { device })).status, 429, 'the device token has its own count');
});

test('counts parallel guesses', async () => {
  const { signIn } = await setup();
  const statuses = (await Promise.all(Array.from({ length: 12 }, () => signIn('ada@test', 'wrong')))).map((r) => r.status);
  assert.deepEqual([statuses.filter((s) => s === 401).length, statuses.filter((s) => s === 429).length], [5, 7]);
});

test('a shared store counts across processes and a failing one leaves the local count', async () => {
  const map = new Map();
  const store = { get: async (k) => map.get(k) ?? null, put: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
  const shared = await setup({ store });
  const other = shared.signInWith(shared.instance());
  for (let i = 0; i < 5; i++) await shared.signIn('ada@test', 'wrong');
  assert.equal((await other('ada@test', 'right-password')).status, 429);
  shared.clock.t += minute;
  assert.equal((await other('ada@test', 'right-password')).status, 200);
  assert.equal(map.size, 1, 'the success deleted the account count, the address count stays');

  const broken = await setup({ store: { get: async () => { throw new Error('quota'); }, put: async () => { throw new Error('quota'); }, delete: async () => { throw new Error('quota'); } } });
  for (let i = 0; i < 5; i++) assert.equal((await broken.signIn('ada@test', 'wrong')).status, 401);
  assert.equal((await broken.signIn('ada@test', 'right-password')).status, 429);
});

test('normalizes addresses', () => {
  assert.equal(addressKey('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(addressKey('2001:DB8:0:0:1::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(addressKey('::1'), '0:0:0:0::/64');
  assert.equal(addressKey(''), null);
});

test('an attempt the gateway could not decide does not count', async () => {
  const down = { now: true };
  const { signIn } = await setup({ down });
  for (let i = 0; i < 6; i++) assert.equal((await signIn('ada@test', 'wrong')).status, 500);
  down.now = false;
  assert.equal((await signIn('ada@test', 'right-password')).status, 200);
});

test('an unknown e-mail takes as long as a known one', async () => {
  const { signIn } = await setup({ iterations: 50000 });
  const fastest = async (email) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) { const t = performance.now(); await signIn(email, 'wrong', { address: `192.0.2.${i}` }); best = Math.min(best, performance.now() - t); }
    return best;
  };
  const known = await fastest('ada@test');
  assert.ok(await fastest('nobody@test') > known / 5, 'the stand-in hash has as many iterations');
});

test('a flood of new keys does not push out a count in a wait, nor the count being made', async () => {
  const clock = { t: Date.parse('2026-06-01T00:00:00Z') };
  const limiter = throttle({ secret: 'x'.repeat(32), now: () => clock.t, maxKeys: 10 });
  const fail = async (key) => (await limiter.attempt([key])).failed();
  for (let i = 0; i < 5; i++) await fail(['account', 'ada@test']);
  for (let i = 0; i < 50; i++) await fail(['account', `new${i}@test`]);
  assert.ok((await limiter.attempt([['account', 'ada@test']])).wait > 0);
  // Counts of 2 that are not in a wait fill the memory; a new count still holds.
  for (let i = 0; i < 20; i++) { await fail(['account', `two${i}@test`]); await fail(['account', `two${i}@test`]); }
  for (let i = 0; i < 5; i++) await fail(['account', 'eve@test']);
  assert.ok((await limiter.attempt([['account', 'eve@test']])).wait > 0);
});

test('overlapping successes leave no wait behind', async () => {
  const { signIn } = await setup();
  for (let i = 0; i < 18; i++) await signIn(`guess${i}@test`, 'wrong');
  assert.deepEqual((await Promise.all([signIn('ada@test', 'right-password'), signIn('ada@test', 'right-password')])).map((r) => r.status), [200, 200]);
  assert.equal((await signIn('bob@test', 'wrong')).status, 401);
});

test('signing in to an own account does not reset the guesses from that address', async () => {
  const { signIn } = await setup();
  for (let i = 0; i < 19; i++) await signIn(`guess${i}@test`, 'wrong');
  assert.equal((await signIn('ada@test', 'right-password')).status, 200);
  assert.equal((await signIn('guess@test', 'wrong')).status, 401, 'the success itself does not count');
  assert.equal((await signIn('guess@test', 'wrong')).status, 429);
  const office = await setup();
  for (let i = 0; i < 30; i++) assert.equal((await office.signIn('ada@test', 'right-password')).status, 200, 'sign-ins that succeed never wait');
  for (let i = 0; i < 24; i++) { await office.signIn(`guess${i}@test`, 'wrong'); office.clock.t += 15 * minute; }
  assert.equal((await office.signIn('ada@test', 'right-password')).status, 200);
  assert.equal((await office.signIn('bob@test', 'wrong')).status, 401, 'a success starts no wait at an address with many failures');
});
