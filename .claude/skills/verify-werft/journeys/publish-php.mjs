// Feature publish-php: `werft publish` sends the built site to adapters/php/werft-publish.php under
// `php -S` (a stand-in for PHP web space), writes only changed files the second time, leaves a file
// it did not publish alone, and the receiver refuses code. Exits 3 without PHP (unreachable, not passed).
//   node journeys/publish-php.mjs <run-dir>
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { journey, expect } from './lib.mjs';

const php = process.env.WERFT_VERIFY_PHP ?? 'php';
try { execFileSync(php, ['--version']); } catch {
  console.error(`unreachable: ${php} not found (set WERFT_VERIFY_PHP or install php-cli); publish-php not verified`);
  process.exit(3);
}
const j = await journey(process.argv[2], 'publish-php');
const web = path.join(path.dirname(j.run.site), 'web');
const secret = 'v'.repeat(40);
const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const url = `http://127.0.0.1:${port}/werft-publish.php`;
fs.mkdirSync(web, { recursive: true });
fs.writeFileSync(path.join(web, 'werft-publish.php'), fs.readFileSync(path.join(j.run.checkout, 'adapters/php/werft-publish.php'), 'utf8').replace('replace-with-the-output-of-werft-secret', secret));
fs.writeFileSync(path.join(web, 'foreign.html'), 'not from werft');
const server = spawn(php, ['-S', `127.0.0.1:${port}`, '-t', web], { stdio: 'ignore' });
const publish = () => {
  const r = spawnSync(process.execPath, [path.join(j.run.checkout, 'bin/werft.js'), 'publish', '.'], { cwd: j.run.site, encoding: 'utf8', env: { ...process.env, WERFT_PUBLISH_URL: url, WERFT_PUBLISH_SECRET: secret } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
try {
  for (let i = 0; i < 50; i++) { try { await fetch(url); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  await j.step('the first publish sends the whole site, without the admin', async () => {
    const r = publish();
    j.record('publish-1.json', r);
    expect(r.status === 0, `exit ${r.status}: ${r.stderr}`);
    expect(fs.readFileSync(path.join(web, 'kontakt/index.html'), 'utf8') === fs.readFileSync(path.join(j.run.site, '_site/kontakt/index.html'), 'utf8'), 'kontakt/index.html differs');
    expect(!fs.existsSync(path.join(web, 'admin')), 'the admin was published');
    const htaccess = fs.readFileSync(path.join(web, '.htaccess'), 'utf8');
    j.record('htaccess.txt', htaccess);
    expect(htaccess.includes('ErrorDocument 404 /404.html') && /Redirect 301 \/alt\.html /.test(htaccess), `.htaccess: ${htaccess}`);
  });
  await j.step('a second publish changes nothing', async () => {
    const r = publish();
    j.record('publish-2.json', r);
    expect(r.status === 0 && /Published 0 changed and removed 0/.test(r.stdout), r.stdout + r.stderr);
  });
  await j.step('a file werft did not publish stays', async () => {
    expect(fs.readFileSync(path.join(web, 'foreign.html'), 'utf8') === 'not from werft', 'foreign.html changed');
  });
  await j.step('the receiver refuses code, even with the secret', async () => {
    const body = JSON.stringify({ action: 'put', files: [{ path: 'x.php', content: Buffer.from('<?php echo 1;').toString('base64') }] });
    const t = String(Math.floor(Date.now() / 1000));
    const response = await fetch(url, { method: 'POST', headers: { 'x-werft-signature': `t=${t},s=${createHmac('sha256', secret).update(`${t}\n${body}`).digest('hex')}` }, body });
    j.record('refused-php.txt', `${response.status} ${await response.text()}\n`);
    expect(response.status === 422 && !fs.existsSync(path.join(web, 'x.php')), `status ${response.status}`);
  });
} finally {
  server.kill();
  await j.done();
}
