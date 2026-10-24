// E-mail for form submissions: the form's recipients get each submission with the visitor as
// reply-to, the visitor gets at most one confirmation a day with the form's own text, and a failed
// e-mail never loses the submission.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { memoryMail } from '../gateway/mail.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { schema } from '../lib/schema.js';
import { fakeGitHub } from './fake-github.js';

const ORIGIN = 'https://site.test';
let gateway, mail, clock, hub;

beforeEach(async () => {
  hub = fakeGitHub();
  hub.seed({
    '.werft/users.json': serializeUsers([{ email: 'admin@example.org', name: 'Ada', role: 'administrator', password: await hashPassword('admin-password', 1000) }]),
    'content/forms/anfrage.json': JSON.stringify({ title: 'Anfrage', notify: { to: 'team@example.org, chef@example.org; kein-adresse', confirm: true, confirm_text: 'Danke, wir melden uns.' } }),
    'content/forms/newsletter.json': JSON.stringify({ title: 'Newsletter' }),
    'content/forms/termin.json': JSON.stringify({ title: 'Termin', notify: { to: 'team@example.org' } }),
    'content/forms/rueckruf.json': JSON.stringify({ title: 'Rückruf', notify: { confirm: true } }),
  });
  mail = memoryMail({ from: 'site@example.org' });
  clock = Date.parse('2026-06-01T10:00:00Z');
  gateway = createGateway({
    storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch: hub.fetch }),
    secret: 'x'.repeat(32), site: { name: 'Salon', contentDir: 'content' }, mail, now: () => clock,
  });
});

const send = (form, fields) => gateway(new Request(`${ORIGIN}/api/werft/forms/${form}`, { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams(fields) }));
async function stored(body) {
  const session = await (await gateway(new Request(`${ORIGIN}/api/werft/session`, { method: 'POST', body: JSON.stringify({ email: 'admin@example.org', password: 'admin-password' }) }))).json();
  const { forms } = await (await gateway(new Request(`${ORIGIN}/api/werft/submissions`, { headers: { authorization: `token ${session.access_token}` }, ...(body && { method: 'POST', body: JSON.stringify(body) }) }))).json();
  return forms.flatMap((f) => f.submissions.map((s) => ({ ...s.fields, id: s.id })));
}

test('sends each submission to the form\'s recipients, replies going to the visitor', async () => {
  assert.equal((await send('anfrage', [['name', 'Vera'], ['e-mail', 'vera@example.org'], ['termin', 'Montag'], ['termin', 'Dienstag'], ['nachricht', 'Zeile 1\nZeile 2']])).status, 201);
  const [notice] = mail.sent.filter((m) => m.to.includes('team@example.org'));
  assert.deepEqual(notice.to, ['team@example.org', 'chef@example.org'], 'what is no address is left out');
  assert.equal(notice.replyTo, 'vera@example.org');
  assert.equal(notice.subject, 'Neue Einsendung: Anfrage');
  assert.deepEqual(notice.from, { email: 'site@example.org', name: 'Salon' });
  assert.match(notice.text, /^name: Vera\ne-mail: vera@example\.org\ntermin: Montag, Dienstag\nnachricht: Zeile 1\n {2}Zeile 2$/m);
  await send('newsletter', [['email', 'n@example.org']]);
  assert.deepEqual(mail.sent.filter((m) => m.subject.includes('Newsletter') || m.to.includes('n@example.org')), [], 'a form without recipients or confirmation sends nothing');
  assert.equal((await send('termin', [['email', 't@example.org']])).status, 201);
  assert.deepEqual(mail.sent.filter((m) => m.to.includes('t@example.org')), [], 'no confirmation unless the form asks for it');
  assert.equal(mail.sent.at(-1).subject, 'Neue Einsendung: Termin');
  await send('anfrage', [['name', 'Otto'], ['kontakt', 'otto@example.org']]);
  assert.equal(mail.sent.find((m) => m.text.includes('name: Otto')).replyTo, 'otto@example.org', 'else the first field holding an address');
});

test('confirms to the visitor with the form\'s text only, once a day per address', async () => {
  await send('anfrage', [['email', 'vera@example.org'], ['nachricht', 'Kaufen Sie jetzt!']]);
  const confirmations = () => mail.sent.filter((m) => m.to[0] === 'vera@example.org');
  assert.equal(confirmations().length, 1);
  assert.deepEqual(confirmations()[0], { from: { email: 'site@example.org', name: 'Salon' }, to: ['vera@example.org'], subject: 'Ihre Nachricht an Salon', text: 'Danke, wir melden uns.\n' }, 'nothing the visitor wrote');
  clock += 3600 * 1000;
  await send('anfrage', [['email', 'VERA@example.org'], ['nachricht', 'noch einmal']]);
  assert.equal(confirmations().length + mail.sent.filter((m) => m.to[0] === 'VERA@example.org').length, 1, 'not again within a day, whatever the case');
  assert.equal(mail.sent.filter((m) => m.subject === 'Neue Einsendung: Anfrage').length, 2, 'the team still hears of it');
  await send('rueckruf', [['email', 'vera@example.org']]);
  assert.equal(confirmations().length, 1, 'nor from another form of the site');
  await send('anfrage', [['email', 'otto@example.org']]);
  assert.equal(mail.sent.filter((m) => m.to[0] === 'otto@example.org').length, 1, 'another address is confirmed');
  clock += 24 * 3600 * 1000;
  await send('anfrage', [['email', 'vera@example.org']]);
  assert.equal(confirmations().length, 2, 'again the next day');
  const all = await stored();
  assert.equal(all.length, 5, 'every submission is kept');
  assert.deepEqual((await stored({ delete: all.map((s) => s.id) })), [], 'confirmed ones can be deleted like the others');
});

test('a failed e-mail keeps the submission', async () => {
  mail.failure = new Error('provider down');
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal((await send('anfrage', [['email', 'vera@example.org']])).status, 201);
  } finally { console.error = original; }
  assert.deepEqual((await stored()).map((s) => s.email), ['vera@example.org']);
  assert.match(errors.join('\n'), /e-mail not sent: provider down/);
});

test('without an e-mail driver, submissions are kept as before', async () => {
  gateway = createGateway({ storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch: hub.fetch }), secret: 'x'.repeat(32), site: { contentDir: 'content' } });
  assert.equal((await send('anfrage', [['email', 'vera@example.org']])).status, 201);
  assert.equal(mail.sent.length, 0);
});

test('the editor offers the e-mail settings with every form', () => {
  const forms = schema({ site: { name: 'S' }, theme: { blocks: {}, formFields: [{ name: 'title', label: 'Titel', widget: 'string' }] } }).collections.find((c) => c.name === 'forms');
  assert.deepEqual(forms.fields.map((f) => f.name), ['title', 'thanks', 'notify']);
  assert.deepEqual(forms.fields[2].fields.map((f) => f.name), ['to', 'confirm', 'confirm_subject', 'confirm_text']);
  const translated = schema({ site: { name: 'S', languages: ['de', 'en'] }, theme: { blocks: {}, formFields: [{ name: 'title', label: 'Titel', widget: 'string' }] }, lang: 'en' }).collections.find((c) => c.name === 'forms');
  assert.deepEqual(translated.fields.map((f) => f.name), ['title', 'thanks', 'notify']);
  assert.deepEqual(translated.fields[2].fields.map((f) => f.name), ['confirm_subject', 'confirm_text'], 'who gets e-mail is set in the default language');
});
