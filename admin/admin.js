// Starts Sveltia CMS with a configuration derived from the site and the signed-in user's role.
import { cmsConfig } from 'werft/cms-config';
import { requireUser, loadSite, stored, toolbar, api } from './session.js';
import { registerPreviews, forgetContent } from './preview.js';

const { site, theme, base } = await loadSite();
const me = await requireUser(site.name);
const status = await api('/status');

// When the gateway refuses a change for the user's role, the CMS's error dialog says that saving
// failed and to try again later. The dialog quotes the gateway's message; once it does, it says that
// the role does not allow the change instead.
const refusals = new Set();
const REFUSED = 'Ihre Rolle erlaubt diese Änderung nicht. Sie wurde nicht gespeichert. ';
const fetchOf = window.fetch;
window.fetch = async (...args) => {
  const response = await fetchOf(...args);
  if (response.status === 403 && new URL(response.url).pathname.startsWith('/api/werft/')) {
    response.clone().json().then(({ message }) => message && refusals.add(message), () => {});
  }
  return response;
};
new MutationObserver(() => {
  for (const dialog of document.querySelectorAll('dialog[role="alertdialog"]')) {
    const body = dialog.querySelector('[id$="-body"]');
    const detail = body?.querySelector('.error');
    if (!detail || !refusals.has(detail.textContent.trim())) continue;
    const title = dialog.querySelector('[id$="-title"]');
    if (title && title.textContent !== 'Nicht erlaubt') title.textContent = 'Nicht erlaubt';
    const text = [...body.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (text && text.textContent !== REFUSED) text.textContent = REFUSED;
  }
}).observe(document.body, { childList: true, subtree: true });

window.CMS_MANUAL_INIT = true;
await new Promise((resolve, reject) => {
  const script = Object.assign(document.createElement('script'), { src: './vendor/sveltia-cms.js', onload: resolve, onerror: reject });
  document.head.append(script);
});
const { CMS } = window;

registerPreviews({ CMS, site, theme, base, branch: status.branch });
CMS.registerEventListener({ name: 'postSave', handler: () => { forgetContent(); } });
CMS.init({ config: cmsConfig({ site, theme, origin: location.origin, branch: status.branch, editable: me.editable, statuses: me.statuses }) });
toolbar(me, 'Inhalte');

// Publishing scheduled entries needs a rebuild once they are due; every visit to the admin checks.
api('/tick').catch(() => {});

// The CMS can sign out and in again on its own; the configuration follows the user's role, so a
// different user starts over. Renewed tokens of the same user change nothing.
const userOf = (token) => { try { return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return null; } };
setInterval(() => {
  const token = stored().token;
  if (!token) location.href = './';
  else if (userOf(token) !== me.email) location.reload();
}, 2000);
