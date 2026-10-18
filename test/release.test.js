// `npm run update-sites` (scripts/release.js) against a site in a local bare repository. git and the
// site's own gate run for real; npm install, the builds and gh are stand-ins, so no network is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, updateSite } from '../scripts/release.js';

// Commits in the temporary clones use this identity and no system or user git configuration.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
});

const REPO = 'frontierdsgn/site';

// A site on werft v0.1.0 in a bare repository at <root>/frontierdsgn/site.git.
function fixtureSite(t, scripts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-sites-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, `${REPO}.git`);
  const work = path.join(root, 'work');
  run('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
  run('git', ['clone', '--quiet', remote, work]);
  const pkg = { name: 'site', private: true, type: 'module', scripts, dependencies: { werft: 'github:frontierdsgn/werft#v0.1.0' } };
  fs.writeFileSync(path.join(work, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(work, 'package-lock.json'), '{"werft":"v0.1.0"}\n');
  run('git', ['-C', work, 'add', '.']);
  run('git', ['-C', work, 'commit', '--quiet', '-m', 'Site: werft 0.1.0']);
  run('git', ['-C', work, 'push', '--quiet', 'origin', 'HEAD:main']);
  const head = () => run('git', ['-C', remote, 'rev-parse', 'main']);
  return { root, remote, head };
}

// Clones from the bare repository instead of GitHub and runs `npm run` for real.
function exec(root, { runs = [] } = {}) {
  const calls = [];
  const fn = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'git') return run(cmd, args.map((a) => a.replace('https://github.com/', `${root}/`)), opts);
    if (cmd === 'npm' && args[0] === 'run') return run(cmd, args, opts);
    if (cmd === 'npm' && args[0] === 'ci') return '';
    if (cmd === 'npm' && args[0] === 'install') {
      const file = path.join(opts.cwd, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      pkg.dependencies.werft = args[1];
      fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
      fs.writeFileSync(path.join(opts.cwd, 'package-lock.json'), `${JSON.stringify({ werft: args[1] })}\n`);
      return '';
    }
    if (cmd === 'npx' && args[1] === 'build') {
      const out = args[args.indexOf('--out') + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'index.html'), '<title>Start</title>\n');
      return '';
    }
    if (cmd === 'gh' && args[0] === 'run') return JSON.stringify(runs);
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
  fn.calls = calls;
  return fn;
}

const output = (mock) => mock.mock.calls.map((c) => c.arguments.join(' ')).join('\n');

test('update-sites reports a site whose gate fails as failed, with the gate output, and pushes nothing', (t) => {
  const site = fixtureSite(t, { build: 'werft build', gate: 'node -e "console.log(\'lint: 3 problems\'); process.exit(1)"' });
  const before = site.head();
  const error = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  assert.equal(updateSite(REPO, 'v0.2.0', { exec: exec(site.root) }), 'failed');
  assert.match(output(error), /^frontierdsgn\/site: failed: npm run gate failed:[\s\S]*lint: 3 problems/);
  assert.equal(site.head(), before);
});

test('update-sites pushes a site whose gate passes and prints its gate run', (t) => {
  const site = fixtureSite(t, { build: 'werft build', gate: 'node -e "process.exit(0)"' });
  const log = t.mock.method(console, 'log', () => {});
  const url = 'https://github.com/frontierdsgn/site/actions/runs/1';
  const fn = exec(site.root, { runs: [{ url }] });
  assert.equal(updateSite(REPO, 'v0.2.0', { exec: fn }), 'updated');
  assert.ok(fn.calls.includes('npm run gate'));
  assert.equal(run('git', ['-C', site.remote, 'log', '-1', '--format=%s', 'main']), 'Site: werft 0.2.0');
  assert.match(output(log), /v0\.1\.0 → v0\.2\.0, gate passed, pushed/);
  assert.ok(output(log).includes(`gate run: ${url}`));
});

test('update-sites pushes a site without a gate script as before', (t) => {
  const site = fixtureSite(t, { build: 'werft build' });
  const log = t.mock.method(console, 'log', () => {});
  const fn = exec(site.root);
  assert.equal(updateSite(REPO, 'v0.2.0', { exec: fn }), 'updated');
  assert.ok(!fn.calls.some((c) => c.startsWith('npm run')));
  const pushed = JSON.parse(run('git', ['-C', site.remote, 'show', 'main:package.json']));
  assert.equal(pushed.dependencies.werft, 'github:frontierdsgn/werft#v0.2.0');
  assert.match(output(log), /no gate script, pushed/);
  // No run yet: it prints the command that finds it.
  assert.ok(output(log).includes(`gh run list -R ${REPO} --commit ${site.head()} --workflow gate.yml --json url`));
});
