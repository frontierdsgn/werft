// The Node build copies the theme's static files and the media directories into the output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildToDisk } from '../lib/node.js';

test('a broken link in the static files is skipped and named, the other files arrive', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-static-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write('werft.config.js', "export default { name: 'T', theme: './theme/index.js', mediaDirs: ['assets/img', 'assets/missing'], output: '_site', admin: false };\n");
  write('theme/index.js', "export default { blocks: {}, staticDir: 'theme/static', renderPage: (page, ctx) => ctx.html`<title>${page.title}</title>` };\n");
  write('content/pages/index.json', '{"title":"Start","status":"published"}\n');
  write('theme/static/a.css', 'a{}');
  write('theme/static/css/z.css', 'z{}');
  write('shared/fonts/f.woff2', 'font');
  write('assets/img/photo.txt', 'photo');
  fs.symlinkSync(path.join(root, 'nowhere.css'), path.join(root, 'theme/static/broken.css'));
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'theme/static/css/gone'));
  fs.symlinkSync(path.join(root, 'shared/fonts'), path.join(root, 'theme/static/fonts'));
  const warnings = [];
  const { outDir } = await buildToDisk(root, { log: (line) => warnings.push(line) });
  const files = fs.readdirSync(outDir, { recursive: true }).filter((f) => !fs.lstatSync(path.join(outDir, f)).isDirectory()).sort();
  assert.deepEqual(files.filter((f) => !f.startsWith('_werft/') && f !== 'robots.txt'), ['a.css', 'assets/img/photo.txt', 'css/z.css', 'fonts/f.woff2', 'index.html']);
  assert.equal(fs.lstatSync(path.join(outDir, 'fonts')).isSymbolicLink(), false, 'a link that works is copied as what it leads to');
  assert.deepEqual(warnings.sort(), [
    'werft: theme/static/broken.css is a broken link and was not copied',
    'werft: theme/static/css/gone is a broken link and was not copied',
  ]);
});
