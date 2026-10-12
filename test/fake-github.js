// An in-memory stand-in for the parts of GitHub's REST API that githubStorage uses: refs, the Git
// data API (blobs, trees, commits) and the commit list with path filter and pagination.
import { createHash } from 'node:crypto';

export function fakeGitHub({ owner = 'o', repo = 'r', api = 'https://api.github.test' } = {}) {
  const objects = new Map();
  const refs = new Map();
  const put = (object) => { const sha = createHash('sha1').update(JSON.stringify(object)).digest('hex'); objects.set(sha, object); return sha; };
  const requests = [];

  // flat: Map path → blob sha; returns the root tree's sha.
  function writeTree(flat) {
    const here = new Map();
    const sub = new Map();
    for (const [path, sha] of flat) {
      const [first, ...rest] = path.split('/');
      if (rest.length) { if (!sub.has(first)) sub.set(first, new Map()); sub.get(first).set(rest.join('/'), sha); } else here.set(first, sha);
    }
    const entries = [...here].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha }));
    for (const [path, files] of sub) entries.push({ path, mode: '040000', type: 'tree', sha: writeTree(files) });
    return put({ type: 'tree', entries: entries.sort((a, b) => a.path.localeCompare(b.path)) });
  }

  function flatten(treeSha, prefix = '', out = new Map(), withTrees = null) {
    for (const e of objects.get(treeSha).entries) {
      const path = prefix + e.path;
      if (e.type === 'tree') { withTrees?.push({ ...e, path }); flatten(e.sha, `${path}/`, out, withTrees); } else { out.set(path, e.sha); withTrees?.push({ ...e, path, size: objects.get(e.sha).data.length }); }
    }
    return out;
  }

  function makeCommit({ message, tree, parents, author }) {
    const date = author.date ?? new Date().toISOString();
    return put({ type: 'commit', message, tree, parents, author: { ...author, date }, committer: { ...author, date }, n: objects.size });
  }

  const commitJSON = (sha) => { const c = objects.get(sha); return { sha, message: c.message, tree: { sha: c.tree }, parents: c.parents.map((p) => ({ sha: p })), author: c.author, committer: c.committer }; };

  // Seeds a branch with one commit holding `files` (path → text).
  function seed(files, { branch = 'main', author = { name: 'Ada', email: 'admin@test' } } = {}) {
    const flat = new Map(Object.entries(files).map(([p, text]) => [p, put({ type: 'blob', data: Buffer.from(text).toString('base64') })]));
    refs.set(branch, makeCommit({ message: 'init', tree: writeTree(flat), parents: [], author }));
  }

  const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

  async function fetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    requests.push(`${method} ${u.pathname}${u.search}`);
    const base = `/repos/${owner}/${repo}`;
    if (!u.pathname.startsWith(base) || !init.headers?.authorization) return json({ message: 'Not Found' }, 404);
    const path = u.pathname.slice(base.length);
    const body = init.body && JSON.parse(init.body);
    let m;
    if ((m = path.match(/^\/git\/ref\/heads\/(.+)$/)) && method === 'GET') {
      const sha = refs.get(decodeURIComponent(m[1]));
      return sha ? json({ object: { sha, type: 'commit' } }) : json({ message: 'Not Found' }, 404);
    }
    if ((m = path.match(/^\/git\/commits\/(\w+)$/))) return objects.get(m[1])?.type === 'commit' ? json(commitJSON(m[1])) : json({}, 404);
    if ((m = path.match(/^\/git\/trees\/(\w+)$/))) {
      if (objects.get(m[1])?.type !== 'tree') return json({}, 404);
      if (u.searchParams.get('recursive')) { const list = []; flatten(m[1], '', new Map(), list); return json({ sha: m[1], tree: list, truncated: false }); }
      return json({ sha: m[1], tree: objects.get(m[1]).entries, truncated: false });
    }
    if ((m = path.match(/^\/git\/blobs\/(\w+)$/))) return objects.get(m[1])?.type === 'blob' ? json({ sha: m[1], content: objects.get(m[1]).data, encoding: 'base64' }) : json({}, 404);
    if (path === '/git/blobs' && method === 'POST') return json({ sha: put({ type: 'blob', data: body.content }) }, 201);
    if (path === '/git/trees' && method === 'POST') {
      const flat = flatten(body.base_tree);
      for (const e of body.tree) { if (e.sha === null) flat.delete(e.path); else flat.set(e.path, e.sha); }
      return json({ sha: writeTree(flat) }, 201);
    }
    if (path === '/git/commits' && method === 'POST') { const sha = makeCommit(body); return json(commitJSON(sha), 201); }
    if ((m = path.match(/^\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
      const branch = decodeURIComponent(m[1]);
      if (!body.force && !objects.get(body.sha).parents.includes(refs.get(branch))) return json({ message: 'Update is not a fast forward' }, 422);
      refs.set(branch, body.sha);
      return json({ object: { sha: body.sha } });
    }
    if (path === '/commits' && method === 'GET') {
      const filter = u.searchParams.get('path');
      const perPage = Number(u.searchParams.get('per_page') ?? 30);
      const page = Number(u.searchParams.get('page') ?? 1);
      const touched = (sha) => {
        const c = objects.get(sha);
        const now = flatten(c.tree);
        const before = c.parents[0] ? flatten(objects.get(c.parents[0]).tree) : new Map();
        const inside = (p) => !filter || p === filter || p.startsWith(`${filter}/`);
        return [...new Set([...now.keys(), ...before.keys()])].some((p) => inside(p) && now.get(p) !== before.get(p));
      };
      const all = [];
      for (let sha = refs.get(u.searchParams.get('sha')); sha; sha = objects.get(sha).parents[0]) if (touched(sha)) all.push(sha);
      const pages = Math.max(1, Math.ceil(all.length / perPage));
      const last = new URL(url); last.searchParams.set('page', String(pages));
      const link = pages > 1 ? { link: `<${last}>; rel="last"` } : {};
      return json(all.slice((page - 1) * perPage, page * perPage).map((sha) => { const c = objects.get(sha); return { sha, commit: { message: c.message, author: c.author, committer: c.committer } }; }), 200, link);
    }
    return json({ message: `fake: ${method} ${path} not implemented` }, 501);
  }

  const fileAt = (branch, path) => { const sha = flatten(objects.get(refs.get(branch)).tree).get(path); return sha && Buffer.from(objects.get(sha).data, 'base64').toString(); };
  return { fetch, seed, fileAt, requests, owner, repo, api };
}
