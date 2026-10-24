// Session of the werft admin: the access token lives in this page only; the gateway keeps the
// refresh token in an HttpOnly cookie, which renews it after a reload or once it has expired.
let token = null;
// werft 0.5 kept both tokens in localStorage; its refresh token is used once, then removed.
const LEGACY = 'werft.session';
// Device tokens by e-mail: they outlive a sign-out, so this browser's attempts keep their own count
// of failed sign-ins (see gateway/throttle.js).
const DEVICES = 'werft.devices';
const devices = () => { try { return JSON.parse(localStorage.getItem(DEVICES)) ?? {}; } catch { return {}; } };

// Ends the session on the server too; { everywhere: true } ends all of the user's sessions. Throws
// when the gateway could not record it; the access token stays, so the page can try again.
export async function signOut({ everywhere = false } = {}) {
  const response = await fetch('/api/werft/session', { method: 'DELETE', headers: { authorization: `token ${token ?? ''}`, 'content-type': 'application/json' }, body: JSON.stringify({ everywhere }) })
    .catch(() => null);
  if (!response?.ok) throw new Error((await response?.json().catch(() => null))?.message ?? 'Die Abmeldung hat nicht geklappt. Bitte noch einmal versuchen.');
  token = null;
  localStorage.removeItem(LEGACY);
}

async function refresh() {
  const legacy = (() => { try { return JSON.parse(localStorage.getItem(LEGACY))?.refreshToken; } catch { return undefined; } })();
  const response = await fetch('/api/werft/login/oauth/access_token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: 'werft', ...(legacy && { refresh_token: legacy }) }),
  });
  localStorage.removeItem(LEGACY);
  if (!response.ok) return false;
  token = (await response.json()).access_token;
  return true;
}

// Calls the gateway with the session's access token, renewing it once when it has expired.
export async function api(path, { method = 'GET', body, raw = false } = {}, retried = false) {
  const response = await fetch(`/api/werft${path}`, {
    method,
    headers: { authorization: `token ${token ?? ''}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
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
      const email = form.querySelector('#werft-email').value.trim().toLowerCase();
      const response = await fetch('/api/werft/session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: form.querySelector('#werft-password').value, device: devices()[email] }),
      });
      const data = await response.json();
      if (!response.ok) { error.textContent = data.message; return; }
      token = data.access_token;
      if (data.device) localStorage.setItem(DEVICES, JSON.stringify({ ...devices(), [email]: data.device }));
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
