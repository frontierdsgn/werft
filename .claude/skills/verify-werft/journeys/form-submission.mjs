// Feature form-submission: a visitor sends the form on /kontakt/ and lands on /danke/; the
// submission is a commit on the branch werft-submissions, not in the site's history; an editor
// reads it under "Einsendungen" and downloads it as CSV; a form without `receive` takes nothing.
//   node journeys/form-submission.mjs <run-dir>
import fs from 'node:fs';
import { journey, expect } from './lib.mjs';

const j = await journey(process.argv[2], 'form-submission');
const email = `besuch-${Date.now().toString(36)}@verify.test`;
const message = '=HYPERLINK("https://evil.example")';
const mainBefore = j.git('rev-parse', 'main').trim();
try {
  await j.step('a visitor opens the contact page', async (page) => {
    await page.goto(`${j.run.url}/kontakt/`);
    await page.getByRole('form', { name: 'Anfrage' }).waitFor();
  });
  await j.step('fills in the form and sends it', async (page) => {
    const form = page.getByRole('form', { name: 'Anfrage' });
    await form.getByLabel('E-Mail').fill(email);
    await form.getByLabel('Nachricht').fill(message);
    await form.getByRole('button', { name: 'Anfrage senden' }).click();
    await page.waitForURL(`${j.run.url}/danke/`);
    await page.getByRole('heading', { name: 'Danke', level: 1 }).waitFor();
  });
  await j.step('the submission is on werft-submissions, not on main', async () => {
    const files = j.git('ls-tree', '-r', '--name-only', 'werft-submissions').trim().split('\n').filter((f) => f.startsWith('.werft/submissions/anfrage/'));
    const mine = files.map((f) => JSON.parse(j.git('show', `werft-submissions:${f}`))).find((s) => s.fields.email === email);
    j.record('stored-submission.json', mine ?? { files });
    expect(mine?.fields.nachricht === message, `no stored submission from ${email}`);
    expect(j.git('rev-parse', 'main').trim() === mainBefore, 'the submission changed the site branch');
  });
  await j.step('a form without receive refuses submissions', async () => {
    const response = await fetch(`${j.run.url}/api/werft/forms/newsletter`, { method: 'POST', headers: { accept: 'application/json' }, body: new URLSearchParams({ email: 'bot@verify.test' }) });
    const body = await response.text();
    j.record('newsletter-response.txt', `${response.status}\n${body}\n`);
    expect(response.status === 404, `newsletter answered ${response.status}`);
  });
  await j.signIn(j.run.editor);
  await j.step('the editor opens Einsendungen', async (page) => {
    await page.getByRole('navigation').getByRole('button', { name: /^Einsendungen/ }).click();
    await page.getByText(email).first().waitFor({ timeout: 10000 });
  });
  await j.step('downloads the CSV', async (page) => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Einsendungen „Anfrage“ als CSV herunterladen' }).click()]);
    const file = `${j.dir}/anfrage.csv`;
    await download.saveAs(file);
    const csv = fs.readFileSync(file, 'utf8');
    expect(csv.includes(`"${email}"`), 'the CSV lacks the submission');
    expect(csv.includes(`"'=HYPERLINK(""https://evil.example"")"`), 'the formula is not neutralised in the CSV');
  });
  expect(j.errors.length === 0, `browser errors: ${j.errors.join(' | ')}`);
} finally {
  await j.done();
}
