// "Passwort vergessen?": a link by e-mail through the mail module's test driver, then a new
// password, through the gateway's public API; and at the Node server, where the link's address
// never comes from the Host header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { memoryMail } from '../gateway/mail.js';
import { serve } from '../adapters/node.js';
import { fakeGitHub } from './fake-github.js';

const ORIGIN = 'https://site.test';
const hour = 3600 * 1000;

async function setup({ mail = memoryMail({ from: 'werft@site.test' }), files = {}, site = {} } = {}) {
  const hub = fakeGitHub();
  hub.seed({ '.werft/users.json': serializeUsers([{ email: 'ada@example.org', name: 'Ada', role: 'administrator', password: await hashPassword('old-password', 1000) }]), ...files });
  const clock = { t: Date.parse('2026-06-01T00:00:00Z') };
  const tasks = [];
  const gateway = createGateway({
    storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch: hub.fetch }),
    secret: 'x'.repeat(32), iterations: 1000, mail, now: () => clock.t,
    site: { name: 'Test', contentDir: 'content', base: 'sub', ...site },
  });
  const call = async (p, body, { origin = ORIGIN, address = '198.51.100.7' } = {}) => {
    const response = await gateway(new Request(`${ORIGIN}/api/werft${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { address, origin, waitUntil: (p) => tasks.push(p) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
  };
  const forgot = async (email, options) => { const r = await call('/password/forgot', { email }, options); await Promise.all(tasks); return r; };
  const tokenFrom = (message) => /#passwort=([\w.-]+)/.exec(message.text)[1];
  return { call, forgot, mail, clock, tokenFrom };
}

test('sends a link to an account, the same reply without one, and sets the new password', async () => {
  const { call, forgot, mail, tokenFrom } = await setup();
  const known = await forgot('Ada@example.org');
  const unknown = await forgot('nobody@example.org');
  assert.deepEqual([known.status, unknown.status, known.data], [200, 200, unknown.data], 'the reply does not show which addresses have an account');
  assert.equal(mail.sent.length, 1);
  const [message] = mail.sent;
  assert.deepEqual([message.to, message.from.name, message.subject], [['ada@example.org'], 'Test', 'Neues Passwort für Test']);
  assert.match(message.text, /https:\/\/site\.test\/admin\/#passwort=/, 'the admin is at the root of the host, whatever the base');

  const reset = await call('/password/reset', { token: tokenFrom(message), password: 'new-password' });
  assert.equal(reset.status, 200);
  assert.ok(reset.data.access_token && /^werft_refresh=[^;]+;/.test(reset.cookie), 'it signs in');
  assert.equal((await call('/session', { email: 'ada@example.org', password: 'old-password' })).status, 401);
  assert.equal((await call('/session', { email: 'ada@example.org', password: 'new-password' })).status, 200);
});

test('a link works once, for an hour, and not after another password change', async () => {
  const { call, forgot, mail, clock, tokenFrom } = await setup();
  await forgot('ada@example.org');
  const once = tokenFrom(mail.sent[0]);
  assert.equal((await call('/password/reset', { token: once, password: 'short' })).status, 422, 'a too short password does not use up the link');
  assert.equal((await call('/password/reset', { token: once, password: 'new-password' })).status, 200);
  const again = await call('/password/reset', { token: once, password: 'other-password' });
  assert.deepEqual([again.status, again.data.message], [410, 'Dieser Link gilt nicht mehr. Bitte fordern Sie einen neuen an.']);

  await forgot('ada@example.org');
  clock.t += hour + 1000;
  assert.equal((await call('/password/reset', { token: tokenFrom(mail.sent[1]), password: 'late-password' })).status, 410, 'expired');

  clock.t += 24 * hour; // the requests so far are forgotten
  await forgot('ada@example.org');
  const older = tokenFrom(mail.sent[2]);
  await forgot('ada@example.org');
  assert.equal((await call('/password/reset', { token: tokenFrom(mail.sent[3]), password: 'newer-password' })).status, 200);
  assert.equal((await call('/password/reset', { token: older, password: 'older-password' })).status, 410, 'a password set since ends earlier links');
  assert.equal((await call('/password/reset', { token: 'forged.token', password: 'forged-password' })).status, 410);
});

test('requests are throttled per address entered, and need a mail driver', async () => {
  const { forgot, mail } = await setup();
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await forgot('ada@example.org', { address: `192.0.2.${i}` })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal(mail.sent.length, 3);
  // Someone asking each time a wait ends gets about 25 e-mails a day to one address.
  const steady = await setup();
  const end = steady.clock.t + 24 * hour;
  for (let i = 0; steady.clock.t < end; i++) {
    const { status, data } = await steady.call('/password/forgot', { email: 'ada@example.org' }, { address: `192.0.2.${i % 250}` });
    const minutes = status === 429 ? (/in (\d+) Minuten/.exec(data.message)?.[1] ?? 1) : 0;
    steady.clock.t += minutes * 60 * 1000 + 1000;
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(steady.mail.sent.length <= 30, `${steady.mail.sent.length} e-mails in a day`);
  const without = await setup({ mail: null });
  const refused = await without.forgot('ada@example.org');
  assert.deepEqual([refused.status, refused.data.message], [503, 'Diese Website verschickt keine E-Mails. Ein Administrator kann Ihnen ein neues Passwort geben.']);
});

test('without an origin from the host, the link uses the site setting url, else none is sent', async () => {
  const withUrl = await setup({ files: { 'content/settings/site.json': JSON.stringify({ url: 'https://www.example.test/sub' }) } });
  assert.equal((await withUrl.forgot('ada@example.org', { origin: null })).status, 200);
  assert.match(withUrl.mail.sent[0].text, /https:\/\/www\.example\.test\/admin\/#passwort=/);
  const none = await setup();
  assert.equal((await none.forgot('ada@example.org', { origin: null })).status, 200);
  assert.equal(none.mail.sent.length, 0);
  const noAdmin = await setup({ site: { admin: false } });
  assert.equal((await noAdmin.forgot('ada@example.org')).status, 200);
  assert.equal(noAdmin.mail.sent.length, 0, 'a site without the admin sends no link');
});

test('werft dev links to its own address, whatever Host header a request sends; werft serve does not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-reset-'));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write('werft.config.js', "export default { name: 'T', theme: './theme/index.js', output: '_site' };\n");
  write('theme/index.js', 'export default { blocks: {}, renderPage: (page, ctx) => ctx.html`<title>${page.title}</title>` };\n');
  write('content/pages/index.json', '{"title":"Start","status":"published"}\n');
  write('.werft/users.json', serializeUsers([{ email: 'ada@example.org', name: 'Ada', role: 'administrator', password: await hashPassword('old-password', 1000) }]));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@test', 'commit', '--quiet', '-m', 'init'], { cwd: root });
  const logged = [];
  const dev = await serve({ dir: root, port: 0, secret: 'x'.repeat(32), mail: 'log', dev: true, log: (line) => logged.push(String(line)) });
  const served = await serve({ dir: root, port: 0, secret: 'x'.repeat(32), mail: 'log', log: (line) => logged.push(String(line)) });
  try {
    const port = dev.server.address().port;
    const body = JSON.stringify({ email: 'ada@example.org' });
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/werft/password/forgot', method: 'POST', headers: { host: 'evil.test', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(status, 200);
    for (let i = 0; i < 50 && !logged.some((l) => l.includes('#passwort=')); i++) await new Promise((r) => setTimeout(r, 20));
    const mailText = logged.find((l) => l.includes('#passwort='));
    assert.ok(mailText.includes(`http://127.0.0.1:${port}/admin/#passwort=`) && !mailText.includes('evil.test'));
    // werft serve on 127.0.0.1 behind a proxy: not its own address, and here no site setting url.
    logged.length = 0;
    await fetch(`http://127.0.0.1:${served.server.address().port}/api/werft/password/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!logged.some((l) => l.includes('#passwort=')), 'werft serve sends no link to 127.0.0.1');
  } finally {
    served.close();
    dev.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
