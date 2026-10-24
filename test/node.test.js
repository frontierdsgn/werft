// The Node server (`werft dev` / `werft serve`) on a minimal site in a throwaway git checkout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../adapters/node.js';

let server, base, root;
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-node-'));
  write('werft.config.js', "export default { name: 'T', theme: './theme/index.js', output: '_site' };\n");
  write('theme/index.js', 'export default { blocks: {}, renderPage: (page, ctx) => ctx.html`<title>${page.title}</title>` };\n');
  write('content/pages/index.json', '{"title":"Start","status":"published"}\n');
  write('_site-secret/secret.txt', 'secret');
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@test', 'commit', '--quiet', '--allow-empty', '-m', 'init'], { cwd: root });
  ({ server } = await serve({ dir: root, port: 0, secret: 'x'.repeat(32), log: () => {} }));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

test('sends e-mail only through a driver: werft dev passes log, werft serve none', async () => {
  const status = async (url) => (await (await fetch(`${url}/api/werft/status`)).json()).mail;
  assert.equal(await status(base), !!process.env.WERFT_MAIL, 'werft serve: only what WERFT_MAIL names');
  const dev = await serve({ dir: root, port: 0, secret: 'x'.repeat(32), mail: 'log', log: () => {} });
  try { assert.equal(await status(`http://127.0.0.1:${dev.server.address().port}`), true); } finally { dev.close(); }
});

test('serves the site and nothing beside its output directory', async () => {
  assert.equal(await (await fetch(`${base}/`)).text(), '<title>Start</title>');
  const sibling = await fetch(`${base}/%2e%2e%2f_site-secret/secret.txt`);
  assert.equal(sibling.status, 404);
  fs.symlinkSync(path.join(root, '_site-secret'), path.join(root, '_site/linked'));
  assert.equal((await fetch(`${base}/linked/secret.txt`)).status, 404, 'no way out through a symbolic link');
});
