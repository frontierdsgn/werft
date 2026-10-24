// Two-factor sign-in through the gateway's public API: setting it up with a code from the app,
// signing in with a code or a recovery code (each once), switching it off, an administrator
// resetting it, and a site that requires it of administrators.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { codeAt, STEP } from '../gateway/totp.js';
import { memoryMail } from '../gateway/mail.js';
import { fakeGitHub } from './fake-github.js';

const ORIGIN = 'https://site.test';

async function setup({ twoFactor, mail } = {}) {
  const hub = fakeGitHub();
  hub.seed({ '.werft/users.json': serializeUsers([
    { email: 'ada@test', name: 'Ada', role: 'administrator', password: await hashPassword('admin-password', 1000) },
    { email: 'ed@test', name: 'Ed', role: 'editor', password: await hashPassword('editor-password', 1000) },
    { email: 'eve@example.org', name: 'Eve', role: 'author', password: await hashPassword('author-password', 1000) },
  ]), 'content/settings/site.json': JSON.stringify({ url: 'https://example.org' }) });
  const clock = { t: Date.parse('2026-06-01T00:00:00Z') };
  const gateway = createGateway({
    storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch: hub.fetch }),
    secret: 'x'.repeat(32), iterations: 1000, now: () => clock.t, mail,
    site: { name: 'Insel Salon', contentDir: 'content', twoFactor },
  });
  const call = async (path, { token, body, method = body ? 'POST' : 'GET' } = {}) => {
    const response = await gateway(new Request(`${ORIGIN}/api/werft${path}`, { method, headers: { ...(token && { authorization: `token ${token}` }), ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) }));
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
  };
  const code = (secret, offset = 0) => codeAt(secret, Math.floor(clock.t / 1000 / STEP) + offset);
  // Sets up two-factor sign-in for a signed-in user; returns the secret and the recovery codes.
  const enable = async (token, password) => {
    const started = await call('/me/two-factor', { token, body: { action: 'start' } });
    const done = await call('/me/two-factor', { token, body: { action: 'enable', pending: started.data.pending, code: await code(started.data.secret), current_password: password } });
    return { secret: started.data.secret, codes: done.data.recovery_codes, token: done.data.access_token, started, done };
  };
  return { call, clock, code, enable, hub };
}

test('sets up two-factor sign-in with a code from the app, keeping the secret sealed', async () => {
  const { call, code, hub } = await setup();
  const token = (await call('/session', { body: { email: 'ada@test', password: 'admin-password' } })).data.access_token;
  const other = (await call('/session', { body: { email: 'ada@test', password: 'admin-password' } })).data.access_token;
  const started = await call('/me/two-factor', { token, body: { action: 'start' } });
  assert.match(started.data.url, new RegExp(`^otpauth://totp/Insel%20Salon:ada%40test\\?secret=${started.data.secret}&issuer=Insel%20Salon`));
  const enable = (body) => call('/me/two-factor', { token, body: { action: 'enable', pending: started.data.pending, current_password: 'admin-password', ...body } });
  assert.equal((await enable({ code: '000000' })).status, 422, 'a wrong code');
  assert.equal((await enable({ code: await code(started.data.secret), current_password: 'wrong' })).status, 422, 'the current password is needed');
  const done = await enable({ code: await code(started.data.secret) });
  assert.equal(done.status, 200);
  assert.equal(done.data.two_factor, true);
  assert.equal(done.data.recovery_codes.length, 10);
  assert.match(done.data.recovery_codes[0], /^[a-z2-7]{4}-[a-z2-7]{4}$/);
  assert.equal((await call('/me', { token: done.data.access_token })).data.recovery_left, 10, 'this session goes on');
  assert.equal((await call('/me', { token: other })).status, 401, 'other sessions end');
  const stored = hub.fileAt('main', '.werft/users.json');
  assert.ok(/"totp": "v1\./.test(stored) && !stored.includes(started.data.secret) && !stored.includes(done.data.recovery_codes[0]), 'neither the secret nor the codes are in the repository');
});

test('signs in with the password and then a code, each code once', async () => {
  const { call, clock, code, enable } = await setup();
  const { secret, codes } = await enable((await call('/session', { body: { email: 'ada@test', password: 'admin-password' } })).data.access_token, 'admin-password');
  clock.t += 60 * 1000;
  const first = await call('/session', { body: { email: 'ada@test', password: 'admin-password' } });
  assert.deepEqual([first.status, first.data.second_factor, first.data.access_token, first.cookie], [200, true, undefined, null], 'the password alone gives no session');
  const second = (body) => call('/session', { body: { ticket: first.data.ticket, ...body } });
  assert.equal((await second({ code: '123456' })).status, 401);
  const now = await code(secret);
  const signedIn = await second({ code: now });
  assert.equal(signedIn.status, 200);
  assert.ok(signedIn.data.access_token && signedIn.data.device && /^werft_refresh=/.test(signedIn.cookie));
  assert.equal((await second({ code: now })).status, 401, 'a code works once');
  assert.equal((await second({ code: await code(secret, -1) })).status, 401, 'nor an older one after it');
  assert.equal((await second({ code: codes[0].toUpperCase() })).status, 200, 'a recovery code, in any case');
  assert.equal((await second({ code: codes[0] })).status, 401, 'once');
  assert.equal((await call('/me', { token: signedIn.data.access_token })).data.recovery_left, 9);
  clock.t += 6 * 60 * 1000;
  assert.deepEqual(await second({ code: await code(secret) }).then((r) => [r.status, r.data.message]), [401, 'Bitte melden Sie sich noch einmal an.'], 'the ticket lasts five minutes');
});

test('guessing codes is throttled', async () => {
  const { call, enable } = await setup();
  await enable((await call('/session', { body: { email: 'ada@test', password: 'admin-password' } })).data.access_token, 'admin-password');
  const { ticket } = (await call('/session', { body: { email: 'ada@test', password: 'admin-password' } })).data;
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await call('/session', { body: { ticket, code: String(100000 + i) } })).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
});

test('switching it off needs the password; an administrator can reset it for someone', async () => {
  const { call, clock, code, enable } = await setup();
  const edToken = (await call('/session', { body: { email: 'ed@test', password: 'editor-password' } })).data.access_token;
  const ed = await enable(edToken, 'editor-password');
  assert.equal((await call('/me/two-factor', { token: ed.token, body: { action: 'disable', current_password: 'wrong' } })).status, 422);
  const recovery = await call('/me/two-factor', { token: ed.token, body: { action: 'recovery', current_password: 'editor-password' } });
  assert.equal(recovery.data.recovery_codes.length, 10);
  assert.notDeepEqual(recovery.data.recovery_codes, ed.codes);
  const off = await call('/me/two-factor', { token: ed.token, body: { action: 'disable', current_password: 'editor-password' } });
  assert.equal(off.data.two_factor, false);
  assert.ok((await call('/session', { body: { email: 'ed@test', password: 'editor-password' } })).data.access_token, 'the password alone signs in again');

  clock.t += 60 * 1000;
  const again = await enable((await call('/session', { body: { email: 'ed@test', password: 'editor-password' } })).data.access_token, 'editor-password');
  const { ticket } = (await call('/session', { body: { email: 'ed@test', password: 'editor-password' } })).data;
  clock.t += STEP * 1000; // the code that switched it on is used
  const edSession = (await call('/session', { body: { ticket, code: await code(again.secret) } })).data.access_token;
  const admin = (await call('/session', { body: { email: 'ada@test', password: 'admin-password' } })).data.access_token;
  assert.equal((await call('/users', { token: edSession, body: { action: 'two-factor-off', email: 'ada@test' } })).status, 403);
  const reset = await call('/users', { token: admin, body: { action: 'two-factor-off', email: 'ed@test' } });
  assert.equal(reset.data.users.find((u) => u.email === 'ed@test').two_factor, false);
  assert.equal((await call('/me', { token: edSession })).status, 401, 'their sessions end');
  assert.ok((await call('/session', { body: { email: 'ed@test', password: 'editor-password' } })).data.access_token);
});

test('a site can require it of administrators: until then they reach only "Mein Konto"', async () => {
  const { call, enable } = await setup({ twoFactor: true });
  const token = (await call('/session', { body: { email: 'ada@test', password: 'admin-password' } })).data.access_token;
  assert.deepEqual(await call('/me', { token }).then((r) => [r.data.two_factor_required, r.data.two_factor_mandatory]), [true, true]);
  const blocked = await call('/users', { token });
  assert.deepEqual([blocked.status, blocked.data.code], [403, 'two_factor_setup']);
  const editor = (await call('/session', { body: { email: 'ed@test', password: 'editor-password' } })).data.access_token;
  assert.equal((await call('/me', { token: editor })).data.two_factor_required, false, 'other roles may use it');
  const { token: after } = await enable(token, 'admin-password');
  assert.equal((await call('/users', { token: after })).status, 200);
  assert.equal((await call('/me/two-factor', { token: after, body: { action: 'disable', current_password: 'admin-password' } })).status, 422, 'and cannot switch it off');
});

test('a new password by e-mail still needs the code', async () => {
  const mail = memoryMail({ from: 'werft@example.org' });
  const { call, clock, code, enable } = await setup({ mail });
  const { secret } = await enable((await call('/session', { body: { email: 'eve@example.org', password: 'author-password' } })).data.access_token, 'author-password');
  assert.equal((await call('/password/forgot', { body: { email: 'eve@example.org' } })).status, 200);
  await new Promise((r) => setTimeout(r, 20));
  const token = /#passwort=([\w.-]+)/.exec(mail.sent[0].text)[1];
  const reset = await call('/password/reset', { body: { token, password: 'new-author-password' } });
  assert.deepEqual([reset.status, reset.data.second_factor, reset.data.access_token, reset.cookie], [200, true, undefined, null], 'the mailbox alone gives no session');
  clock.t += STEP * 1000;
  assert.equal((await call('/session', { body: { ticket: reset.data.ticket, code: await code(secret) } })).status, 200);
});

test('no second setup, no reset of the own account, and a recovery code works once even at once', async () => {
  const { call, code, enable } = await setup();
  const admin = (await call('/session', { body: { email: 'ada@test', password: 'admin-password' } })).data.access_token;
  const { secret, codes, token, started } = await enable(admin, 'admin-password');
  assert.equal((await call('/me/two-factor', { token, body: { action: 'enable', pending: started.data.pending, code: await code(secret), current_password: 'admin-password' } })).status, 422, 'already on');
  assert.equal((await call('/users', { token, body: { action: 'two-factor-off', email: 'ada@test' } })).status, 422, 'one\'s own goes off with the password');
  const { ticket } = (await call('/session', { body: { email: 'ada@test', password: 'admin-password' } })).data;
  assert.equal((await call('/session', { body: { ticket, code: await code(secret) } })).status, 401, 'the code that switched it on is used');
  const both = await Promise.all([call('/session', { body: { ticket, code: codes[2] } }), call('/session', { body: { ticket, code: codes[2] } })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
});
