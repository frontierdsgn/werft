// Session of the werft admin. The tokens live where Sveltia CMS keeps its signed-in user, so the CMS
// signs in automatically with the same session and renews it with the same refresh token.
const KEY = 'sveltia-cms.user';

export const stored = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
export const store = (tokens) => localStorage.setItem(KEY, JSON.stringify({ ...stored(), backendName: 'gitea', token: tokens.access_token, refreshToken: tokens.refresh_token }));
export const signOut = () => localStorage.removeItem(KEY);

async function refresh() {
  const { refreshToken } = stored();
  if (!refreshToken) return false;
  const response = await fetch('/api/werft/login/oauth/access_token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: 'werft', refresh_token: refreshToken }),
  });
  if (!response.ok) return false;
  store(await response.json());
  return true;
}

// Calls the gateway with the stored token, renewing it once when it has expired.
export async function api(path, { method = 'GET', body, raw = false } = {}, retried = false) {
  const response = await fetch(`/api/werft${path}`, {
    method,
    headers: { authorization: `token ${stored().token ?? ''}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401 && !retried && (await refresh())) return api(path, { method, body, raw }, true);
  if (raw) return response;
  const data = (response.headers.get('content-type') ?? '').includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw Object.assign(new Error(data?.message ?? response.statusText), { status: response.status });
  return data;
}

// Resolves with the signed-in user, showing the sign-in form first when there is no valid session.
export async function requireUser(siteName) {
  try { return await api('/me'); } catch (error) { if (error.status !== 401) throw error; }
  const form = document.createElement('form');
  form.className = 'werft-login';
  form.innerHTML = `<h1>Anmelden</h1><p></p><label for="werft-email">E-Mail</label><input id="werft-email" type="email" autocomplete="username" required>
    <label for="werft-password">Passwort</label><input id="werft-password" type="password" autocomplete="current-password" required>
    <p class="werft-error" role="alert"></p><button type="submit">Anmelden</button>`;
  form.querySelector('p').textContent = `${siteName} · Redaktion`;
  document.body.append(form);
  form.querySelector('input').focus();
  return new Promise((resolve) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = form.querySelector('.werft-error');
      error.textContent = '';
      const response = await fetch('/api/werft/session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: form.querySelector('#werft-email').value, password: form.querySelector('#werft-password').value }),
      });
      const data = await response.json();
      if (!response.ok) { error.textContent = data.message; return; }
      store(data);
      form.remove();
      resolve(await api('/me'));
    });
  });
}

export async function loadSite() {
  const configURL = new URL('./site/werft.config.js', import.meta.url);
  const site = (await import(configURL)).default;
  const theme = (await import(new URL(site.theme, configURL))).default;
  return { site, theme, base: site.base ? `/${site.base.replace(/^\/+|\/+$/g, '')}/` : '/' };
}

// Small bar with werft's own pages next to the CMS.
export function toolbar(me, current) {
  const nav = document.createElement('nav');
  nav.className = 'werft-bar';
  nav.setAttribute('aria-label', 'werft');
  const links = [['./', 'Inhalte'], ['revisions.html', 'Versionen'], ...(me.role === 'administrator' ? [['users.html', 'Benutzer']] : [])];
  nav.innerHTML = links.map(([href, label]) => `<a href="${href}"${label === current ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  // Sveltia CMS gives every link to another page target="_blank" when the mouse is pressed on it
  // (a mousedown listener on the body); werft's pages open in the same tab.
  nav.addEventListener('mousedown', (event) => event.stopPropagation());
  const out = document.createElement('button');
  out.type = 'button';
  out.textContent = 'Abmelden';
  out.addEventListener('click', () => { signOut(); location.href = './'; });
  nav.append(out);
  document.body.append(nav);
}
