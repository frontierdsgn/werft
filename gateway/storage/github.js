// Storage on a GitHub repository through its REST API (fetch only: Workers, Node, Deno). Each save
// is one commit made with the Git data API; the branch only moves forward (or, for a squash, only
// from the head it was read at), so a concurrent save fails instead of overwriting. Paths are relative to `dir`, the site's directory in the repository.
//
// The token needs "Contents: read and write" on that one repository: a fine-grained token, or
// `auth`, a function resolving to { token, committer } such as githubApp (./github-app.js) returns.
// The committer, if given, makes the commits; the editor is always the author. dispatch() starts a
// workflow and needs "Actions: Read and write" as well (githubApp: auth.actions()).

import { messages } from '../messages.js';

const german = messages('de');

const decodeBase64 = (text) => Uint8Array.from(atob(text.replace(/\s/g, '')), (c) => c.charCodeAt(0));
// Text goes into the tree request itself; only other files need a request each.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const asText = (bytes) => { try { return utf8.decode(bytes); } catch { return null; } };
// Git's object id of a blob, as GitHub would report it.
async function blobId(bytes) {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);
  object.set(header);
  object.set(bytes, header.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', object))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const encodeBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

export function githubStorage({ owner, repo, token, auth = async () => ({ token }), dir = '', api = 'https://api.github.com', fetch: request = globalThis.fetch.bind(globalThis) }) {
  const prefix = dir.replace(/^\/+|\/+$/g, '');
  const full = (p) => (prefix ? `${prefix}/${p}` : p);
  const commits = new Map();
  const trees = new Map();
  const blobs = new Map();

  async function gh(path, { method = 'GET', body, root = `/repos/${owner}/${repo}`, credentials = auth } = {}) {
    const { token: bearer } = await credentials();
    const response = await request(`${api}${root}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'werft', ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw Object.assign(new Error(`GitHub ${method} ${path}: ${response.status} ${text.slice(0, 200)}`), { status: response.status >= 500 ? 502 : response.status, github: response.status });
    }
    return { data: response.status === 204 ? null : await response.json(), link: response.headers.get('link') };
  }

  async function commitObject(sha) {
    if (!commits.has(sha)) commits.set(sha, gh(`/git/commits/${sha}`).then((r) => r.data).catch((e) => { commits.delete(sha); throw e; }));
    return commits.get(sha);
  }

  async function head(branch) {
    const { data } = await gh(`/git/ref/heads/${encodeURIComponent(branch)}`).catch((e) => { throw e.github === 404 ? Object.assign(new Error(`Branch ${branch} not found`), { status: 404 }) : e; });
    const commit = await commitObject(data.object.sha);
    return { sha: commit.sha, message: commit.message, date: commit.committer.date };
  }

  // The site directory's files at a commit, from the directory's tree (recursive, one request).
  function tree(sha) {
    if (!trees.has(sha)) {
      trees.set(sha, (async () => {
        let treeSha = (await commitObject(sha)).tree.sha;
        for (const segment of prefix ? prefix.split('/') : []) {
          const entry = (await gh(`/git/trees/${treeSha}`)).data.tree.find((e) => e.path === segment && e.type === 'tree');
          if (!entry) return [];
          treeSha = entry.sha;
        }
        const { data } = await gh(`/git/trees/${treeSha}?recursive=1`);
        if (data.truncated) throw new Error('The site directory has too many files for one GitHub tree request.');
        return data.tree.filter((e) => e.type === 'blob').map(({ path, mode, sha: blob, size }) => ({ path, mode, type: 'blob', sha: blob, size }));
      })().catch((e) => { trees.delete(sha); throw e; }));
      if (trees.size > 20) trees.delete(trees.keys().next().value);
    }
    return trees.get(sha);
  }

  async function read(sha, path) {
    const entry = (await tree(sha)).find((e) => e.path === path);
    if (!entry) return null;
    if (!blobs.has(entry.sha)) {
      const { data } = await gh(`/git/blobs/${entry.sha}`);
      blobs.set(entry.sha, decodeBase64(data.content));
      if (blobs.size > 500) blobs.delete(blobs.keys().next().value);
    }
    return blobs.get(entry.sha);
  }

  // Many files in one GraphQL request (Cloudflare's free plan allows 50 outgoing requests per
  // invocation, and the admin loads up to 50 files at once). Binary or very large files fall back
  // to one REST request each.
  async function readMany(sha, paths) {
    const files = await tree(sha);
    const entries = paths.map((p) => files.find((e) => e.path === p) ?? null);
    const missing = [...new Set(entries.filter((e) => e && !blobs.has(e.sha)).map((e) => e.path))];
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      const variables = { owner, name: repo, ...Object.fromEntries(chunk.map((p, j) => [`e${j}`, `${sha}:${full(p)}`])) };
      const query = `query(${['$owner: String!', '$name: String!', ...chunk.map((_, j) => `$e${j}: String!`)].join(', ')}) { repository(owner: $owner, name: $name) { ${chunk.map((_, j) => `f${j}: object(expression: $e${j}) { ... on Blob { text isBinary isTruncated } }`).join(' ')} } }`;
      const { data } = await gh('/graphql', { method: 'POST', body: { query, variables }, root: '' });
      if (data.errors) throw new Error(`GitHub GraphQL: ${data.errors[0].message}`);
      chunk.forEach((p, j) => {
        const blob = data.data.repository[`f${j}`];
        if (blob && blob.text != null && !blob.isBinary && !blob.isTruncated) blobs.set(entries.find((e) => e?.path === p).sha, new TextEncoder().encode(blob.text));
      });
    }
    return Promise.all(entries.map((e) => (e ? read(sha, e.path) : null)));
  }

  // Moves a branch to a commit that does not follow from its head, only if the head is still `from`.
  // REST can only force such a move unconditionally; GraphQL's updateRefs checks the old value.
  let repositoryId;
  async function replaceRef(branch, from, to) {
    const graphql = async (query, variables) => (await gh('/graphql', { method: 'POST', body: { query, variables }, root: '' })).data;
    repositoryId ??= (await graphql('query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }', { owner, name: repo })).data.repository.id;
    const result = await graphql('mutation($id: ID!, $ref: GitRefname!, $from: GitObjectID!, $to: GitObjectID!) { updateRefs(input: { repositoryId: $id, refUpdates: [{ name: $ref, beforeOid: $from, afterOid: $to, force: true }] }) { clientMutationId } }',
      { id: repositoryId, ref: `refs/heads/${branch}`, from, to });
    if (!result.errors) return;
    // GitHub's errors for a changed head vary; the head tells.
    if ((await head(branch).then((h) => h.sha, () => null)) !== from) throw Object.assign(new Error('The branch has moved on.'), { status: 409 });
    throw new Error(`GitHub GraphQL: ${result.errors[0].message}`);
  }

  // parent null creates the branch; squash makes the new commit a root commit, so the branch no
  // longer leads to its earlier commits.
  async function commit({ branch, parent, message, author, changes, squash = false }) {
    const base = parent && await commitObject(parent);
    const entries = await Promise.all(changes.map(async ({ path, data }) => {
      if (!data) return { path: full(path), mode: '100644', type: 'blob', sha: null };
      const text = asText(data);
      if (text != null) return { path: full(path), mode: '100644', type: 'blob', content: text, id: await blobId(data) };
      const { data: blob } = await gh('/git/blobs', { method: 'POST', body: { content: encodeBase64(data), encoding: 'base64' } });
      return { path: full(path), mode: '100644', type: 'blob', sha: blob.sha };
    }));
    const { data: newTree } = await gh('/git/trees', { method: 'POST', body: { ...(base && { base_tree: base.tree.sha }), tree: entries.map(({ id, ...e }) => e) } });
    const date = new Date().toISOString();
    const { committer } = await auth();
    const { data: created } = await gh('/git/commits', { method: 'POST', body: { message, tree: newTree.sha, parents: parent && !squash ? [parent] : [], author: { ...author, date }, ...(committer && { committer: { ...committer, date } }) } });
    try {
      if (!parent) await gh('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: created.sha } });
      else if (squash) await replaceRef(branch, parent, created.sha);
      else await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: { sha: created.sha, force: false } });
    } catch (e) {
      // Not a fast-forward, or the branch exists already: someone saved in between.
      if (e.github === 422 || e.github === 409) throw Object.assign(new Error('The branch has moved on.'), { status: 409 });
      throw e;
    }
    commits.set(created.sha, Promise.resolve(created));
    const blobsByPath = Object.fromEntries(entries.filter((e) => e.sha || e.id).map((e) => [prefix ? e.path.slice(prefix.length + 1) : e.path, e.sha ?? e.id]));
    return { sha: created.sha, date: created.committer?.date ?? date, blobs: blobsByPath };
  }

  // Starts a workflow of the repository on `ref` (its trigger workflow_dispatch). A refusal names
  // what is missing as `reason`, a key of gateway/messages.js, for the tick's answer in the
  // admin's language; its message is the German text, for the log.
  async function dispatch(workflow, ref) {
    try {
      await gh(`/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { method: 'POST', body: { ref }, credentials: auth.actions ?? auth });
    } catch (e) {
      const reason = e.permission ? e.reason
        : e.github === 403 ? { key: 'tick.actionsPermission' }
          : e.github === 404 ? { key: 'tick.noWorkflow', values: { workflow } }
            : e.github === 422 ? { key: 'tick.notStartable', values: { workflow, ref } }
              : null;
      throw reason ? Object.assign(new Error(german('tick.problem', { reason: german(reason.key, reason.values) })), { plain: true, reason }) : e;
    }
  }

  // Deletes a branch if its head is still `sha` (GitHub cannot make a commit without files).
  const removeBranch = (branch, sha) => replaceRef(branch, sha, '0'.repeat(sha.length));

  const toEntry = (c) => ({ sha: c.sha, author: { name: c.commit.author.name, email: c.commit.author.email }, date: c.commit.author.date, message: c.commit.message });

  async function log({ branch, path, limit = 100 }) {
    const query = new URLSearchParams({ sha: branch, per_page: String(Math.min(limit, 100)), ...((path || prefix) && { path: full(path ?? '').replace(/\/$/, '') }) });
    return (await gh(`/commits?${query}`)).data.map(toEntry);
  }

  // Whoever added the file: the oldest commit touching it (last page of its history).
  async function creator(branch, path) {
    const query = new URLSearchParams({ sha: branch, path: full(path), per_page: '100' });
    let page = await gh(`/commits?${query}`);
    const last = page.link?.match(/<([^>]+)>;\s*rel="last"/)?.[1];
    if (last) page = await gh(last.slice(last.indexOf(`/repos/${owner}/${repo}`) + `/repos/${owner}/${repo}`.length));
    return page.data.at(-1)?.commit.author.email ?? null;
  }

  return { kind: 'github', head, tree, read, readMany, commit, removeBranch, log, creator, dispatch };
}
