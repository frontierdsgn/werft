// Shared harness for the journeys: a headless Chromium on a werft-verify run, and evidence written
// to the run's evidence directory (run.json `evidence`), which `werft-verify down` keeps.
//
//   const j = await journey(process.argv[2], 'edit-page');   // run dir, journey name
//   await j.signIn();                                        // as the fixture's administrator
//   await j.step('what the user does', async (page) => { … }); // screenshot + ARIA snapshot after it
//   await j.done();                                          // writes steps.json, closes the browser
//
// Needs `werft-verify browser <run-dir>` once (installs playwright-core into the run). Chromium:
// WERFT_VERIFY_CHROMIUM, else `chromium` or `google-chrome` on PATH, else Playwright's own.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const which = (name) => { try { return execFileSync('which', [name], { encoding: 'utf8' }).trim(); } catch { return null; } };

export async function journey(runDir, name) {
  if (!runDir) throw new Error('usage: node <journey>.mjs <run-dir>');
  const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const require = createRequire(path.join(runDir, 'pw', 'package.json'));
  let chromium;
  try { ({ chromium } = require('playwright-core')); } catch { throw new Error(`run: werft-verify browser ${runDir}`); }
  const executablePath = process.env.WERFT_VERIFY_CHROMIUM ?? which('chromium') ?? which('google-chrome') ?? undefined;
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'de-DE' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Failed loads are logged as responses with their address; console lines repeating them are not.
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  const failed = [];
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
  const dir = path.join(run.evidence, name);
  fs.mkdirSync(dir, { recursive: true });
  const steps = [];
  let n = 0;

  async function step(label, action) {
    const at = String(++n).padStart(2, '0');
    const entry = { step: at, label, url: null, ok: false };
    steps.push(entry);
    try {
      await action(page);
      entry.ok = true;
    } catch (error) {
      entry.error = String(error.message ?? error).split('\n')[0];
    } finally {
      entry.url = page.url();
      const base = path.join(dir, `${at}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50)}`);
      await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
      fs.writeFileSync(`${base}.aria.txt`, await page.locator('body').ariaSnapshot().catch((e) => `(no snapshot: ${e.message})`));
    }
    if (!entry.ok) throw new Error(`step ${at} "${label}" failed: ${entry.error}`);
  }

  // Signs in through the admin's own sign-in form.
  async function signIn(who = run.admin) {
    await step(`sign in as ${who.email}`, async () => {
      await page.goto(`${run.url}/admin/`);
      await page.getByLabel('E-Mail').fill(who.email);
      await page.getByLabel('Passwort', { exact: true }).fill(who.password);
      await page.getByRole('button', { name: 'Anmelden' }).click();
      await page.locator('#ve-app:not([hidden])').waitFor({ timeout: 15000 });
    });
  }

  async function done() {
    fs.writeFileSync(path.join(dir, 'steps.json'), `${JSON.stringify({ run: run.id, rev: run.rev, url: run.url, steps, browserErrors: errors, failedResponses: failed }, null, 2)}\n`);
    await browser.close();
    console.log(`evidence: ${dir}`);
  }

  // A request as the gateway's API sees it, with a session of the fixture's administrator.
  async function api(pathname, { method = 'GET', body, as = run.admin, headers = {} } = {}) {
    const session = await (await fetch(`${run.url}/api/werft/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(as) })).json();
    const response = await fetch(`${run.url}${pathname}`, { method, headers: { authorization: `token ${session.access_token}`, ...(body && { 'content-type': 'application/json' }), ...headers }, body: body && JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => null) };
  }

  // Writes a text artifact (command output, response bodies) next to the screenshots.
  const record = (file, text) => fs.writeFileSync(path.join(dir, file), typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`);
  // The site's git history, the record of every save.
  const git = (...args) => execFileSync('git', ['-C', run.site, ...args], { encoding: 'utf8' });

  return { run, page, step, signIn, done, api, record, git, dir, errors, failed };
}

export function expect(condition, message) { if (!condition) throw new Error(message); }
