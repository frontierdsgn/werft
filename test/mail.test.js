// The gateway's e-mail interface: every driver gets a checked message, the memory driver stands in
// for a provider in tests, and the environment picks the driver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryMail, logMail, mailFromEnv, mailer } from '../gateway/mail.js';
import { createGateway } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { pagesFunction } from '../adapters/cloudflare.js';
import { fakeGitHub } from './fake-github.js';

test('hands the driver a checked message', async () => {
  const mail = memoryMail({ from: 'site@example.org' });
  assert.deepEqual(await mail.send({ to: 'a@example.org', subject: ' Neue Einsendung ', text: 'Zeile 1\r\nZeile 2', replyTo: 'v@example.org', fromName: 'Die "Werft"' }), { id: 'memory-1' });
  await mail.send({ to: ['a@example.org', ' b@example.org', 'a@example.org'], subject: '', text: 'x' });
  assert.deepEqual(mail.sent, [
    { from: { email: 'site@example.org', name: 'Die Werft' }, to: ['a@example.org'], replyTo: 'v@example.org', subject: 'Neue Einsendung', text: 'Zeile 1\nZeile 2' },
    { from: { email: 'site@example.org' }, to: ['a@example.org', 'b@example.org'], subject: '(ohne Betreff)', text: 'x' },
  ]);
});

test('refuses a message that could add headers or reaches no one', async () => {
  const mail = memoryMail();
  const refused = async (message, pattern) => assert.rejects(mail.send({ to: 'a@example.org', subject: 'S', text: 'T', ...message }), pattern);
  await refused({ subject: 'Hallo\r\nBcc: x@example.org' }, /one line/);
  await refused({ fromName: 'A\nBcc: x@example.org' }, /one line/);
  await refused({ to: 'a@example.org\r\nBcc: x@example.org' }, /not an e-mail address/);
  await refused({ to: 'Name <a@example.org>' }, /not an e-mail address/);
  await refused({ replyTo: 'v@example.org\nBcc: x@example.org' }, /reply-to/);
  await refused({ to: [] }, /no recipient/);
  await refused({ to: Array.from({ length: 21 }, (_, i) => `a${i}@example.org`) }, /at most 20/);
  await refused({ text: ' ' }, /no text/);
  assert.equal(mail.sent.length, 0);
  assert.throws(() => mailer({ kind: 'x', from: 'not an address', deliver: () => {} }), /WERFT_MAIL_FROM/);
});

test('the memory driver fails while told to, like a provider that is down', async () => {
  const mail = memoryMail();
  mail.failure = new Error('provider down');
  await assert.rejects(mail.send({ to: 'a@example.org', subject: 'S', text: 'T' }), /provider down/);
  mail.failure = null;
  await mail.send({ to: 'a@example.org', subject: 'S', text: 'T' });
  assert.equal(mail.sent.length, 1);
});

test('the environment picks the driver; the log driver prints', async () => {
  assert.equal(mailFromEnv({}), null, 'no e-mail without WERFT_MAIL');
  const lines = [];
  const dev = mailFromEnv({}, { fallback: 'log', log: (l) => lines.push(l) });
  assert.equal(dev.kind, 'log');
  await dev.send({ to: 'a@example.org', subject: 'Betreff', text: 'Text', replyTo: 'v@example.org' });
  assert.deepEqual(lines, ['E-Mail an a@example.org (Antwort an v@example.org): Betreff\nText']);
  assert.equal(mailFromEnv({ WERFT_MAIL: 'log', WERFT_MAIL_FROM: 'site@example.org' }).from, 'site@example.org');
  assert.throws(() => mailFromEnv({ WERFT_MAIL: 'carrier-pigeon' }), /unknown mail driver/);
  assert.equal(logMail().kind, 'log');
});

test('the gateway tells the admin whether it can send e-mail', async () => {
  const hub = fakeGitHub();
  hub.seed({ 'content/pages/index.json': '{}' });
  const storage = githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch: hub.fetch });
  const status = async (options) => (await (await createGateway({ storage, secret: 'x'.repeat(32), site: { contentDir: 'content' }, ...options })(new Request('https://site.test/api/werft/status'))).json()).mail;
  assert.equal(await status({}), false);
  assert.equal(await status({ mail: memoryMail() }), true);
  const onRequest = pagesFunction({ site: { name: 'T' }, theme: {}, fetch: hub.fetch });
  const env = { WERFT_SECRET: 's'.repeat(32), GITHUB_TOKEN: 't', WERFT_REPO: `${hub.owner}/${hub.repo}`, WERFT_GITHUB_API: hub.api, WERFT_MAIL: 'log' };
  assert.equal((await (await onRequest({ request: new Request('https://x.pages.dev/api/werft/status'), env })).json()).mail, true, 'Cloudflare reads WERFT_MAIL');
});
