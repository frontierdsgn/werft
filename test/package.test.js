// What a site gets when it installs werft (npm packs the git dependency), and a secret scan of the
// repository. Both are part of `npm test`, the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the installed package loads, builds a site with its admin, and holds every file it imports', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-pack-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const [{ filename, files }] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tmp], { cwd: root, encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', path.join(tmp, filename), '-C', tmp]);
  const installed = path.join(tmp, 'package');
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(installed, 'node_modules'));
  const packed = new Set(files.map((f) => f.path));
  assert.ok(![...packed].some((f) => f.startsWith('test/') || f.startsWith('scripts/')), 'tests and maintainer scripts stay out of the package');

  // Node resolves every static import of the entry points from the unpacked package.
  for (const entry of Object.values(pkg.exports)) await import(pathToFileURL(path.join(installed, entry)).href);

  // The installed CLI builds a site, copying the admin from the package.
  const site = path.join(tmp, 'site');
  fs.mkdirSync(path.join(site, 'theme'), { recursive: true });
  fs.mkdirSync(path.join(site, 'content/pages'), { recursive: true });
  fs.writeFileSync(path.join(site, 'werft.config.js'), "export default { name: 'T', theme: './theme/index.js', output: '_site' };\n");
  fs.writeFileSync(path.join(site, 'theme/index.js'), 'export default { blocks: {}, renderPage: (page, ctx) => ctx.html`<title>${page.title}</title>` };\n');
  fs.writeFileSync(path.join(site, 'content/pages/index.json'), '{"title":"Start","status":"published"}\n');
  execFileSync(process.execPath, [path.join(installed, pkg.bin.werft), 'build', site], { encoding: 'utf8' });
  for (const file of ['index.html', 'admin/index.html', 'admin/editor.js', 'admin/werft/index.js', 'admin/vendor/marked.esm.js']) {
    assert.ok(fs.existsSync(path.join(site, '_site', file)), `the build has no ${file}`);
  }

  // Imports Node does not follow above: dynamic ones and the admin's browser modules. Line
  // comments may sit between the tokens.
  const gap = String.raw`(?:\s|//[^\n]*)*`;
  const importPattern = new RegExp(String.raw`\b(?:from|import)${gap}\(?${gap}(['"])(\.{1,2}/[^'"]+)\1`, 'g');
  const missing = [];
  for (const file of packed) {
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [, , spec] of source.matchAll(importPattern)) {
      if (!packed.has(path.posix.join(path.posix.dirname(file), spec))) missing.push(`${file} imports ${spec}`);
    }
  }
  assert.deepEqual(missing, []);
});

// Patterns are built from parts so this file does not match itself.
const dash = '-'.repeat(5);
const secretPatterns = {
  'private key': new RegExp(`${dash}BEGIN [A-Z ]*PRIVATE KEY${dash}`),
  'GitHub token': new RegExp(`\\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})`),
  'AWS access key': new RegExp(`\\b(?:AK|AS)IA[0-9A-Z]{16}\\b`),
  'Slack token': new RegExp(`\\bxox[abprs]-[A-Za-z0-9-]{10,}`),
  'Stripe live key': new RegExp(`\\b[rs]k_live_[A-Za-z0-9]{20,}`),
  'Google API key': new RegExp(`\\bAIza[0-9A-Za-z_-]{35}\\b`),
};
const findSecrets = (text) => Object.entries(secretPatterns).filter(([, re]) => re.test(text)).map(([name]) => name);

test('the secret scan recognises credential-shaped strings', () => {
  const samples = [`${dash}BEGIN PRIVATE KEY${dash}`, `gh${'p'}_${'a1'.repeat(18)}`, `AK${'IA'}${'Q'.repeat(16)}`, `xo${'xb'}-${'1'.repeat(12)}`, `sk${'_live'}_${'x'.repeat(24)}`, `AI${'za'}${'b'.repeat(35)}`];
  for (const sample of samples) assert.equal(findSecrets(sample).length, 1, sample.slice(0, 8));
  assert.deepEqual(findSecrets('/BEGIN RSA PRIVATE KEY/ and ghp_short'), []);
});

const isCheckout = fs.existsSync(path.join(root, '.git'));

test('no tracked file contains a credential', { skip: !isCheckout && 'not a git checkout' }, () => {
  const found = [];
  for (const file of execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)) {
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue; // deleted in the working tree
      throw error;
    }
    for (const name of findSecrets(text)) found.push(`${file}: ${name}`);
  }
  assert.deepEqual(found, []);
});
