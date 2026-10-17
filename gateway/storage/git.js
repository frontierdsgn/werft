// Storage on a local git checkout (Node). Commits go to the checked-out branch and update the
// working tree, so a server that builds from the files sees each change at once. Commits to any
// other branch (form submissions) are made without touching the working tree. Only the site
// directory is exposed; paths are relative to it.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function git(cwd, args, { env, buffer = false, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, env: { ...process.env, ...env }, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 512 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve(stdout);
    });
    if (input) child.stdin.end(input);
  });
}

const conflict = (message) => Object.assign(new Error(message), { status: 409 });

export async function gitStorage(siteDir) {
  const dir = path.resolve(siteDir);
  const top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
  const prefix = path.relative(top, dir).split(path.sep).join('/');
  const repoPath = (p) => (prefix ? `${prefix}/${p}` : p);
  const treeish = (sha) => (prefix ? `${sha}:${prefix}` : `${sha}^{tree}`);
  let queue = Promise.resolve();

  async function head(branch) {
    const sha = (await git(top, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]).catch(() => '')).trim();
    if (!sha) throw Object.assign(new Error(`Branch ${branch} not found`), { status: 404 });
    const [message, date] = (await git(top, ['log', '-1', '--format=%B%x00%cI', sha])).split('\0');
    return { sha, message: message.trim(), date: date.trim() };
  }

  async function tree(sha) {
    const out = await git(top, ['ls-tree', '-r', '-l', '-z', treeish(sha)]).catch(() => '');
    return out.split('\0').filter(Boolean).map((line) => {
      const [meta, p] = line.split('\t');
      const [mode, type, blob, size] = meta.split(/\s+/);
      return { path: p, mode, type, sha: blob, size: Number(size) };
    }).filter((e) => e.type === 'blob');
  }

  async function read(sha, p) {
    try { return new Uint8Array(await git(top, ['cat-file', 'blob', `${sha}:${repoPath(p)}`], { buffer: true })); } catch { return null; }
  }

  // A commit on a branch that is not checked out, built in a temporary index.
  async function commitBeside({ branch, parent, message, changes, squash }, who) {
    const index = path.join(await git(top, ['rev-parse', '--absolute-git-dir']).then((d) => d.trim()), `werft-index-${randomUUID()}`);
    const env = { ...who, GIT_INDEX_FILE: index };
    try {
      await git(top, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env });
      const blobs = {};
      for (const change of changes) {
        if (!change.data) { await git(top, ['update-index', '--force-remove', '--', repoPath(change.path)], { env }); continue; }
        blobs[change.path] = (await git(top, ['hash-object', '-w', '--stdin'], { input: change.data })).trim();
        await git(top, ['update-index', '--add', '--cacheinfo', `100644,${blobs[change.path]},${repoPath(change.path)}`], { env });
      }
      const tree = (await git(top, ['write-tree'], { env })).trim();
      const sha = (await git(top, ['commit-tree', tree, ...(parent && !squash ? ['-p', parent] : []), '-m', message], { env })).trim();
      // Only if the branch is still where it was read (or, without a parent, does not exist yet).
      await git(top, ['update-ref', `refs/heads/${branch}`, sha, parent ?? '']).catch(() => { throw conflict('The branch has moved on.'); });
      return { sha, date: (await head(branch)).date, blobs };
    } finally {
      await fs.rm(index, { force: true });
    }
  }

  // changes: [{ path, data: Uint8Array | null }] (null deletes). Serialized, and refused when the
  // branch moved since `parent`. parent null creates the branch; squash makes the new commit a root
  // commit, so the branch no longer leads to its earlier commits (only for a branch that is not
  // checked out).
  function commit({ branch, parent, message, author, changes, squash = false }) {
    const run = queue.then(async () => {
      const who = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
      const current = (await git(top, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
      if (current !== `refs/heads/${branch}`) return commitBeside({ branch, parent, message, changes, squash }, who);
      if ((await head(branch)).sha !== parent) throw conflict('The branch has moved on.');
      for (const change of changes) {
        const file = path.join(dir, change.path);
        if (change.data) {
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, change.data);
        } else {
          await fs.rm(file, { force: true });
        }
      }
      const paths = changes.map((c) => repoPath(c.path));
      await git(top, ['add', '--', ...paths]);
      await git(top, ['commit', '--quiet', '-m', message, '--', ...paths], { env: who });
      const result = await head(branch);
      const listed = await git(top, ['ls-tree', '-z', result.sha, '--', ...paths]);
      const blobs = Object.fromEntries(listed.split('\0').filter(Boolean).map((line) => {
        const [meta, p] = line.split('\t');
        return [prefix ? p.slice(prefix.length + 1) : p, meta.split(/\s+/)[2]];
      }));
      return { sha: result.sha, date: result.date, blobs };
    });
    queue = run.catch(() => {});
    return run;
  }

  // Deletes a branch if its head is still `sha`.
  function removeBranch(branch, sha) {
    const run = queue.then(() => git(top, ['update-ref', '-d', `refs/heads/${branch}`, sha]).catch(() => { throw conflict('The branch has moved on.'); }));
    queue = run.catch(() => {});
    return run;
  }

  async function log({ branch, path: p, limit = 100 }) {
    const out = await git(top, ['log', `-n${limit}`, '--format=%H%x00%an%x00%ae%x00%aI%x00%s%x00', `refs/heads/${branch}`, '--', repoPath(p ?? '')]);
    const fields = out.split('\0');
    const commits = [];
    for (let i = 0; i + 4 < fields.length; i += 5) {
      const [sha, name, email, date, message] = fields.slice(i, i + 5).map((f) => f.trim());
      if (sha) commits.push({ sha, author: { name, email }, date, message });
    }
    return commits;
  }

  async function creator(branch, p) {
    const out = await git(top, ['log', '--diff-filter=A', '--format=%ae', `refs/heads/${branch}`, '--', repoPath(p)]);
    return out.trim().split('\n').filter(Boolean).pop() ?? null;
  }

  return { kind: 'git', root: top, prefix, head, tree, read, commit, removeBranch, log, creator };
}
