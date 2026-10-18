// What a site gets when it installs werft (npm packs the git dependency), and a secret scan of the
// repository. Both are part of `npm test`, the gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the package holds every entry point and every file they import', () => {
  const [{ files }] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
  const packed = new Set(files.map((f) => f.path));
  const entries = [...Object.values(pkg.exports), ...Object.values(pkg.bin)].map((p) => path.posix.normalize(p));
  for (const entry of entries) assert.ok(packed.has(entry), `${entry} is not in the package`);
  const missing = [];
  for (const file of packed) {
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/^\s*\/\/.*$/gm, ''); // not commented-out examples
    for (const [, spec] of source.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
      const target = path.posix.join(path.posix.dirname(file), spec);
      if (!packed.has(target)) missing.push(`${file} imports ${spec}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(![...packed].some((f) => f.startsWith('test/') || f.startsWith('scripts/')), 'tests and maintainer scripts stay out of the package');
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

const tracked = (() => { try { return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean); } catch { return null; } })();

test('no tracked file contains a credential', { skip: !tracked && 'not a git checkout' }, () => {
  const found = [];
  for (const file of tracked) {
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; } // deleted in the working tree
    for (const name of findSecrets(text)) found.push(`${file}: ${name}`);
  }
  assert.deepEqual(found, []);
});
