#!/usr/bin/env node
// Maintainer tooling, not part of the package: moves the sites to a werft release. Releases
// themselves are made by release-please (.github/workflows/release.yml).
//
//   npm run update-sites -- [vx.y.z] [--dry-run] [--accept-changes]
//     Moves every site in the frontierdsgn organization (a repository whose package.json depends on
//     github:frontierdsgn/werft) to the given or the newest tag: npm install of the tag, one commit
//     with package.json and package-lock.json on the branch build/werft-<tag>, and a pull request
//     to the site's default branch. If the site's package.json has a gate script, `npm run gate`
//     must pass on the new werft first, or the site is reported as failed and nothing is pushed.
//     Each site is built with its old and its new werft first; if the public pages differ
//     (anything outside admin/ and _werft/build.json), the site is held back unless
//     --accept-changes is given. The pull request is squash-merged once the site's `gate` check
//     passed on its head commit; otherwise it stays open and the site is reported as failed.
//
// It works in fresh clones in a temporary directory, so local checkouts stay untouched.
// --dry-run does everything except pushing. Needs git, npm and gh, signed in with permission to
// push branches and to open and merge pull requests in the sites.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ORG = 'frontierdsgn';
const WERFT = `${ORG}/werft`;
const [command, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [target] = args.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const acceptChanges = flags.has('--accept-changes');

// Output is shown only when a command fails.
export function run(cmd, cmdArgs, { cwd } = {}) {
  try {
    return execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} failed:\n${[e.stdout, e.stderr].filter(Boolean).join('\n').trim().split('\n').slice(-20).join('\n')}`);
  }
}

function inTemp(prefix, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const latestTag = () => run('git', ['ls-remote', '--tags', '--refs', '--sort=-v:refname', `https://github.com/${WERFT}.git`, 'v*']).split('\n')[0].split('refs/tags/')[1];

function sites() {
  const repos = run('gh', ['api', '--paginate', `/orgs/${ORG}/repos?per_page=100`, '--jq', '.[] | select(.archived | not) | .full_name']).split('\n').filter(Boolean);
  return repos.filter((repo) => {
    try {
      const pkg = JSON.parse(run('gh', ['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/package.json`]));
      return String(pkg.dependencies?.werft ?? '').startsWith(`github:${WERFT}#`);
    } catch { return false; }
  });
}

// Files of the public site that differ between two builds.
function publicChanges(a, b) {
  const files = (root, dir = '') => readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    return e.isDirectory() ? files(root, rel) : [rel];
  });
  const internal = (rel) => rel.startsWith('admin/') || rel === '_werft/build.json';
  const all = [...new Set([...files(a), ...files(b)])].filter((rel) => !internal(rel)).sort();
  const read = (root, rel) => { try { return readFileSync(path.join(root, rel)); } catch { return null; } };
  return all.filter((rel) => { const x = read(a, rel); const y = read(b, rel); return !x || !y || !x.equals(y); });
}

// The site's gate run for a pushed commit, or the command that finds it once GitHub has started it.
function gateRun(repo, sha, exec) {
  const args = ['run', 'list', '-R', repo, '--commit', sha, '--workflow', 'gate.yml', '--json', 'url'];
  try {
    const [first] = JSON.parse(exec('gh', args));
    if (first?.url) return first.url;
  } catch { /* no run or no gate.yml yet */ }
  return `none yet, find it with: gh ${args.join(' ')}`;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The latest check run named `gate` on a commit, once it completed or after 30 minutes. Missing or
// unfinished counts as not passed.
function waitForGate(repo, sha, exec, wait, polls = 120) {
  for (let i = 0; ; i++) {
    const runs = JSON.parse(exec('gh', ['api', `repos/${repo}/commits/${sha}/check-runs?check_name=gate&filter=latest`, '--jq', '.check_runs']));
    const latest = runs.sort((a, b) => b.id - a.id)[0];
    if (latest?.status === 'completed' || i + 1 >= polls) return latest;
    wait(15_000);
  }
}

// Returns 'updated', 'current', 'held' or 'failed'. The tests pass their own exec for run and a
// wait that does not sleep.
export function updateSite(repo, tag, { dryRun = false, acceptChanges = false, exec = run, wait = sleep } = {}) {
  try {
    return inTemp('werft-site-', (tmp) => {
      const dir = path.join(tmp, 'site');
      const git = (...a) => exec('git', ['-C', dir, ...a]);
      exec('git', ['clone', '--quiet', `https://github.com/${repo}.git`, dir]);
      const spec = `github:${WERFT}#${tag}`;
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.dependencies.werft === spec) { console.log(`${repo}: already on ${tag}.`); return 'current'; }
      const from = pkg.dependencies.werft.split('#')[1];
      exec('npm', ['ci'], { cwd: dir });
      exec('npx', ['werft', 'build', '--out', path.join(tmp, 'old')], { cwd: dir });
      exec('npm', ['install', spec], { cwd: dir });
      // The site's own gate on the new werft; when it fails, exec throws with its last lines.
      const gate = Boolean(pkg.scripts?.gate);
      if (gate) exec('npm', ['run', 'gate'], { cwd: dir });
      exec('npx', ['werft', 'build', '--out', path.join(tmp, 'new')], { cwd: dir });
      const changed = publicChanges(path.join(tmp, 'old'), path.join(tmp, 'new'));
      if (changed.length && !acceptChanges) {
        console.log(`${repo}: held back, ${tag} changes ${changed.length} public files (rerun with --accept-changes to update anyway):\n  ${changed.slice(0, 20).join('\n  ')}`);
        return 'held';
      }
      // The title becomes the squash commit on the site's default branch.
      const title = `build(deps): bump werft from ${from} to ${tag}`;
      git('commit', '--quiet', '-m', title, '--', 'package.json', 'package-lock.json');
      const summary = `${repo}: ${from} → ${tag}, ${gate ? 'local gate passed' : 'no gate script'}${changed.length ? `; ${changed.length} public files changed` : '; public pages unchanged'}`;
      if (dryRun) { console.log(`${summary}; committed, not pushed (--dry-run).`); return 'updated'; }

      // A pull request per site, merged once the site's `gate` check passed on its head commit.
      const branch = `build/werft-${tag}`;
      const sha = git('rev-parse', 'HEAD');
      // A rerun replaces the branch an earlier run left behind (the clone tracks it).
      git('push', '--quiet', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch}`);
      const body = `Moves werft from ${from} to ${tag} ([release notes](https://github.com/${WERFT}/releases/tag/${tag})).\n\n${gate ? 'The site\'s gate passed locally on the new werft.' : 'The site has no gate script.'} ${changed.length ? `The public pages differ in ${changed.length} files (accepted with --accept-changes):\n\n${changed.slice(0, 50).map((f) => `- \`${f}\``).join('\n')}` : 'The public pages are unchanged.'}\n\nOpened by \`npm run update-sites\`, which merges it once \`gate\` passed on this commit.`;
      const open = JSON.parse(exec('gh', ['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'url']));
      const url = open[0]?.url ?? exec('gh', ['pr', 'create', '-R', repo, '--head', branch, '--title', title, '--body', body]);
      console.log(`${summary}; pull request ${url}`);
      const check = waitForGate(repo, sha, exec, wait);
      if (check?.conclusion !== 'success') {
        const state = !check ? 'no gate check' : check.status !== 'completed' ? `gate still ${check.status}` : `gate ${check.conclusion}`;
        throw new Error(`${state} on ${sha}${check?.html_url ? ` (${check.html_url})` : ''}; the pull request stays open: ${url}`);
      }
      exec('gh', ['pr', 'merge', url, '-R', repo, '--squash', '--delete-branch', '--match-head-commit', sha]);
      const merged = exec('gh', ['pr', 'view', url, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']);
      console.log(`  gate passed (${check.html_url}), merged as ${merged}.\n  gate run on the default branch: ${gateRun(repo, merged, exec)}`);
      return 'updated';
    });
  } catch (e) {
    console.error(`${repo}: failed: ${e.message}`);
    return 'failed';
  }
}

function updateSites(tag) {
  const results = sites().map((repo) => updateSite(repo, tag, { dryRun, acceptChanges }));
  if (!results.length) console.log(`No repository in ${ORG} depends on ${WERFT}.`);
  if (results.some((r) => r === 'failed' || r === 'held')) process.exitCode = 1;
}

// Run as a script, not when the tests import it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (command === 'sites') updateSites(target ?? latestTag());
    else { console.error('Usage: npm run update-sites -- [vx.y.z] [--dry-run] [--accept-changes]'); process.exitCode = 2; }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
