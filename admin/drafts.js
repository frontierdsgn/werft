// Unsaved changes kept in the browser, so a closed tab or a crash does not lose them. Plain
// functions without the browser's storage, so the editor and the tests share them.

// One entry per user, site and branch.
export const draftKey = ({ site, branch, email }) => `werft.unsaved:${site}:${branch}:${String(email).toLowerCase()}`;

// The version of a file the editor has: its saved sha, null when it is not saved.
const versionOf = (f) => (f?.saved == null ? null : f.sha ?? null);

// What the editor would save: each changed content file with the version it started from (its sha,
// null for a new file), uploads not saved yet and media files to delete.
// files: Map path → { sha, saved, data }; changed: the changed paths; uploads: [{ path, base64, size }].
export function collectDraft({ files, changed, uploads = [], removed = [], now = new Date() }) {
  return {
    saved_at: now.toISOString(),
    files: changed.map((path) => ({ path, sha: versionOf(files.get(path)), data: files.get(path)?.data ?? null })),
    uploads,
    removed: [...removed],
  };
}

// The draft's paths whose saved version is no longer the one the change started from: someone saved
// them since (or created or deleted them).
export const changedSince = (draft, files) => (draft.files ?? []).filter(({ path, sha }) => versionOf(files.get(path)) !== sha).map(({ path }) => path);

// Puts a draft's files into `files` as unsaved changes; they replace what was saved since. A drafted
// deletion of a file that is gone already is left out.
export function applyDraft(draft, files) {
  for (const { path, data } of draft.files ?? []) {
    const f = files.get(path);
    if (f) f.data = structuredClone(data);
    else if (data !== null) files.set(path, { sha: null, saved: null, data: structuredClone(data) });
  }
}
