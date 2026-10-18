// `npm run update-sites` (scripts/release.js) against a site in a local bare repository. git and the
// site's own gate run for real; npm install, the builds and gh are stand-ins, so no network is used.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, updateSite } from '../scripts/release.js';

// git and npm in this process use this identity and no system or user configuration, cache or logs.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-sites-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
for (const name of Object.keys(process.env)) if (/^npm_config_/i.test(name)) delete process.env[name];
Object.assign(process.env, {
  HOME: home,
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
  npm_config_userconfig: path.join(home, '.npmrc'), npm_config_globalconfig: path.join(home, 'npmrc'),
  npm_config_cache: path.join(home, '.npm'), npm_config_update_notifier: 'false',
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

// Clones from the bare repository instead of GitHub and runs `npm run` for real. gh answers with
// `checks`, one list of `gate` check runs per poll (the last one repeats), and merges a pull request
// by moving the bare repository's main to the pull request's head.
function exec(root, { runs = [], checks = [[]] } = {}) {
  const calls = [];
  const remote = path.join(root, `${REPO}.git`);
  let poll = 0;
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
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return '[]';
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') return PR;
    if (cmd === 'gh' && args[0] === 'api') return JSON.stringify(checks[Math.min(poll++, checks.length - 1)]);
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
      run('git', ['-C', remote, 'update-ref', 'refs/heads/main', args[args.indexOf('--match-head-commit') + 1]]);
      return '';
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') return run('git', ['-C', remote, 'rev-parse', 'main']);
    if (cmd === 'gh' && args[0] === 'run') return JSON.stringify(runs);
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
  fn.calls = calls;
  return fn;
}

const PR = 'https://github.com/frontierdsgn/site/pull/7';
const BRANCH = 'build/werft-v0.2.0';
const branchHead = (site) => run('git', ['-C', site.remote, 'rev-parse', BRANCH]);
const noWait = () => {};

const output = (mock) => mock.mock.calls.map((c) => c.arguments.join(' ')).join('\n');

test('update-sites reports a site whose gate fails as failed, with the gate output, and pushes nothing', (t) => {
  const site = fixtureSite(t, { build: 'werft build', gate: 'node -e "console.log(\'lint: 3 problems\'); process.exit(1)"' });
  const before = site.head();
  const error = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  assert.equal(updateSite(REPO, 'v0.2.0', { exec: exec(site.root) }), 'failed');
  assert.match(output(error), /^frontierdsgn\/site: failed: npm run gate failed:[\s\S]*lint: 3 problems/);
  assert.equal(site.head(), before);
  assert.equal(run('git', ['-C', site.remote, 'for-each-ref', '--format=%(refname)']), 'refs/heads/main');
});

test('update-sites opens a pull request and merges it once the site\'s gate check passed on its head', (t) => {
  // The gate passes only on the new werft, so it must run after npm install of the tag.
  const site = fixtureSite(t, { build: 'werft build', gate: 'node -e "process.exit(require(\'./package.json\').dependencies.werft.endsWith(\'#v0.2.0\') ? 0 : 1)"' });
  const before = site.head();
  const log = t.mock.method(console, 'log', () => {});
  const url = 'https://github.com/frontierdsgn/site/actions/runs/1';
  const check = 'https://github.com/frontierdsgn/site/runs/9';
  // No check yet, then running, then passed: main must not move before the check completed.
  const checks = [[], [{ id: 9, status: 'in_progress', conclusion: null }], [{ id: 9, status: 'completed', conclusion: 'success', html_url: check }]];
  let waits = 0;
  const fn = exec(site.root, { runs: [{ url }], checks });
  const wait = () => { waits++; assert.equal(site.head(), before); };
  assert.equal(updateSite(REPO, 'v0.2.0', { exec: fn, wait }), 'updated');
  assert.equal(waits, 2);
  assert.ok(fn.calls.includes('npm run gate'));
  const head = branchHead(site);
  assert.equal(run('git', ['-C', site.remote, 'rev-parse', `${head}^`]), before);
  assert.ok(fn.calls.some((c) => c.startsWith(`gh pr create -R ${REPO} --head ${BRANCH} --title build(deps): bump werft from v0.1.0 to v0.2.0`)));
  assert.ok(fn.calls.includes(`gh pr merge ${PR} --squash --delete-branch --match-head-commit ${head}`));
  assert.equal(JSON.parse(run('git', ['-C', site.remote, 'show', 'main:package.json'])).dependencies.werft, 'github:frontierdsgn/werft#v0.2.0');
  assert.match(output(log), /v0\.1\.0 → v0\.2\.0, local gate passed; public pages unchanged; pull request https:\/\/github\.com\/frontierdsgn\/site\/pull\/7/);
  assert.ok(output(log).includes(`gate passed (${check}), merged as ${head}`));
  assert.ok(output(log).includes(`gate run on the default branch: ${url}`));
});

test('update-sites leaves the pull request open and reports the site as failed when its gate check fails', (t) => {
  const site = fixtureSite(t, { build: 'werft build' });
  const before = site.head();
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const check = 'https://github.com/frontierdsgn/site/runs/9';
  // An older passing run on the commit does not count; the latest one failed.
  const fn = exec(site.root, { checks: [[{ id: 8, status: 'completed', conclusion: 'success' }, { id: 9, status: 'completed', conclusion: 'failure', html_url: check }]] });
  assert.equal(updateSite(REPO, 'v0.2.0', { exec: fn, wait: noWait }), 'failed');
  assert.ok(!fn.calls.some((c) => c.startsWith('npm run')));
  assert.ok(!fn.calls.some((c) => c.startsWith('gh pr merge')));
  assert.equal(site.head(), before);
  assert.equal(JSON.parse(run('git', ['-C', site.remote, 'show', `${BRANCH}:package.json`])).dependencies.werft, 'github:frontierdsgn/werft#v0.2.0');
  assert.ok(output(error).includes(`gate failure on ${branchHead(site)} (${check}); the pull request stays open: ${PR}`));
});

test('update-sites --dry-run pushes nothing and opens no pull request', (t) => {
  const site = fixtureSite(t, { build: 'werft build' });
  const log = t.mock.method(console, 'log', () => {});
  const fn = exec(site.root);
  assert.equal(updateSite(REPO, 'v0.2.0', { exec: fn, dryRun: true }), 'updated');
  assert.ok(!fn.calls.some((c) => c.startsWith('gh ') || c.includes(' push ')));
  assert.equal(run('git', ['-C', site.remote, 'for-each-ref', '--format=%(refname)']), 'refs/heads/main');
  assert.match(output(log), /committed, not pushed \(--dry-run\)/);
});

test('update-sites runs as a script and not when imported', () => {
  const script = fileURLToPath(new URL('../scripts/release.js', import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^Usage: npm run update-sites/);
});
