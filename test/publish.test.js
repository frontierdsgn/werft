// Publishing to PHP web space: werft publish against werft-publish.php under `php -S`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { publish } from '../lib/publish.js';

const hasPhp = (() => { try { execFileSync('php', ['--version']); return true; } catch { return false; } })();
const SECRET = 'p'.repeat(40);
const PORT = 18000 + Math.floor(Math.random() * 1000);
const URL_ = `http://127.0.0.1:${PORT}/werft-publish.php`;
let server, web, out;

const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const read = (rel) => (fs.existsSync(path.join(web, rel)) ? fs.readFileSync(path.join(web, rel), 'utf8') : null);
const signed = (body, secret = SECRET) => { const t = String(Math.floor(Date.now() / 1000)); return fetch(URL_, { method: 'POST', headers: { 'x-werft-signature': `t=${t},s=${createHmac('sha256', secret).update(`${t}\n${body}`).digest('hex')}` }, body }); };

before(async () => {
  if (!hasPhp) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-pub-'));
  web = path.join(root, 'web');
  out = path.join(root, '_site');
  const receiver = fs.readFileSync(new URL('../adapters/php/werft-publish.php', import.meta.url), 'utf8').replace('replace-with-the-output-of-werft-secret', SECRET);
  write(web, 'werft-publish.php', receiver);
  write(web, 'foreign.html', 'not published by werft');
  server = spawn('php', ['-S', `127.0.0.1:${PORT}`, '-t', web], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(URL_); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => server?.kill());

test('publishes changes and deletions, leaving other files alone', { skip: !hasPhp && 'php not installed' }, async () => {
  write(out, 'index.html', 'one');
  write(out, 'sub/page.html', 'page');
  write(out, 'sub/old.html', 'old');
  write(out, 'admin/index.html', 'admin');
  write(out, '.htaccess', 'Redirect 301 /alt /neu\n');
  let result = await publish({ outDir: out, url: URL_, secret: SECRET, exclude: ['admin'] });
  assert.equal(result.changed.length, 4);
  assert.deepEqual([read('index.html'), read('sub/old.html'), read('.htaccess'), read('admin/index.html')], ['one', 'old', 'Redirect 301 /alt /neu\n', null]);
  write(out, 'index.html', 'two');
  fs.rmSync(path.join(out, 'sub/old.html'));
  result = await publish({ outDir: out, url: URL_, secret: SECRET, exclude: ['admin'] });
  assert.deepEqual([result.changed, result.removed], [['index.html'], ['sub/old.html']]);
  assert.deepEqual([read('index.html'), read('sub/old.html'), read('sub/page.html'), read('foreign.html')], ['two', null, 'page', 'not published by werft']);
});

test('refuses bad signatures, paths outside the web space and code', { skip: !hasPhp && 'php not installed' }, async () => {
  assert.equal((await signed(JSON.stringify({ action: 'manifest' }), 'q'.repeat(40))).status, 401);
  const put = (p, text) => signed(JSON.stringify({ action: 'put', files: [{ path: p, content: Buffer.from(text).toString('base64') }] }));
  for (const p of ['../escape.html', '/abs.html', 'a/../../x.html', 'shell.php', 'x.phtml', 'werft-publish.php', '.user.ini']) assert.equal((await put(p, 'x')).status, 422, p);
  assert.equal((await put('.htaccess', 'AddHandler application/x-httpd-php .html\n')).status, 422);
  for (const line of ['ErrorDocument 404 https://elsewhere.example/', 'ErrorDocument 404 /x.php', 'ErrorDocument 500 /500.html', 'ErrorDocument 404 "/a.html" SetHandler', 'ErrorDocument 404 /a.php?.html', 'ErrorDocument 404 /info.php?%{file:/etc/passwd}.html', 'ErrorDocument 404 /%{.html', 'ErrorDocument 404 /fehler.html']) assert.equal((await put('.htaccess', `${line}\n`)).status, 422, line);
  assert.equal((await put('en/.htaccess', 'ErrorDocument 404 /en/404.html\n')).status, 200, 'a local not-found page is allowed');
  assert.equal(fs.existsSync(path.join(path.dirname(web), 'escape.html')), false);
  const deleteForeign = await signed(JSON.stringify({ action: 'delete', paths: ['foreign.html'] }));
  assert.equal((await deleteForeign.json()).deleted, 0);
  assert.equal(read('foreign.html'), 'not published by werft');
  assert.equal((await put('foreign.html', 'replaced')).status, 409, 'files werft did not publish stay');
  assert.equal(read('foreign.html'), 'not published by werft');
  assert.equal((await put('foreign.html', 'not published by werft')).status, 200, 'unless they are the same');
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-elsewhere-'));
  fs.symlinkSync(elsewhere, path.join(web, 'linked'));
  assert.equal((await put('linked/x.html', 'x')).status, 422, 'no writes through symbolic links');
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
