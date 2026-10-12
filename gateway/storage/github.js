// Storage on a GitHub repository through its REST API (fetch only: Workers, Node, Deno). Each save
// is one commit made with the Git data API; the branch only moves forward, so a concurrent save
// fails instead of overwriting. Paths are relative to `dir`, the site's directory in the repository.
//
// The token needs "Contents: read and write" on that one repository (fine-grained token).

const decodeBase64 = (text) => Uint8Array.from(atob(text.replace(/\s/g, '')), (c) => c.charCodeAt(0));
const encodeBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

export function githubStorage({ owner, repo, token, dir = '', api = 'https://api.github.com', fetch: request = globalThis.fetch.bind(globalThis) }) {
  const prefix = dir.replace(/^\/+|\/+$/g, '');
  const full = (p) => (prefix ? `${prefix}/${p}` : p);
  const commits = new Map();
  const trees = new Map();
  const blobs = new Map();

  async function gh(path, { method = 'GET', body } = {}) {
    const response = await request(`${api}/repos/${owner}/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'werft', ...(body && { 'content-type': 'application/json' }) },
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

  async function commit({ branch, parent, message, author, changes }) {
    const base = await commitObject(parent);
    const entries = await Promise.all(changes.map(async ({ path, data }) => {
      if (!data) return { path: full(path), mode: '100644', type: 'blob', sha: null };
      const { data: blob } = await gh('/git/blobs', { method: 'POST', body: { content: encodeBase64(data), encoding: 'base64' } });
      return { path: full(path), mode: '100644', type: 'blob', sha: blob.sha };
    }));
    const { data: newTree } = await gh('/git/trees', { method: 'POST', body: { base_tree: base.tree.sha, tree: entries } });
    const date = new Date().toISOString();
    const { data: created } = await gh('/git/commits', { method: 'POST', body: { message, tree: newTree.sha, parents: [parent], author: { ...author, date } } });
    try {
      await gh(`/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: { sha: created.sha, force: false } });
    } catch (e) {
      // Not a fast-forward: someone saved in between.
      if (e.github === 422 || e.github === 409) throw Object.assign(new Error('The branch has moved on.'), { status: 409 });
      throw e;
    }
    commits.set(created.sha, Promise.resolve(created));
    const blobsByPath = Object.fromEntries(entries.filter((e) => e.sha).map((e) => [prefix ? e.path.slice(prefix.length + 1) : e.path, e.sha]));
    return { sha: created.sha, date: created.committer?.date ?? date, blobs: blobsByPath };
  }

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

  return { kind: 'github', head, tree, read, commit, log, creator };
}
