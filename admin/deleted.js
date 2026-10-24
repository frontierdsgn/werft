// "Gelöschte Inhalte": entries deleted in the site's history, found by comparing the content as
// consecutive commits left it, and brought back. Plain functions, so the editor and the tests share them.

// What a content path holds when it is an entry ({ kind, slug, lang }), else null. folders: kind →
// folder (page → pages, …); lang is null for the default language.
export function entryOf(path, { contentDir = 'content', languages = [], folders }) {
  const match = path.match(/^(.*)\/([^/]+)\/([^/]+)\.json$/);
  if (!match) return null;
  const [, dir, folder, slug] = match;
  const lang = dir === contentDir ? null : languages.slice(1).find((l) => dir === `${contentDir}/${l}`);
  const kind = Object.keys(folders).find((k) => folders[k] && folders[k] === folder);
  return kind && lang !== undefined ? { kind, slug, lang } : null;
}

// snapshots: [{ commit: { sha, date, author }, files: [{ path, sha }] }], newest first, each the
// content as a commit left it, for consecutive commits that changed the content. Returns the files
// one of them deleted, newest deletion first: { path, deleted (that commit), from (the sha of the
// commit before, which holds the last version) }. A file another one replaced in the same commit
// with the same content was moved (a page's new address), not deleted; a file that is there again
// (exists(path)) is left out.
export function deletedEntries(snapshots, { isEntry = () => true, exists = () => false } = {}) {
  const found = new Map();
  for (let i = 0; i + 1 < snapshots.length; i++) {
    const after = new Map(snapshots[i].files.map((f) => [f.path, f.sha]));
    const before = new Map(snapshots[i + 1].files.map((f) => [f.path, f.sha]));
    const added = new Set([...after].filter(([path]) => !before.has(path)).map(([, sha]) => sha));
    for (const [path, sha] of before) {
      if (after.has(path) || found.has(path) || added.has(sha) || !isEntry(path) || exists(path)) continue;
      found.set(path, { path, deleted: snapshots[i].commit, from: snapshots[i + 1].commit.sha });
    }
  }
  return [...found.values()];
}

// The entry as it comes back: as it was, but a page or post as a draft, so it is published again
// only when someone chooses to.
export function restoredEntry(data, kind) {
  const copy = structuredClone(data);
  if (kind === 'page' || kind === 'post') copy.status = 'draft';
  return copy;
}
