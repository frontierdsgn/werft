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

// Resolves with the signed-in user. Without a valid session it shows the sign-in form, with
// "Passwort vergessen?" where the site sends e-mail; the link in that e-mail (#passwort=…) opens the
// form for a new password, which signs in too.
export async function requireUser(siteName) {
  const resetToken = /^#passwort=([\w.-]+)$/.exec(location.hash)?.[1];
  if (!resetToken) { try { return await api('/me'); } catch (error) { if (error.status !== 401) throw error; } }
  const mailing = fetch('/api/werft/status').then((r) => r.json()).then((s) => !!s.mail, () => false);
  const post = async (path, body) => {
    const response = await fetch(`/api/werft${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
  };
  const form = document.createElement('form');
  form.className = 'werft-login';
  document.body.append(form);
  const field = (id, label, type, autocomplete) => `<label for="${id}">${label}</label><input id="${id}" type="${type}" autocomplete="${autocomplete}" required${type === 'password' && autocomplete === 'new-password' ? ' minlength="10"' : ''}>`;
  const $ = (selector) => form.querySelector(selector);
  return new Promise((resolve) => {
    const signedIn = async (data) => { token = data.access_token; form.remove(); resolve(await api('/me')); };
    const show = (mode) => {
      const title = { signin: 'Anmelden', forgot: 'Passwort vergessen?', reset: 'Neues Passwort' }[mode];
      form.innerHTML = `<h1>${title}</h1><p class="werft-lead"></p>${{
        signin: field('werft-email', 'E-Mail', 'email', 'username') + field('werft-password', 'Passwort', 'password', 'current-password'),
        forgot: field('werft-email', 'E-Mail', 'email', 'username'),
        reset: field('werft-email', 'E-Mail', 'email', 'username') + field('werft-password', 'Neues Passwort (mindestens 10 Zeichen)', 'password', 'new-password') + field('werft-repeat', 'Neues Passwort wiederholen', 'password', 'new-password'),
      }[mode]}<p class="werft-error" role="alert"></p><button type="submit">${{ signin: 'Anmelden', forgot: 'Link schicken', reset: 'Passwort festlegen' }[mode]}</button>`;
      $('.werft-lead').textContent = mode === 'forgot' ? 'Sie bekommen eine E-Mail mit einem Link, mit dem Sie ein neues Passwort festlegen.' : `${siteName} · Redaktion`;
      const switchTo = (to, text) => {
        if ([...form.querySelectorAll('.werft-link')].some((b) => b.textContent === text)) return;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'werft-link'; b.textContent = text; b.addEventListener('click', () => show(to)); form.append(b);
      };
      if (mode === 'signin') mailing.then((yes) => { if (yes && form.isConnected && $('#werft-password')) switchTo('forgot', 'Passwort vergessen?'); });
      if (mode !== 'signin') switchTo('signin', 'Zur Anmeldung');
      if (mode === 'reset') {
        // The account the link is for (from the token), so a password manager saves the new password for it.
        const email = $('#werft-email');
        try { email.value = JSON.parse(atob(resetToken.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).sub ?? ''; } catch { /* shown empty */ }
        email.readOnly = true;
        email.required = false;
        $('#werft-password').focus();
      } else $('input').focus();
      const error = $('.werft-error');
      form.onsubmit = async (event) => {
        event.preventDefault();
        error.textContent = '';
        error.classList.remove('werft-done');
        if (mode === 'signin') {
          const email = $('#werft-email').value.trim().toLowerCase();
          const { ok, data } = await post('/session', { email, password: $('#werft-password').value, device: devices()[email] });
          if (!ok) { error.textContent = data.message; return; }
          if (data.device) localStorage.setItem(DEVICES, JSON.stringify({ ...devices(), [email]: data.device }));
          return signedIn(data);
        }
        if (mode === 'forgot') {
          const { ok, data } = await post('/password/forgot', { email: $('#werft-email').value.trim() });
          error.textContent = data.message ?? '';
          error.classList.toggle('werft-done', ok);
          return;
        }
        if ($('#werft-password').value !== $('#werft-repeat').value) { error.textContent = 'Die beiden Passwörter sind nicht gleich.'; return; }
        const { ok, status, data } = await post('/password/reset', { token: resetToken, password: $('#werft-password').value });
        if (!ok) {
          error.textContent = data.message;
          if (status === 410) switchTo('forgot', 'Neuen Link anfordern');
          return;
        }
        history.replaceState(null, '', location.pathname + location.search);
        return signedIn(data);
      };
    };
    show(resetToken ? 'reset' : 'signin');
  });
}

export async function loadSite() {
  const configURL = new URL('./site/werft.config.js', import.meta.url);
  const site = (await import(configURL)).default;
  const theme = (await import(new URL(site.theme, configURL))).default;
  return { site, theme, base: site.base ? `/${site.base.replace(/^\/+|\/+$/g, '')}/` : '/' };
}
