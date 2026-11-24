// Feature cli-check: `werft check` passes on the fixture site, fails with exit 1 and names the place
// after a broken link is added, and passes again once it is removed. Leaves the site as it was.
//   node journeys/cli-check.mjs <run-dir>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { journey, expect } from './lib.mjs';

const j = await journey(process.argv[2], 'cli-check');
const cli = (...args) => {
  const r = spawnSync(process.execPath, [path.join(j.run.checkout, 'bin/werft.js'), ...args], { cwd: j.run.site, encoding: 'utf8' });
  return { command: `werft ${args.join(' ')}`, status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const menus = path.join(j.run.site, 'content/settings/menus.json');
const original = fs.readFileSync(menus, 'utf8');
try {
  await j.step('werft check passes on the site', async () => {
    const r = cli('check', '.');
    j.record('check-clean.json', r);
    expect(r.status === 0, `exit ${r.status}: ${r.stdout}${r.stderr}`);
  });
  await j.step('a menu link to a missing page fails the check', async () => {
    const data = JSON.parse(original);
    data.main.items.push({ label: 'Fehlt', url: 'fehlt.html' });
    fs.writeFileSync(menus, `${JSON.stringify(data)}\n`);
    const r = cli('check', '.');
    j.record('check-broken.json', r);
    const out = r.stdout + r.stderr;
    expect(r.status === 1 && out.includes('broken-link') && out.includes('fehlt.html') && out.includes('content/settings/menus.json'), `exit ${r.status}: ${out}`);
  });
  await j.step('the build output stayed as it was', async () => {
    const html = fs.readFileSync(path.join(j.run.site, '_site/index.html'), 'utf8');
    expect(!html.includes('fehlt.html'), 'werft check wrote into the output directory');
  });
} finally {
  fs.writeFileSync(menus, original);
  await j.step('restored, the check passes again', async () => {
    const r = cli('check', '.');
    j.record('check-restored.json', r);
    expect(r.status === 0, `exit ${r.status}`);
    expect(j.git('status', '--porcelain').trim() === '', `the site has uncommitted changes:\n${j.git('status', '--porcelain')}`);
  }).catch((e) => { process.exitCode = 1; console.error(e.message); });
  await j.done();
}
