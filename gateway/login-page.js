// Sign-in page of the OAuth authorize endpoint, shown in the popup Sveltia opens when a session has
// expired. The admin's first sign-in uses the same form inside the admin page.
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const LOGIN_STYLE = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ec;color:#231f1b;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
form{width:min(360px,calc(100vw - 32px));background:#fff;padding:28px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 20px;color:#5c554d}label{display:block;font-weight:600;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;font:inherit;padding:9px 11px;border:1px solid #b9b1a6;border-radius:4px}
button{margin-top:20px;width:100%;font:inherit;font-weight:700;padding:10px;border:0;border-radius:4px;background:#231f1b;color:#fff;cursor:pointer}
.error{color:#a3271b;margin:12px 0 0;min-height:1.5em}input:focus-visible,button:focus-visible{outline:3px solid #d9a521;outline-offset:2px}`;

export function loginPage({ site, query, email = '', failed = false }) {
  const hidden = Object.entries(query).map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Anmelden · ${escape(site)}</title><style>${LOGIN_STYLE}</style></head><body>
<form method="post">${hidden}<h1>Anmelden</h1><p>${escape(site)} · Redaktion</p>
<label for="email">E-Mail</label><input id="email" name="email" type="email" autocomplete="username" required value="${escape(email)}" autofocus>
<label for="password">Passwort</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<p class="error" role="alert">${failed ? 'E-Mail oder Passwort stimmt nicht.' : ''}</p><button type="submit">Anmelden</button></form></body></html>`;
}
