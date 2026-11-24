// Feature edit-page: an administrator changes a page's title and a section's heading in the admin,
// saves, and the change is a commit in the site's git and on the rebuilt public page.
//   node journeys/edit-page.mjs <run-dir>
import { journey, expect } from './lib.mjs';

const j = await journey(process.argv[2], 'edit-page');
const stamp = Date.now().toString(36);
const title = `Start ${stamp}`;
const heading = `Willkommen ${stamp}`;
const commitsBefore = Number(j.git('rev-list', '--count', 'HEAD').trim());
try {
  await j.signIn();
  await j.step('open the page Start', async (page) => {
    await page.getByRole('navigation').getByRole('button', { name: /^Start/ }).click();
    await page.getByRole('heading', { name: 'Start', level: 1 }).waitFor();
  });
  await j.step('change the title', async (page) => {
    await page.getByRole('textbox', { name: 'Titel', exact: true }).fill(title);
    await page.getByRole('button', { name: 'Speichern (Strg+S)' }).waitFor({ state: 'visible' });
    expect(await page.getByRole('button', { name: 'Speichern (Strg+S)' }).isEnabled(), 'Speichern stays disabled after an edit');
  });
  await j.step('open the text section and change its heading', async (page) => {
    // The section's summary: its type ("Text") and its heading; it opens on a click.
    await page.getByRole('group', { name: 'Abschnitte' }).getByText('Text', { exact: true }).first().click();
    await page.getByRole('textbox', { name: 'Überschrift' }).fill(heading);
  });
  await j.step('the preview shows the unsaved heading', async (page) => {
    await page.frameLocator('#ve-frame').getByRole('heading', { name: heading }).waitFor({ timeout: 10000 });
  });
  await j.step('save', async (page) => {
    await page.getByRole('button', { name: 'Speichern (Strg+S)' }).click();
    await page.getByRole('status').filter({ hasText: 'Gespeichert' }).waitFor({ timeout: 15000 });
    await page.getByText('Alles gespeichert').waitFor({ timeout: 15000 });
  });
  await j.step('the save is one commit in the site\'s git', async () => {
    const log = j.git('log', '-3', '--format=%h %an <%ae> %s', '--stat');
    j.record('git-log.txt', log);
    expect(Number(j.git('rev-list', '--count', 'HEAD').trim()) === commitsBefore + 1, `expected one new commit:\n${log}`);
    const file = JSON.parse(j.git('show', 'HEAD:content/pages/index.json'));
    expect(file.title === title && file.sections[0].heading === heading, `content/pages/index.json holds ${JSON.stringify(file)}`);
  });
  await j.step('the public page shows the change after the rebuild', async (page) => {
    const deadline = Date.now() + 20000;
    let html = '';
    while (Date.now() < deadline && !html.includes(heading)) { html = await (await fetch(`${j.run.url}/`)).text(); await new Promise((r) => setTimeout(r, 300)); }
    j.record('public-index.html', html);
    expect(html.includes(`<h1>${title}</h1>`) && html.includes(heading), 'the rebuilt page lacks the new title or heading');
    await page.goto(`${j.run.url}/`);
    await page.getByRole('heading', { name: title, level: 1 }).waitFor();
  });
  expect(j.errors.length === 0, `browser errors: ${j.errors.join(' | ')}`);
} finally {
  await j.done();
}
