// Roles, modelled on WordPress's default roles. The gateway checks every change against them; the
// admin only uses them to hide what a user cannot change.
//
//   administrator  everything: site settings, menus, redirects, users, theme and code
//   editor         all pages, posts, patterns, forms and media, including other people's
//   author         their own posts, published or not, and uploading media
//   contributor    their own posts as draft or pending review; no publishing, no uploads

export const ROLES = {
  administrator: { label: 'Administrator' },
  editor: { label: 'Redakteur' },
  author: { label: 'Autor' },
  contributor: { label: 'Mitarbeiter' },
};

// What a repository path holds, relative to the site directory.
export function classify(path, { contentDir = 'content', postType, mediaDirs = [] }) {
  if (path === '.werft' || path.startsWith('.werft/')) return 'private';
  if (path === `${contentDir}/settings/site.json`) return 'settings';
  if (path.startsWith(`${contentDir}/settings/`)) return 'structure';
  if (postType && path.startsWith(`${contentDir}/${postType}/`)) return 'post';
  if (['pages', 'patterns', 'forms'].some((d) => path.startsWith(`${contentDir}/${d}/`))) return 'content';
  if (mediaDirs.some((d) => path.startsWith(`${d}/`))) return 'media';
  return 'code';
}

const PUBLISHED = (data) => {
  try { return (JSON.parse(data).status ?? 'published') === 'published'; } catch { return true; }
};

// Returns null when `user` may make `change`, otherwise the reason it may not.
// change: { operation: 'create' | 'update' | 'delete', path, text?, creator? }
// `creator` is the e-mail of whoever added the file (first commit), for existing files.
export function denial(user, change, site) {
  const kind = classify(change.path, site);
  const own = change.operation === 'create' || change.creator?.toLowerCase() === user.email.toLowerCase();
  if (kind === 'private') return 'Dieser Bereich ist geschützt.';
  switch (user.role) {
    case 'administrator':
      return null;
    case 'editor':
      return ['post', 'content', 'media'].includes(kind) ? null : 'Nur Administratoren dürfen das ändern.';
    case 'author':
      if (kind === 'media') return change.operation === 'create' ? null : 'Autoren dürfen Medien nur hochladen.';
      if (kind !== 'post') return 'Autoren dürfen nur eigene Beiträge ändern.';
      return own ? null : 'Autoren dürfen nur eigene Beiträge ändern.';
    case 'contributor':
      if (kind !== 'post' || !own) return 'Mitarbeiter dürfen nur eigene Beiträge ändern.';
      if (change.operation !== 'delete' && PUBLISHED(change.text)) return 'Mitarbeiter dürfen Beiträge nur als Entwurf oder zur Prüfung speichern.';
      if (change.operation === 'delete' && change.wasPublished) return 'Mitarbeiter dürfen veröffentlichte Beiträge nicht löschen.';
      return null;
    default:
      return 'Unbekannte Rolle.';
  }
}

// Which kinds of content a role can change at all, for the admin's collection list.
export function editable(role) {
  return {
    administrator: ['settings', 'structure', 'content', 'post', 'media', 'code', 'users'],
    editor: ['content', 'post', 'media'],
    author: ['post', 'media'],
    contributor: ['post'],
  }[role] ?? [];
}
