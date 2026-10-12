#!/usr/bin/env node
// Maintainer tooling, not part of the package: releases werft and moves the sites to the release.
// Both work in fresh clones in a temporary directory, so local checkouts stay untouched.
//
//   npm run release -- <patch|minor|major|x.y.z> [--dry-run] [--accept-changes]
//     Tests origin/main, sets the version in package.json, package-lock.json and README.md,
//     commits "werft x.y.z" listing the commits since the last tag, tags vx.y.z, pushes both and
//     then updates the sites.
//   npm run update-sites -- [vx.y.z] [--dry-run] [--accept-changes]
//     Moves every site in the frontierdsgn organization (a repository whose package.json depends on
//     github:frontierdsgn/werft) to the given or the newest tag, on its default branch: npm install
//     of the tag, then one commit with package.json and package-lock.json. Each site is built with
//     its old and its new werft first; if the public pages differ (anything outside admin/ and
//     _werft/build.json), the site is held back unless --accept-changes is given.
//
// --dry-run does everything except pushing. Needs git, npm and gh, signed in with push access.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ORG = 'frontierdsgn';
const WERFT = `${ORG}/werft`;
const [command, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [target] = args.filter((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const acceptChanges = flags.has('--accept-changes');

// Output is shown only when a command fails.
function run(cmd, cmdArgs, { cwd } = {}) {
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

const clone = (repo, dir) => run('git', ['clone', '--quiet', `https://github.com/${repo}.git`, dir]);

function release(bump) {
  return inTemp('werft-release-', (dir) => {
    const git = (...a) => run('git', ['-C', dir, ...a]);
    clone(WERFT, dir);
    const previous = git('describe', '--tags', '--abbrev=0');
    const changes = git('log', '--reverse', '--format=%s', `${previous}..HEAD`).split('\n').filter(Boolean);
    if (!changes.length) throw new Error(`Nothing to release: main is at ${previous}.`);
    run('npm', ['ci'], { cwd: dir });
    run('npm', ['test'], { cwd: dir });
    const version = run('npm', ['version', bump, '--no-git-tag-version'], { cwd: dir }).replace(/^v/, '');
    const readme = path.join(dir, 'README.md');
    writeFileSync(readme, readFileSync(readme, 'utf8').replace(/werft is version \d+\.\d+\.\d+/, `werft is version ${version}`).replace(/(github:frontierdsgn\/werft#v)\d+\.\d+\.\d+/g, `$1${version}`));
    git('commit', '--quiet', '-m', `werft ${version}`, '-m', changes.map((c) => `- ${c}`).join('\n'), '--', 'package.json', 'package-lock.json', 'README.md');
    git('tag', '-a', `v${version}`, '-m', `werft ${version}`);
    if (dryRun) { console.log(`werft ${version}: committed and tagged in the clone, not pushed (--dry-run).`); return null; }
    git('push', '--quiet', 'origin', 'HEAD:main', `v${version}`);
    console.log(`werft ${version}: released (${changes.length} commits since ${previous}).`);
    return `v${version}`;
  });
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

// Returns 'updated', 'current' or 'held'.
function updateSite(repo, tag) {
  return inTemp('werft-site-', (tmp) => {
    const dir = path.join(tmp, 'site');
    const git = (...a) => run('git', ['-C', dir, ...a]);
    clone(repo, dir);
    const spec = `github:${WERFT}#${tag}`;
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.dependencies.werft === spec) { console.log(`${repo}: already on ${tag}.`); return 'current'; }
    const from = pkg.dependencies.werft.split('#')[1];
    run('npm', ['ci'], { cwd: dir });
    run('npx', ['werft', 'build', '--out', path.join(tmp, 'old')], { cwd: dir });
    run('npm', ['install', spec], { cwd: dir });
    run('npx', ['werft', 'build', '--out', path.join(tmp, 'new')], { cwd: dir });
    const changed = publicChanges(path.join(tmp, 'old'), path.join(tmp, 'new'));
    if (changed.length && !acceptChanges) {
      console.log(`${repo}: held back, ${tag} changes ${changed.length} public files (rerun with --accept-changes to update anyway):\n  ${changed.slice(0, 20).join('\n  ')}`);
      return 'held';
    }
    // The repository's own commit prefix, e.g. "InselSalon: werft 0.2.0".
    const prefix = git('log', '--format=%s').split('\n').map((s) => s.match(/^([^:]+): werft /)?.[1]).find(Boolean);
    const version = tag.replace(/^v/, '');
    git('commit', '--quiet', '-m', prefix ? `${prefix}: werft ${version}` : `werft ${version}`, '--', 'package.json', 'package-lock.json');
    if (!dryRun) git('push', '--quiet', 'origin', 'HEAD');
    console.log(`${repo}: ${from} → ${tag}${dryRun ? ', committed, not pushed (--dry-run)' : ', pushed'}${changed.length ? `; ${changed.length} public files changed` : '; public pages unchanged'}.`);
    return 'updated';
  });
}

function updateSites(tag) {
  const results = sites().map((repo) => {
    try { return updateSite(repo, tag); } catch (e) { console.error(`${repo}: failed: ${e.message}`); return 'failed'; }
  });
  if (!results.length) console.log(`No repository in ${ORG} depends on ${WERFT}.`);
  if (results.some((r) => r === 'failed' || r === 'held')) process.exitCode = 1;
}

try {
  if (command === 'sites') updateSites(target ?? latestTag());
  else if (command === 'release' && target) { const tag = release(target); if (tag) updateSites(tag); }
  else { console.error('Usage: npm run release -- <patch|minor|major|x.y.z> [--dry-run] [--accept-changes]\n       npm run update-sites -- [vx.y.z] [--dry-run] [--accept-changes]'); process.exitCode = 2; }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
