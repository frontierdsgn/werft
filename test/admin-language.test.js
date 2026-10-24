// The admin's language on the gateway's side (gateway/messages.js): messages in the language the
// admin asks for (Accept-Language), each user's own choice in "Mein Konto", and e-mail to editors
// in their language. German stays the default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { memoryMail } from '../gateway/mail.js';
import { hashPassword, serializeUsers } from '../gateway/auth.js';
import { localeOf, messages } from '../gateway/messages.js';
import { fakeGitHub } from './fake-github.js';

const ORIGIN = 'https://site.test';

async function setup() {
  const hub = fakeGitHub();
  hub.seed({
    '.werft/users.json': serializeUsers([
      { email: 'ada@example.org', name: 'Ada', role: 'administrator', password: await hashPassword('admin-password', 1000) },
      { email: 'cy@example.org', name: 'Cy', role: 'contributor', locale: 'en', password: await hashPassword('contrib-password', 1000) },
    ]),
    'content/pages/index.json': '{"title":"Start","status":"published"}\n',
    'content/events/a.json': '{"title":"A","status":"draft"}\n',
    'content/forms/anfrage.json': JSON.stringify({ title: 'Anfrage', notify: { to: 'cy@example.org' } }),
    'content/forms/termin.json': JSON.stringify({ title: 'Termin', notify: { to: 'team@example.org' } }),
  });
  const mail = memoryMail({ from: 'site@example.org' });
  const tasks = [];
  const gateway = createGateway({
    storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch: hub.fetch }),
    secret: 'x'.repeat(32), iterations: 1000, mail, now: () => Date.parse('2026-06-01T10:00:00Z'),
    site: { name: 'Salon', contentDir: 'content', postType: 'events' },
  });
  const call = async (p, { token, body, language } = {}) => {
    const method = body === undefined ? 'GET' : 'POST';
    const response = await gateway(new Request(`${ORIGIN}/api/werft${p}`, {
      method, headers: { ...(token && { authorization: `token ${token}` }), ...(language && { 'accept-language': language }), ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { origin: ORIGIN, waitUntil: (p) => tasks.push(p) });
    return { status: response.status, data: await response.json() };
  };
  const signIn = async (email, password) => (await call('/session', { body: { email, password } })).data.access_token;
  return { call, signIn, mail, tasks, hub, gateway };
}

test('picks the most preferred language the gateway has, else German', () => {
  assert.equal(localeOf('en-GB,en;q=0.9,de;q=0.8'), 'en');
  assert.equal(localeOf('fr-FR, de;q=0.5, en;q=0.7'), 'en', 'by preference, not by order');
  assert.equal(localeOf('fr, it'), 'de');
  assert.equal(localeOf('en;q=0'), 'de', 'q=0 means not wanted');
  assert.equal(localeOf(undefined), 'de');
  assert.equal(localeOf('en'), 'en');
  assert.equal(messages('en')('tooMany.signIns', { minutes: 1 }), 'Too many sign-in attempts. Please try again in 1 minute.');
  assert.equal(messages('de')('tooMany.signIns', { minutes: 3 }), 'Zu viele Anmeldeversuche. Bitte in 3 Minuten noch einmal versuchen.');
});

test('answers in the language the admin asks for', async () => {
  const { call, signIn } = await setup();
  const wrong = { email: 'ada@example.org', password: 'nope' };
  assert.equal((await call('/session', { body: wrong })).data.message, 'E-Mail oder Passwort stimmt nicht.');
  assert.equal((await call('/session', { body: wrong, language: 'en-US,en;q=0.9' })).data.message, 'The email or the password is wrong.');
  assert.equal((await call('/me', { language: 'en' })).data.message, 'Please sign in.');
  const again = await call('/session', { body: { ticket: 'not-a-ticket', code: '123456' }, language: 'en' });
  assert.deepEqual([again.status, again.data.code], [401, 'signin_again'], 'the admin finds the way back by the code, in any language');
  // A refusal for the role, in English.
  const token = await signIn('cy@example.org', 'contrib-password');
  const save = await call('/api/v1/repos/werft/site/contents', { token, language: 'en', body: { files: [{ operation: 'update', path: 'content/pages/index.json', content: Buffer.from('{}').toString('base64') }] } });
  assert.deepEqual([save.status, save.data.message], [403, 'Contributors may only change their own posts.']);
  const de = await call('/api/v1/repos/werft/site/contents', { token, body: { files: [{ operation: 'update', path: 'content/pages/index.json', content: Buffer.from('{}').toString('base64') }] } });
  assert.equal(de.data.message, 'Mitarbeiter dürfen nur eigene Beiträge ändern.');
});

test('each user chooses the admin\'s language in "Mein Konto"; none means the browser\'s', async () => {
  const { call, signIn, hub } = await setup();
  const token = await signIn('ada@example.org', 'admin-password');
  assert.equal((await call('/me', { token })).data.locale, null);
  assert.equal((await call('/me', { token, body: { locale: 'en' } })).data.locale, 'en');
  assert.equal((await call('/me', { token })).data.locale, 'en', 'kept with the user, the session goes on');
  assert.equal(JSON.parse(hub.fileAt('main', '.werft/users.json')).users[0].locale, 'en');
  for (const locale of ['fr', 'EN', 7, '']) {
    const refused = await call('/me', { token, body: { locale }, language: 'en' });
    assert.deepEqual([refused.status, refused.data.message], [422, 'The editor is not available in this language.'], JSON.stringify(locale));
  }
  assert.equal((await call('/me', { token, body: { locale: null } })).data.locale, null);
  assert.equal('locale' in JSON.parse(hub.fileAt('main', '.werft/users.json')).users[0], false, 'null removes the choice');
  assert.equal((await call('/me', { token, body: { name: 'Ada', role: 'contributor' } })).status, 403, 'still only name, language and password');
  const listed = (await call('/users', { token })).data.users.find((u) => u.email === 'cy@example.org');
  assert.equal(listed.locale, 'en');
});

test('e-mail to editors is in their language', async () => {
  const { call, mail, tasks, gateway } = await setup();
  // A new password: in the user's language, whatever the request asked for.
  await call('/password/forgot', { body: { email: 'cy@example.org' } });
  await call('/password/forgot', { body: { email: 'ada@example.org' }, language: 'en' });
  await Promise.all(tasks);
  assert.match(mail.sent.find((m) => m.to.includes('cy@example.org')).subject, /^New password for Salon$/);
  assert.match(mail.sent.find((m) => m.to.includes('cy@example.org')).text, /^Hello Cy,\n\nsomeone, hopefully you, wants to set a new password for Salon\./);
  assert.equal(mail.sent.find((m) => m.to.includes('ada@example.org')).subject, 'New password for Salon', 'without a choice: the language asked for');
  // A form's notice: in the recipient's language when the recipient is a user, else German.
  const send = (form) => gateway(new Request(`${ORIGIN}/api/werft/forms/${form}`, { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams([['name', 'Vera']]) }));
  assert.equal((await send('anfrage')).status, 201);
  assert.equal((await send('termin')).status, 201);
  const [anfrage, termin] = [mail.sent.find((m) => m.subject.includes('Anfrage')), mail.sent.find((m) => m.subject.includes('Termin'))];
  assert.equal(anfrage.subject, 'New submission: Anfrage');
  assert.match(anfrage.text, /^A new submission came in through the form “Anfrage”:\n\nname: Vera\n\nAll submissions are in the editor under “Submissions”\.\n$/);
  assert.equal(termin.subject, 'Neue Einsendung: Termin');
});
