// The mail drivers that deliver through a provider, each against a fake: the HTTP APIs of
// Cloudflare Email Service, Brevo and Resend through a fake fetch, SMTP against a local fake server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mailFromEnv } from '../gateway/mail.js';
import { cloudflareMail } from '../gateway/mail-cloudflare.js';
import { smtpMail, smtpFromEnv } from '../gateway/mail-smtp.js';
import { pagesFunction } from '../adapters/cloudflare.js';
import { fakeMailApi, fakeSmtp, parseMail, KEYS } from './fake-mail.js';
import { fakeGitHub } from './fake-github.js';

const FROM = 'site@example.org';
const message = { to: ['owner@example.org', 'team@example.org'], subject: 'Neue Einsendung: Kontakt', text: 'Name: Ana\nNachricht: Hallo', replyTo: 'ana@example.net', fromName: 'Die Werft' };
const ENV = {
  cloudflare: { WERFT_MAIL: 'cloudflare', WERFT_MAIL_FROM: FROM, WERFT_MAIL_ACCOUNT: KEYS.account, WERFT_MAIL_KEY: KEYS.cloudflare },
  brevo: { WERFT_MAIL: 'brevo', WERFT_MAIL_FROM: FROM, WERFT_MAIL_KEY: KEYS.brevo },
  resend: { WERFT_MAIL: 'resend', WERFT_MAIL_FROM: FROM, WERFT_MAIL_KEY: KEYS.resend },
};

test('each HTTP driver posts the checked message in its provider\'s form', async () => {
  const api = fakeMailApi();
  const send = (provider, m = message) => mailFromEnv(ENV[provider], { fetch: api.fetch }).send(m);
  assert.deepEqual(await send('cloudflare'), { id: 'cf-1' });
  assert.deepEqual(await send('brevo'), { id: '<brevo-2@smtp-relay.mailin.fr>' });
  assert.deepEqual(await send('resend'), { id: 'resend-3' });
  await send('resend', { to: 'owner@example.org', subject: 'S', text: 'T' });
  assert.deepEqual(api.requests.map((r) => r.body), [
    { from: { address: FROM, name: 'Die Werft' }, to: message.to, subject: message.subject, text: message.text, reply_to: 'ana@example.net' },
    { sender: { email: FROM, name: 'Die Werft' }, to: [{ email: 'owner@example.org' }, { email: 'team@example.org' }], replyTo: { email: 'ana@example.net' }, subject: message.subject, textContent: message.text },
    { from: `"Die Werft" <${FROM}>`, to: message.to, subject: message.subject, text: message.text, reply_to: 'ana@example.net' },
    { from: FROM, to: ['owner@example.org'], subject: 'S', text: 'T' },
  ]);
  assert.equal(api.requests[0].headers['content-type'], 'application/json');
});

test('an HTTP driver rejects when the provider refuses, without the key in the error', async () => {
  const api = fakeMailApi();
  for (const provider of ['cloudflare', 'brevo', 'resend']) {
    const env = { ...ENV[provider], WERFT_MAIL_KEY: 'wrong-secret-key' };
    await assert.rejects(mailFromEnv(env, { fetch: api.fetch }).send(message), (error) => {
      assert.match(error.message, new RegExp(`^E-mail \\(${provider}\\): the provider refused the e-mail \\((401|403)`));
      assert.doesNotMatch(error.message, /wrong-secret-key/);
      return true;
    });
  }
  api.failure = { status: 400, body: { code: 'invalid_parameter', message: 'sender not verified' } };
  await assert.rejects(mailFromEnv(ENV.brevo, { fetch: api.fetch }).send(message), /\(400: sender not verified\)/);
  api.failure = { status: 502, body: 'not json' };
  await assert.rejects(mailFromEnv(ENV.resend, { fetch: api.fetch }).send(message), /\(502\)/);
  api.failure = null;
  api.bounce = true;
  await assert.rejects(mailFromEnv(ENV.cloudflare, { fetch: api.fetch }).send(message), /no recipient accepted the e-mail \(bounced: owner@example.org, team@example.org\)/);
  await assert.rejects(cloudflareMail({ from: FROM, account: KEYS.account, token: KEYS.cloudflare, fetch: () => Promise.reject(new TypeError('fetch failed')) }).send(message), /no answer from the provider \(fetch failed\)/);
  assert.equal(api.requests.length, 1, 'only the bounced e-mail reached the provider');
});

test('the environment configures each driver, and a missing setting is an error at start', () => {
  assert.throws(() => mailFromEnv({ WERFT_MAIL: 'brevo', WERFT_MAIL_FROM: FROM }), /WERFT_MAIL=brevo needs WERFT_MAIL_KEY/);
  assert.throws(() => mailFromEnv({ WERFT_MAIL: 'cloudflare', WERFT_MAIL_FROM: FROM, WERFT_MAIL_KEY: 'k' }), /needs WERFT_MAIL_ACCOUNT/);
  assert.throws(() => mailFromEnv({ ...ENV.resend, WERFT_MAIL_FROM: '' }), /WERFT_MAIL_FROM must be an e-mail address/);
  assert.throws(() => mailFromEnv({ WERFT_MAIL: 'smtp', WERFT_MAIL_FROM: FROM }), /smtp driver works only with werft serve/);
  assert.throws(() => mailFromEnv({ WERFT_MAIL: 'x' }), /known: log, cloudflare, brevo, resend\)/);
  const drivers = { smtp: smtpFromEnv };
  assert.throws(() => mailFromEnv({ WERFT_MAIL: 'smtp', WERFT_MAIL_FROM: FROM }, { drivers }), /needs a host \(WERFT_MAIL_HOST\)/);
  assert.throws(() => mailFromEnv({ WERFT_MAIL: 'smtp', WERFT_MAIL_FROM: FROM, WERFT_MAIL_HOST: 'smtp.example.org', WERFT_MAIL_USER: 'u' }, { drivers }), /both a user and a password/);
  assert.throws(() => mailFromEnv({ WERFT_MAIL: 'smtp', WERFT_MAIL_FROM: FROM, WERFT_MAIL_HOST: 'smtp.example.org', WERFT_MAIL_PORT: 'abc' }, { drivers }), /WERFT_MAIL_PORT must be a port number/);
  assert.equal(mailFromEnv({ WERFT_MAIL: 'smtp', WERFT_MAIL_FROM: FROM, WERFT_MAIL_HOST: 'smtp.example.org' }, { drivers }).kind, 'smtp');
});

test('a Pages Function takes a provider driver, but not smtp', async () => {
  const hub = fakeGitHub();
  hub.seed({ 'content/pages/index.json': '{}' });
  const onRequest = pagesFunction({ site: { name: 'T' }, theme: {}, fetch: hub.fetch });
  const env = { WERFT_SECRET: 's'.repeat(32), GITHUB_TOKEN: 't', WERFT_REPO: `${hub.owner}/${hub.repo}`, WERFT_GITHUB_API: hub.api, ...ENV.cloudflare };
  const status = await onRequest({ request: new Request('https://x.pages.dev/api/werft/status'), env });
  assert.equal((await status.json()).mail, true);
  const refused = await pagesFunction({ site: { name: 'T' }, theme: {}, fetch: hub.fetch })({ request: new Request('https://x.pages.dev/api/werft/status'), env: { ...env, WERFT_MAIL: 'smtp' } });
  assert.equal(refused.status, 500);
  assert.match((await refused.json()).message, /smtp driver works only with werft serve/);
});

// SMTP needs a certificate the driver trusts: a throwaway one for 127.0.0.1 from openssl.
let dir = null;
let credentials = null;
const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
before(async () => {
  if (!hasOpenssl) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'werft-smtp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  credentials = { key: await fs.readFile(path.join(dir, 'key.pem')), cert: await fs.readFile(path.join(dir, 'cert.pem')) };
});
after(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });

const smtp = { skip: !hasOpenssl && 'needs openssl for a test certificate' };
const users = { mailer: 'smtp-secret' };
const driver = (server, options = {}) => smtpMail({ from: FROM, host: '127.0.0.1', port: server.port, user: 'mailer', password: 'smtp-secret', tls: { ca: credentials.cert }, timeout: 2000, ...options });

test('smtp: STARTTLS, then AUTH and the e-mail, only encrypted', smtp, async () => {
  const server = await fakeSmtp({ tls: credentials, users, auth: ['PLAIN'] });
  try {
    const sent = await driver(server).send({ ...message, subject: 'Neue Einsendung: Größenänderung für das Formular „Kontakt“ – bitte prüfen', fromName: 'Café Zur Werft' });
    const [session] = server.sessions;
    assert.deepEqual(session.commands.slice(0, 3), ['EHLO example.org', 'STARTTLS', 'EHLO example.org']);
    assert.deepEqual(session.encrypted.slice(0, 3), [false, false, true]);
    assert.ok(session.encrypted.slice(2).every(Boolean), 'everything after STARTTLS is encrypted');
    assert.equal(session.commands[3], `AUTH PLAIN ${Buffer.from('\0mailer\0smtp-secret').toString('base64')}`);
    assert.equal(session.mailFrom, `<${FROM}>`);
    assert.deepEqual(session.rcptTo, ['<owner@example.org>', '<team@example.org>']);
    const mail = parseMail(session.data);
    assert.equal(mail.subject, 'Neue Einsendung: Größenänderung für das Formular „Kontakt“ – bitte prüfen');
    assert.equal(mail.from, `Café Zur Werft <${FROM}>`);
    assert.equal(mail.headers.to, 'owner@example.org, team@example.org');
    assert.equal(mail.headers['reply-to'], 'ana@example.net');
    assert.equal(mail.headers['message-id'], `<${sent.id}>`);
    assert.match(sent.id, /@example\.org$/);
    assert.equal(mail.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(mail.text, 'Name: Ana\r\nNachricht: Hallo');
    assert.ok(session.data.split('\r\n').every((line) => line.length <= 78), 'no line longer than 78 characters');
  } finally { server.close(); }
});

test('smtp: TLS from the start, AUTH LOGIN, and no account at all', smtp, async () => {
  const server = await fakeSmtp({ tls: credentials, implicitTls: true, users, auth: ['LOGIN'] });
  try {
    await driver(server, { secure: true }).send(message);
    await driver(server, { secure: true, user: undefined, password: undefined }).send({ to: 'owner@example.org', subject: 'Ohne Konto', text: '.\n..\nText' });
    const [login, anonymous] = server.sessions;
    assert.deepEqual(login.commands.slice(0, 4), ['EHLO example.org', 'AUTH LOGIN', Buffer.from('mailer').toString('base64'), Buffer.from('smtp-secret').toString('base64')]);
    assert.ok(login.encrypted.every(Boolean));
    assert.ok(!anonymous.commands.some((c) => c.startsWith('AUTH')));
    assert.equal(parseMail(anonymous.data).text, '.\r\n..\r\nText');
  } finally { server.close(); }
});

test('smtp: refuses to send unencrypted or to a server it cannot verify', smtp, async () => {
  const plain = await fakeSmtp({ startTls: false, users });
  const untrusted = await fakeSmtp({ tls: credentials, users });
  try {
    await assert.rejects(driver(plain).send(message), /^Error: E-mail \(smtp 127\.0\.0\.1:\d+\): the server offers no STARTTLS/);
    await assert.rejects(driver(plain, { user: undefined, password: undefined }).send(message), /no STARTTLS/);
    assert.deepEqual(plain.sessions.map((s) => s.commands), [['EHLO example.org'], ['EHLO example.org']], 'no AUTH, no e-mail');
    await assert.rejects(driver(untrusted, { tls: {} }).send(message), /self-signed|certificate/i);
    assert.ok(!untrusted.sessions[0].commands.some((c) => /^(AUTH|MAIL)/.test(c)));
  } finally { plain.close(); untrusted.close(); }
});

test('smtp: rejects a refused password or recipient and a server that does not answer', smtp, async () => {
  const server = await fakeSmtp({ tls: credentials, users, rejectRcpt: ['team@example.org'] });
  const silent = await fakeSmtp({ tls: credentials, silent: true });
  const stalled = await fakeSmtp({ tls: credentials, stallStartTls: true });
  try {
    await assert.rejects(driver(server, { password: 'wrong-password' }).send(message), (error) => {
      assert.match(error.message, /AUTH: 535 5\.7\.8 Authentication failed/);
      assert.doesNotMatch(error.message, /wrong-password|AUTH PLAIN/);
      return true;
    });
    await assert.rejects(driver(server).send(message), /RCPT TO team@example\.org: 550 5\.1\.1/);
    assert.equal(server.sessions[1].data, null, 'no e-mail when a recipient was refused');
    await assert.rejects(driver(silent, { timeout: 200 }).send(message), /did not answer in time/);
    await assert.rejects(driver(stalled, { timeout: 200 }).send(message), /did not answer in time/, 'a stalled TLS handshake ends too');
    assert.deepEqual(stalled.sessions[0].commands, ['EHLO example.org', 'STARTTLS']);
  } finally { server.close(); silent.close(); stalled.close(); }
});

test('smtp: long headers are folded, and international domains go out in punycode', smtp, async () => {
  const server = await fakeSmtp({ tls: credentials, users });
  try {
    const to = [...Array.from({ length: 19 }, (_, i) => `recipient-with-a-rather-long-name-${i}@subdomain.example.org`), 'info@müller.de'];
    const subject = `Neue Einsendung: ${'lang '.repeat(30).trim()}`;
    await driver(server).send({ to, subject, text: 'T' });
    const [session] = server.sessions;
    assert.equal(session.rcptTo.at(-1), '<info@xn--mller-kva.de>');
    const mail = parseMail(session.data);
    assert.equal(mail.subject, subject);
    assert.equal(mail.headers.to, to.slice(0, -1).concat('info@xn--mller-kva.de').join(', '));
    assert.match(mail.headers.date, /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
    assert.ok(session.data.split('\r\n').every((line) => line.length <= 78), 'no line longer than 78 characters');
    await assert.rejects(driver(server).send({ to: 'jürgen@example.org', subject: 'S', text: 'T' }), /^Error: E-mail \(smtp\): "jürgen@example\.org" cannot be sent over SMTP/);
    assert.equal(server.sessions.length, 1, 'refused before connecting');
  } finally { server.close(); }
});
