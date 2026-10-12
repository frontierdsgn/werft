// Versions of each content file, compared with the current one and restorable. Restoring is an
// ordinary save, so it is itself a new version and the gateway checks the role as for any change.
import { requireUser, loadSite, toolbar, api } from './session.js';
import { versionDiff, diffHTML } from './diff.js';

const REPO = '/api/v1/repos/werft/site';
const { site, theme } = await loadSite();
const me = await requireUser(site.name);
const { branch } = await api('/status');
toolbar(me, 'Versionen');
document.querySelector('main').hidden = false;

const $ = (s) => document.querySelector(s);
const escapeHTML = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const dateTime = (iso) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
const contentDir = site.contentDir ?? site.content ?? 'content';
const groups = { pages: 'Seite', patterns: 'Muster', forms: 'Formular', settings: 'Einstellungen', ...(theme.postType && { [theme.postType.name]: theme.postType.singular }) };

async function readAt(ref, path) {
  const response = await api(`${REPO}/raw/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, { raw: true });
  return response.ok ? response.text() : null;
}

const { tree } = await api(`${REPO}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
const files = tree.map((e) => e.path).filter((p) => p.startsWith(`${contentDir}/`) && p.endsWith('.json')).sort();
$('#path').innerHTML = files.map((p) => {
  const [group, ...rest] = p.slice(contentDir.length + 1).split('/');
  return `<option value="${escapeHTML(p)}">${escapeHTML(groups[group] ?? group)}: ${escapeHTML(rest.join('/').replace(/\.json$/, ''))}</option>`;
}).join('');
const wanted = new URLSearchParams(location.search).get('path');
if (wanted && files.includes(wanted)) $('#path').value = wanted;

let selected;
async function showHistory() {
  const path = $('#path').value;
  $('#compare').hidden = true;
  const commits = await api(`${REPO}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&limit=100`);
  $('#history').innerHTML = commits.map((c, i) => `<tr><td>${dateTime(c.commit.author.date)}</td><td>${escapeHTML(c.commit.author.name)}</td><td>${escapeHTML(c.commit.message.split('\n')[0])}</td>
    <td>${i === 0 ? '<span class="note">aktuell</span>' : `<button type="button" class="secondary" data-sha="${c.sha}" data-date="${c.commit.author.date}">Vergleichen</button>`}</td></tr>`).join('');
}

$('#path').addEventListener('change', showHistory);
$('#history').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-sha]');
  if (!button) return;
  const path = $('#path').value;
  const [old, current] = await Promise.all([readAt(button.dataset.sha, path), readAt(branch, path)]);
  selected = { path, text: old };
  $('#compare-title').textContent = `Version vom ${dateTime(button.dataset.date)} im Vergleich zur aktuellen`;
  const lines = versionDiff(current ?? '', old ?? '');
  $('#diff').innerHTML = lines.some(([kind]) => kind !== ' ') ? diffHTML(lines) : '<span class="note">Keine inhaltlichen Unterschiede.</span>';
  $('#error').textContent = '';
  $('#compare').hidden = false;
  $('#compare').scrollIntoView({ block: 'start' });
});

$('#restore').addEventListener('click', async () => {
  const { path, text } = selected;
  try {
    const { sha } = await api(`${REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`);
    const content = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
    await api(`${REPO}/contents`, { method: 'POST', body: { branch, message: `Wiederhergestellt: ${path}`, files: [{ operation: 'update', path, content, sha }] } });
    await showHistory();
  } catch (error) {
    $('#error').textContent = error.message;
  }
});

await showHistory();
