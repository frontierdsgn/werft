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

// File types that count as media. Anything else (HTML, SVG, scripts) would run on the admin's origin
// when opened, so only administrators may put it into a media folder.
const MEDIA_TYPES = /\.(jpe?g|png|gif|webp|avif|pdf|mp4|webm|mp3|m4a|ogg)$/i;

// What a repository path holds, relative to the site directory. The content of a language other
// than the default (content/<lang>/…) is what the same path in the default language holds.
export function classify(path, { contentDir = 'content', postType, mediaDirs = [], languages = [] }) {
  if (path === '.werft' || path.startsWith('.werft/')) return 'private';
  const lang = languages.slice(1).find((l) => path.startsWith(`${contentDir}/${l}/`));
  if (lang) path = `${contentDir}/${path.slice(contentDir.length + lang.length + 2)}`;
  if (path === `${contentDir}/settings/site.json`) return 'settings';
  if (path.startsWith(`${contentDir}/settings/`)) return 'structure';
  if (postType && path.startsWith(`${contentDir}/${postType}/`)) return 'post';
  if (['pages', 'patterns', 'forms'].some((d) => path.startsWith(`${contentDir}/${d}/`))) return 'content';
  if (mediaDirs.some((d) => path.startsWith(`${d}/`)) && MEDIA_TYPES.test(path)) return 'media';
  return 'code';
}

// The status an entry's text is saved with; a file without one is published.
const statusOf = (data) => {
  try { return JSON.parse(data).status ?? 'published'; } catch { return 'published'; }
};

// Returns null when `user` may make `change`, otherwise the reason it may not.
// change: { operation: 'create' | 'update' | 'delete', path, text?, creator? }
// `creator` is the e-mail of whoever added the file (first commit), for existing files. Returns
// null when the user may, else the key of the reason (gateway/messages.js).
export function denial(user, change, site) {
  const kind = classify(change.path, site);
  const own = change.operation === 'create' || change.creator?.toLowerCase() === user.email.toLowerCase();
  if (kind === 'private') return 'denied.private';
  switch (user.role) {
    case 'administrator':
      return null;
    case 'editor':
      return ['post', 'content', 'media'].includes(kind) ? null : 'denied.adminsOnly';
    case 'author':
      if (kind === 'media') return change.operation === 'create' ? null : 'denied.authorMedia';
      if (kind !== 'post') return 'denied.authorOwn';
      return own ? null : 'denied.authorOwn';
    case 'contributor':
      if (kind !== 'post' || !own) return 'denied.contributorOwn';
      if (change.operation !== 'delete' && !statuses(user.role).includes(statusOf(change.text))) return 'denied.contributorStatus';
      if (change.operation === 'delete' && change.wasPublished) return 'denied.contributorPublished';
      return null;
    default:
      return 'users.unknownRole';
  }
}

// The statuses a role may save its entries with, for the admin's status field.
export function statuses(role) {
  return role === 'contributor' ? ['draft', 'pending'] : ['draft', 'pending', 'published'];
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
