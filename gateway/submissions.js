// Form submissions: visitors send a form of content/forms/ to the gateway, which keeps each one as a
// file on the repository's branch werft-submissions, away from the site's own history. The files lie
// under .werft/submissions/, which the build never reads; administrators and editors read and delete
// them on the admin's "Einsendungen" page. Deleting rewrites that branch as one new commit without
// history (or deletes it when nothing is left), so a deleted submission is in no branch any more.
//
//   POST /api/werft/forms/<form>     public; form fields (urlencoded, multipart or JSON)
//   GET  /api/werft/submissions      every form with its submissions, newest first
//   POST /api/werft/submissions      { delete: ['<form>/<id>', …] }, one commit
//
// Fields whose name starts with "_" are not stored. A filled-in "_gotcha" (a field hidden from
// people) marks a bot: it gets the success reply and nothing is stored. "_redirect" sends a plain
// form post on to that path of the page's site; without it the visitor gets a short thank-you page.
// With a Turnstile secret, a submission needs a valid "cf-turnstile-response" (Cloudflare's widget
// adds it to the form). Each form takes at most PER_HOUR submissions an hour.
//
// With an e-mail driver, a stored submission is sent to the addresses in the form's `notify.to`,
// with the visitor's address as reply-to. With `notify.confirm`, the visitor gets a confirmation
// holding only the form's own text (never what was sent, so nobody can mail others through the
// site), at most one a day per address: a confirmed submission's id carries a keyed hash of the
// address. A failed e-mail is logged; the submission is kept.
import { editable } from './roles.js';
import { isAddress } from './mail.js';

export const SUBMISSIONS_BRANCH = 'werft-submissions';
export const SUBMISSIONS_DIR = '.werft/submissions';
const MAX_FIELDS = 50;
const MAX_CHARS = 20000;
const MAX_BYTES = 64 * 1024;
const PER_HOUR = 60;
const DAY = 24 * 3600 * 1000;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
const ID = /^[0-9TZ]+-[0-9a-f]{8}$/;
const TURNSTILE = 'cf-turnstile-response';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// A submission's id starts with its time, so ids sort by time: 20260601T120000Z-1a2b3c4d.
const stamp = (time) => new Date(time).toISOString().replace(/[-:]|\.\d+/g, '');
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// The visitor's address: a field named email (e-mail, mail), else the first field holding one.
function visitorOf(fields) {
  const values = Object.entries(fields).filter(([, v]) => typeof v === 'string').map(([name, v]) => [name, v.trim()]);
  return (values.find(([name, v]) => /^(e-?)?mail$/i.test(name) && isAddress(v)) ?? values.find(([, v]) => isAddress(v)))?.[1] ?? null;
}

// The submission as plain text, one field per line; lines of a longer text are indented.
const listing = (fields) => Object.entries(fields).map(([name, value]) => `${name}: ${[value].flat().join(', ').replace(/\r\n?/g, '\n').replace(/\n/g, '\n  ')}`).join('\n');

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

export function submissions({ storage, branch, site, now, secret, mail, turnstileSecret, fetch: request = (...args) => fetch(...args) }) {
  // A form's definition: in the default language, else in another language of the site (a
  // translated form keeps its name, so its submissions are kept with the original's).
  const formDirs = [site.contentDir, ...(site.languages ?? []).slice(1).map((l) => `${site.contentDir}/${l}`)];
  const slugOfForm = (path) => formDirs.map((dir) => path.startsWith(`${dir}/forms/`) && /^([^/]+)\.json$/.exec(path.slice(dir.length + 7))?.[1]).find(Boolean);
  const definitionOf = async (sha, slug) => {
    for (const dir of formDirs) { const bytes = await storage.read(sha, `${dir}/forms/${slug}.json`); if (bytes) return bytes; }
    return null;
  };
  const readMany = (sha, paths) => (storage.readMany ? storage.readMany(sha, paths) : Promise.all(paths.map((p) => storage.read(sha, p))));
  // The submissions branch's head, null before the first submission.
  const head = () => storage.head(SUBMISSIONS_BRANCH).then(({ sha }) => sha, (e) => { if (e.status === 404) return null; throw e; });
  const sentAt = async (sha) => (sha ? (await storage.tree(sha)).map((e) => e.path).filter((p) => p.startsWith(`${SUBMISSIONS_DIR}/`) && p.endsWith('.json')) : []);

  // Commits on the newest head, again when another submission or deletion came first. Without
  // any submission left, the branch is deleted.
  async function commit(message, changes, squash = false) {
    for (let attempt = 1; ; attempt++) {
      const parent = await head();
      try {
        const removed = new Set(changes.filter((c) => !c.data).map((c) => c.path));
        if (squash && (await sentAt(parent)).every((p) => removed.has(p))) return await storage.removeBranch(SUBMISSIONS_BRANCH, parent);
        return await storage.commit({ branch: SUBMISSIONS_BRANCH, parent, squash, message, author: { name: 'werft', email: 'forms@werft.invalid' }, changes });
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
    // The page takes the language of the page the form was on (a folder named after one of the
    // site's languages); its text is German and marked so. A thank-you page in the visitor's
    // language comes through _redirect.
    const languages = site.languages ?? [];
    const lang = languages.slice(1).find((l) => referer?.pathname.split('/').includes(l)) ?? languages[0] ?? 'de';
    const body = `<!doctype html><html lang="${escapeHTML(lang)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHTML(site.name ?? '')}</title><body style="font:17px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px"><main lang="de"><p>${escapeHTML(message)}</p>${back}</main></body></html>`;
    return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }

  // Four hex digits of a keyed hash of the address: they start the random part of a confirmed
  // submission's id, so the tree shows who was confirmed lately without storing the address again.
  async function tagOf(address) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`confirmation:${address.toLowerCase()}`))).subarray(0, 2));
  }

  async function inform({ form, title, fields, visitor, confirm }) {
    const fromName = site.name;
    const to = String(form.notify?.to ?? '').split(/[\s,;]+/).filter(isAddress);
    const sending = [];
    if (to.length) {
      const text = `Über das Formular „${title}“ kam eine neue Einsendung:\n\n${listing(fields)}\n\nAlle Einsendungen stehen im Editor unter „Einsendungen“.${visitor ? `\nEine Antwort auf diese E-Mail geht an ${visitor}.` : ''}\n`;
      sending.push(mail.send({ to, subject: `Neue Einsendung: ${oneLine(title)}`, text, ...(visitor && { replyTo: visitor }), fromName }));
    }
    if (confirm) {
      const subject = oneLine(form.notify.confirm_subject) || (site.name ? `Ihre Nachricht an ${oneLine(site.name)}` : 'Ihre Nachricht ist angekommen');
      const text = String(form.notify.confirm_text ?? '').trim() || `Vielen Dank, Ihre Nachricht ist angekommen.${site.name ? `\n\n${site.name}` : ''}`;
      sending.push(mail.send({ to: visitor, subject, text: `${text}\n`, fromName }));
    }
    for (const result of await Promise.allSettled(sending)) {
      if (result.status === 'rejected') console.error('werft forms: e-mail not sent:', result.reason?.message ?? result.reason);
    }
  }

  // Cloudflare Turnstile's server-side check of the widget's token.
  async function human(fields, incoming) {
    const token = [fields[TURNSTILE]].flat()[0];
    if (!token) return false;
    const body = new URLSearchParams({ secret: turnstileSecret, response: token });
    const ip = incoming.headers.get('cf-connecting-ip');
    if (ip) body.set('remoteip', ip);
    const response = await request('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    return response.ok && (await response.json()).success === true;
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
    if (turnstileSecret && !(await human(fields, request))) return reply(request, url, 403, 'Die Sicherheitsprüfung hat nicht geklappt. Bitte die Seite neu laden und noch einmal senden.');
    const kept = Object.fromEntries(Object.entries(fields).filter(([name]) => !name.startsWith('_') && name !== TURNSTILE));
    const chars = Object.entries(kept).flat(2).join('').length;
    if (Object.keys(kept).length > MAX_FIELDS || chars > MAX_CHARS) return reply(request, url, 413, 'Die Nachricht ist zu lang.');
    if (!Object.values(kept).flat().some((v) => v.trim())) return reply(request, url, 422, 'Das Formular ist leer.');
    const definition = await definitionOf((await storage.head(branch)).sha, slug);
    if (!definition) return reply(request, url, 404, 'Dieses Formular gibt es nicht.');
    const sent = await sentAt(await head());
    const hourAgo = stamp(now() - 3600 * 1000);
    const recent = sent.filter((p) => p.startsWith(`${SUBMISSIONS_DIR}/${slug}/`) && p.split('/').pop().slice(0, hourAgo.length) > hourAgo);
    if (recent.length >= PER_HOUR) return reply(request, url, 429, 'Gerade kommen sehr viele Nachrichten an. Bitte in einer Stunde noch einmal versuchen.');
    const form = (() => { try { return JSON.parse(decoder.decode(definition)) ?? {}; } catch { return {}; } })();
    const title = form.title ?? slug;
    const visitor = visitorOf(kept);
    const tag = mail && form.notify?.confirm && visitor ? await tagOf(visitor) : null;
    const dayAgo = stamp(now() - DAY);
    // Any form's confirmed submission of the last day with the same tag. Rarely another submission's
    // random part starts the same and this one goes unconfirmed; two at the same moment from one
    // address may both be confirmed (each reads the tree before either commits).
    const confirm = !!tag && !sent.some((p) => { const [time, random] = p.split('/').pop().split('-'); return time > dayAgo && random.startsWith(tag); });
    const received = new Date(now()).toISOString();
    const random = `${confirm ? tag : ''}${hex(crypto.getRandomValues(new Uint8Array(confirm ? 2 : 4)))}`;
    const data = encoder.encode(`${JSON.stringify({ form: slug, received_at: received, fields: kept }, null, 2)}\n`);
    await commit(`Einsendung: ${title}`, [{ path: `${SUBMISSIONS_DIR}/${slug}/${stamp(received)}-${random}.json`, data }]);
    if (mail) await inform({ form, title, fields: kept, visitor, confirm });
    return reply(request, url, 201, thanks, redirect);
  }

  async function api(request, user) {
    if (!editable(user.role).includes('content')) return json({ message: 'Nur Administratoren und Redakteure sehen Einsendungen.' }, 403);
    if (request.method === 'POST') {
      const wanted = (await request.json()).delete ?? [];
      if (!wanted.length) return json({ message: 'Keine Einsendung ausgewählt.' }, 422);
      const paths = new Set(await sentAt(await head()));
      for (const ref of wanted) {
        const [slug, id, ...rest] = String(ref).split('/');
        if (rest.length || !SLUG.test(slug ?? '') || !ID.test(id ?? '') || !paths.has(`${SUBMISSIONS_DIR}/${slug}/${id}.json`)) return json({ message: `Einsendung ${ref} nicht gefunden.` }, 404);
      }
      await commit(`Einsendung${wanted.length === 1 ? '' : 'en'} gelöscht (${wanted.length})`, wanted.map((ref) => ({ path: `${SUBMISSIONS_DIR}/${ref}.json`, data: null })), true);
    }
    // After a deletion too, so the page shows what is left.
    const main = (await storage.head(branch)).sha;
    const tree = (await storage.tree(main)).map((e) => e.path);
    const forms = [...new Set(tree.map(slugOfForm).filter(Boolean))];
    const at = await head();
    const sent = await sentAt(at);
    // The title in the default language where the form has one.
    const titles = await readMany(main, forms.map((slug) => formDirs.map((dir) => `${dir}/forms/${slug}.json`).find((p) => tree.includes(p))));
    const texts = at ? await readMany(at, sent) : [];
    const parse = (bytes) => { try { return JSON.parse(decoder.decode(bytes)); } catch { return null; } };
    const bySlug = new Map(forms.map((slug, i) => [slug, { slug, title: parse(titles[i])?.title ?? slug, submissions: [] }]));
    sent.forEach((path, i) => {
      const [slug, file] = path.slice(SUBMISSIONS_DIR.length + 1).split('/');
      const entry = parse(texts[i]);
      if (!file || !entry) return;
      if (!bySlug.has(slug)) bySlug.set(slug, { slug, title: slug, submissions: [] });
      bySlug.get(slug).submissions.push({ id: `${slug}/${file.slice(0, -5)}`, received_at: entry.received_at, fields: entry.fields ?? {} });
    });
    for (const form of bySlug.values()) form.submissions.sort((a, b) => (a.received_at < b.received_at ? 1 : -1));
    return json({ forms: [...bySlug.values()] });
  }

  return { receive, api };
}
