// Starts Sveltia CMS with a configuration derived from the site and the signed-in user's role.
import { cmsConfig } from 'werft/cms-config';
import { requireUser, loadSite, stored, toolbar, api } from './session.js';
import { registerPreviews, forgetContent } from './preview.js';

const { site, theme, base } = await loadSite();
const me = await requireUser(site.name);
const status = await api('/status');

window.CMS_MANUAL_INIT = true;
await new Promise((resolve, reject) => {
  const script = Object.assign(document.createElement('script'), { src: './vendor/sveltia-cms.js', onload: resolve, onerror: reject });
  document.head.append(script);
});
const { CMS } = window;

registerPreviews({ CMS, site, theme, base, branch: status.branch });
CMS.registerEventListener({ name: 'postSave', handler: () => { forgetContent(); } });
CMS.init({ config: cmsConfig({ site, theme, origin: location.origin, branch: status.branch, editable: me.editable }) });
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
