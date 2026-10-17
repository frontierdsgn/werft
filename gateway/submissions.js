// Form submissions: visitors send a form of content/forms/ to the gateway, which keeps each one as a
// file in the site's repository. The files lie under .werft/, which the file API never shows and the
// build never reads; administrators and editors read and delete them on the admin's
// "Einsendungen" page.
//
//   POST /api/werft/forms/<form>     public; form fields (urlencoded, multipart or JSON)
//   GET  /api/werft/submissions      every form with its submissions, newest first
//   POST /api/werft/submissions      { delete: ['<form>/<id>', …] }, one commit
//
// Fields whose name starts with "_" are not stored. A filled-in "_gotcha" (a field hidden from
// people) marks a bot: it gets the success reply and nothing is stored. "_redirect" sends a plain
// form post on to that path of the page's site; without it the visitor gets a short thank-you page.
import { editable } from './roles.js';

export const SUBMISSIONS_DIR = '.werft/submissions';
const MAX_FIELDS = 50;
const MAX_CHARS = 20000;
const MAX_BYTES = 64 * 1024;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
const ID = /^[0-9TZ]+-[0-9a-f]{8}$/;

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The fields of a submission: repeated names (checkboxes) become lists, files are left out.
async function readFields(request) {
  const type = request.headers.get('content-type') ?? '';
  const fields = {};
  if (type.includes('json')) {
    for (const [name, value] of Object.entries(await request.json())) fields[name] = Array.isArray(value) ? value.map(String) : String(value ?? '');
    return fields;
  }
  for (const [name, value] of await request.formData()) {
    if (typeof value !== 'string') continue;
    fields[name] = name in fields ? [fields[name]].flat().concat(value) : value;
  }
  return fields;
}

export function submissions({ storage, branch, site, now }) {
  const formFile = (slug) => `${site.contentDir}/forms/${slug}.json`;
  const formPath = new RegExp(`^${site.contentDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/forms/([^/]+)\\.json$`);
  const readMany = (sha, paths) => (storage.readMany ? storage.readMany(sha, paths) : Promise.all(paths.map((p) => storage.read(sha, p))));

  // Commits on the newest head, again when another save came first.
  async function commit(message, changes) {
    for (let attempt = 1; ; attempt++) {
      const { sha } = await storage.head(branch);
      try {
        return await storage.commit({ branch, parent: sha, message, author: { name: 'werft', email: 'forms@werft.invalid' }, changes: changes(sha) });
      } catch (e) {
        if (e.status !== 409 || attempt === 3) throw e;
      }
    }
  }

  // A plain form post gets a page, a script (Accept: application/json) gets JSON.
  function reply(request, url, status, message, redirect) {
    if ((request.headers.get('accept') ?? '').includes('application/json')) return json(status < 300 ? { ok: true } : { message }, status);
    // The page the form was on, so a form on another host (PHP web space) leads back there.
    const referer = (() => { try { return new URL(request.headers.get('referer')); } catch { return null; } })();
    if (status < 300 && redirect) return new Response(null, { status: 303, headers: { location: new URL(redirect, referer ?? url).href } });
    const back = referer ? `<p><a href="${escapeHTML(referer.href)}">Zurück</a></p>` : '';
    const body = `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHTML(site.name ?? '')}</title><body style="font:17px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px"><p>${escapeHTML(message)}</p>${back}</body></html>`;
    return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }

  async function receive(request, url, slug) {
    if (request.method !== 'POST') return reply(request, url, 405, 'Formulare werden per POST gesendet.');
    if (!SLUG.test(slug)) return reply(request, url, 404, 'Dieses Formular gibt es nicht.');
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES) return reply(request, url, 413, 'Die Nachricht ist zu lang.');
    let fields;
    try { fields = await readFields(request); } catch { return reply(request, url, 400, 'Das Formular konnte nicht gelesen werden.'); }
    const redirect = typeof fields._redirect === 'string' && /^\/(?![/\\])/.test(fields._redirect) ? fields._redirect : null;
    const thanks = 'Vielen Dank, Ihre Nachricht ist angekommen.';
    if (fields._gotcha) return reply(request, url, 200, thanks, redirect);
    const kept = Object.fromEntries(Object.entries(fields).filter(([name]) => !name.startsWith('_')));
    const chars = Object.entries(kept).flat(2).join('').length;
    if (Object.keys(kept).length > MAX_FIELDS || chars > MAX_CHARS) return reply(request, url, 413, 'Die Nachricht ist zu lang.');
    if (!Object.values(kept).flat().some((v) => v.trim())) return reply(request, url, 422, 'Das Formular ist leer.');
    const { sha } = await storage.head(branch);
    const definition = await storage.read(sha, formFile(slug));
    if (!definition) return reply(request, url, 404, 'Dieses Formular gibt es nicht.');
    const title = (() => { try { return JSON.parse(decoder.decode(definition)).title; } catch { return null; } })() ?? slug;
    const received = new Date(now()).toISOString();
    const random = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const id = `${received.replace(/[-:]|\.\d+/g, '')}-${random}`;
    const data = encoder.encode(`${JSON.stringify({ form: slug, received_at: received, fields: kept }, null, 2)}\n`);
    await commit(`Einsendung: ${title}`, () => [{ path: `${SUBMISSIONS_DIR}/${slug}/${id}.json`, data }]);
    return reply(request, url, 201, thanks, redirect);
  }

  async function api(request, user) {
    if (!editable(user.role).includes('content')) return json({ message: 'Nur Administratoren und Redakteure sehen Einsendungen.' }, 403);
    if (request.method === 'POST') {
      const wanted = (await request.json()).delete ?? [];
      if (!wanted.length) return json({ message: 'Keine Einsendung ausgewählt.' }, 422);
      const paths = new Set((await storage.tree((await storage.head(branch)).sha)).map((e) => e.path));
      for (const ref of wanted) {
        const [slug, id, ...rest] = String(ref).split('/');
        if (rest.length || !SLUG.test(slug ?? '') || !ID.test(id ?? '') || !paths.has(`${SUBMISSIONS_DIR}/${slug}/${id}.json`)) return json({ message: `Einsendung ${ref} nicht gefunden.` }, 404);
      }
      await commit(`Einsendung${wanted.length === 1 ? '' : 'en'} gelöscht (${wanted.length})`, () => wanted.map((ref) => ({ path: `${SUBMISSIONS_DIR}/${ref}.json`, data: null })));
    }
    // After a deletion too, so the page shows what is left.
    const { sha } = await storage.head(branch);
    const files = (await storage.tree(sha)).map((e) => e.path);
    const forms = files.map((p) => formPath.exec(p)?.[1]).filter(Boolean);
    const sent = files.filter((p) => p.startsWith(`${SUBMISSIONS_DIR}/`) && p.endsWith('.json'));
    const texts = await readMany(sha, [...forms.map(formFile), ...sent]);
    const parse = (bytes) => { try { return JSON.parse(decoder.decode(bytes)); } catch { return null; } };
    const bySlug = new Map(forms.map((slug, i) => [slug, { slug, title: parse(texts[i])?.title ?? slug, submissions: [] }]));
    sent.forEach((path, i) => {
      const [slug, file] = path.slice(SUBMISSIONS_DIR.length + 1).split('/');
      const entry = parse(texts[forms.length + i]);
      if (!file || !entry) return;
      if (!bySlug.has(slug)) bySlug.set(slug, { slug, title: slug, submissions: [] });
      bySlug.get(slug).submissions.push({ id: `${slug}/${file.slice(0, -5)}`, received_at: entry.received_at, fields: entry.fields ?? {} });
    });
    for (const form of bySlug.values()) form.submissions.sort((a, b) => (a.received_at < b.received_at ? 1 : -1));
    return json({ forms: [...bySlug.values()] });
  }

  return { receive, api };
}
