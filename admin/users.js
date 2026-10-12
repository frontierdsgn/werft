// User management for administrators. Each change is a commit of .werft/users.json by the gateway.
import { requireUser, loadSite, toolbar, api } from './session.js';

const { site } = await loadSite();
const me = await requireUser(site.name);
toolbar(me, 'Benutzer');
const $ = (s) => document.querySelector(s);
const escapeHTML = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const form = $('#user-form');

if (me.role !== 'administrator') {
  document.querySelector('main').innerHTML = '<h1>Benutzer</h1><p>Nur Administratoren verwalten Benutzer.</p>';
} else {
  let { users, roles } = await api('/users');
  form.role.innerHTML = Object.entries(roles).map(([id, r]) => `<option value="${id}">${escapeHTML(r.label)}</option>`).join('');
  const render = () => {
    $('#users').innerHTML = users.map((u) => `<tr><td>${escapeHTML(u.name)}</td><td>${escapeHTML(u.email)}</td><td>${escapeHTML(roles[u.role]?.label ?? u.role)}</td>
      <td><button type="button" class="secondary" data-edit="${escapeHTML(u.email)}">Bearbeiten</button>
      ${u.email === me.email ? '' : `<button type="button" class="secondary" data-delete="${escapeHTML(u.email)}">Löschen</button>`}</td></tr>`).join('');
  };
  const send = async (body) => {
    $('#error').textContent = '';
    try { ({ users } = await api('/users', { method: 'POST', body })); render(); return true; } catch (error) { $('#error').textContent = error.message; return false; }
  };
  render();
  document.querySelector('main').hidden = false;
  $('#users').addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-edit]')?.dataset.edit;
    const remove = event.target.closest('[data-delete]')?.dataset.delete;
    if (edit) {
      const u = users.find((x) => x.email === edit);
      form.email.value = u.email; form.email.readOnly = true; form.name.value = u.name; form.role.value = u.role; form.password.value = '';
      form.password.placeholder = 'leer: unverändert';
      $('#form-title').textContent = `Benutzer bearbeiten: ${u.email}`;
      form.name.focus();
    }
    if (remove && confirm(`${remove} löschen?`)) await send({ action: 'delete', email: remove });
  });
  form.addEventListener('reset', () => { form.email.readOnly = false; form.password.placeholder = 'mind. 10 Zeichen'; $('#form-title').textContent = 'Benutzer anlegen'; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = { email: form.email.value, name: form.name.value, role: form.role.value, ...(form.password.value && { password: form.password.value }) };
    if (await send(body)) form.reset();
  });
}
