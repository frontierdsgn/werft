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
// form post on to that path of the page's site; without it the visitor gets a short thank-you page
// in the language of the page the form was on (see TEXTS), which "_lang" may name.
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
import { say, messages } from './messages.js';

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
const parse = (bytes) => { try { return JSON.parse(decoder.decode(bytes)); } catch { return null; } };
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

// What visitors read, by language. A text comes from the form in the page's language (`thanks`,
// `notify.confirm_subject`, `notify.confirm_text`), else from here, else from the form in the
// default language, else from here in German.
const TEXTS = {
  de: {
    thanks: 'Vielen Dank, Ihre Nachricht ist angekommen.', back: 'Zurück', post: 'Formulare werden per POST gesendet.',
    missing: 'Dieses Formular gibt es nicht.', long: 'Die Nachricht ist zu lang.', unreadable: 'Das Formular konnte nicht gelesen werden.',
    check: 'Die Sicherheitsprüfung hat nicht geklappt. Bitte die Seite neu laden und noch einmal senden.', empty: 'Das Formular ist leer.',
    busy: 'Gerade kommen sehr viele Nachrichten an. Bitte in einer Stunde noch einmal versuchen.',
    confirmSubject: (name) => (name ? `Ihre Nachricht an ${name}` : 'Ihre Nachricht ist angekommen'),
    confirmText: (name) => `Vielen Dank, Ihre Nachricht ist angekommen.${name ? `\n\n${name}` : ''}`,
  },
  en: {
    thanks: 'Thank you, your message has arrived.', back: 'Back', post: 'Forms are sent with POST.',
    missing: 'This form does not exist.', long: 'The message is too long.', unreadable: 'The form could not be read.',
    check: 'The security check did not work. Please reload the page and send the form again.', empty: 'The form is empty.',
    busy: 'A great many messages are arriving right now. Please try again in an hour.',
    confirmSubject: (name) => (name ? `Your message to ${name}` : 'Your message has arrived'),
    confirmText: (name) => `Thank you, your message has arrived.${name ? `\n\n${name}` : ''}`,
  },
};
const builtIn = (lang, key) => (TEXTS[lang] ?? TEXTS[lang.split('-')[0].toLowerCase()])?.[key];

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

// localeOf(addresses): the admin language of the first of these addresses that is a user with one.
export function submissions({ storage, branch, site, now, secret, mail, turnstileSecret, localeOf, fetch: request = (...args) => fetch(...args) }) {
  // A form's definition: in the default language, else in another language of the site (a
  // translated form keeps its name, so its submissions are kept with the original's).
  const formDirs = [site.contentDir, ...(site.languages ?? []).slice(1).map((l) => `${site.contentDir}/${l}`)];
  const slugOfForm = (path) => formDirs.map((dir) => path.startsWith(`${dir}/forms/`) && /^([^/]+)\.json$/.exec(path.slice(dir.length + 7))?.[1]).find(Boolean);
  // With the language it is in (null for a site without languages).
  const definitionOf = async (sha, slug) => {
    for (const [i, dir] of formDirs.entries()) {
      const bytes = await storage.read(sha, `${dir}/forms/${slug}.json`);
      if (bytes) return { form: parse(bytes) ?? {}, lang: site.languages?.[i] ?? null };
    }
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

  const refererOf = (request) => { try { return new URL(request.headers.get('referer')); } catch { return null; } };

  // The language of the page the form was on: the field _lang if it names one of the site's
  // languages (a post from another host, such as PHP web space, carries only the origin as
  // referer), else a folder of the referer named after one of them, else the default language. A
  // site without languages has its settings' `lang`. main: the site branch's head, if known.
  async function languageOf(request, fields = {}, main = null) {
    const languages = site.languages ?? [];
    if (languages.length) {
      const named = [fields._lang].flat()[0];
      if (languages.includes(named)) return named;
      const path = refererOf(request)?.pathname.split('/') ?? [];
      return languages.slice(1).find((l) => path.includes(l)) ?? languages[0];
    }
    try {
      const settings = parse(await storage.read(main ?? (await storage.head(branch)).sha, `${site.contentDir}/settings/site.json`));
      return typeof settings?.lang === 'string' && /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(settings.lang) ? settings.lang : 'de';
    } catch (e) {
      console.error('werft forms: site settings not read:', e.message);
      return 'de';
    }
  }

  // The form's own texts for pick(): [in the page's language, in the form's language]. A
  // translation that still holds the original's text (the editor copies the whole form) has none
  // of its own.
  function ownTexts(local, form, get) {
    const text = (f) => { const t = f && get(f); return typeof t === 'string' && t.trim() ? t : null; };
    const [mine, base] = [text(local), text(form)];
    return [local !== form && mine?.trim() === base?.trim() ? null : mine, base];
  }

  // A text for the visitor and its language (see TEXTS); own: from ownTexts, base: the language
  // of the form's own definition.
  function pick(lang, key, own = [], base = null) {
    const choices = [[own[0], lang], [builtIn(lang, key), lang], [own[1], base ?? site.languages?.[0] ?? lang], [TEXTS.de[key], 'de']];
    const [value, language] = choices.find(([text]) => (typeof text === 'string' ? text.trim() : text));
    return { text: typeof value === 'function' ? value(site.name) : value.trim(), lang: language };
  }

  // A plain form post gets a page, a script (Accept: application/json) gets JSON. lang: the page's.
  function reply(request, url, status, lang, { text, lang: textLang }, redirect) {
    if ((request.headers.get('accept') ?? '').includes('application/json')) return json(status < 300 ? { ok: true } : { message: text }, status);
    // The page the form was on, so a form on another host (PHP web space) leads back there.
    const referer = refererOf(request);
    if (status < 300 && redirect) return new Response(null, { status: 303, headers: { location: new URL(redirect, referer ?? url).href } });
    const back = referer ? `<p><a href="${escapeHTML(referer.href)}">${escapeHTML(pick(lang, 'back').text)}</a></p>` : '';
    const main = textLang === lang ? '<main>' : `<main lang="${escapeHTML(textLang)}">`;
    const body = `<!doctype html><html lang="${escapeHTML(lang)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHTML(site.name ?? '')}</title><body style="font:17px/1.5 system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 16px">${main}<p>${escapeHTML(text).replace(/\r?\n/g, '<br>')}</p>${back}</main></body></html>`;
    return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }

  // Four hex digits of a keyed hash of the address: they start the random part of a confirmed
  // submission's id, so the tree shows who was confirmed lately without storing the address again.
  async function tagOf(address) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`confirmation:${address.toLowerCase()}`))).subarray(0, 2));
  }

  async function inform({ form, local, lang, base, title, fields, visitor, confirm }) {
    const fromName = site.name;
    const to = String(form.notify?.to ?? '').split(/[\s,;]+/).filter(isAddress);
    const sending = [];
    if (to.length) {
      // For the site's editors: in a recipient's admin language, else the site's first language
      // where the gateway has it, else German.
      const t = messages((await localeOf?.(to)) ?? site.languages?.[0]);
      const text = t('submissions.text', { title, fields: listing(fields), visitor });
      sending.push(mail.send({ to, subject: t('submissions.subject', { title: oneLine(title) }), text, ...(visitor && { replyTo: visitor }), fromName }));
    }
    if (confirm) {
      const own = (key) => ownTexts(local, form, (f) => f.notify?.[key]);
      const subject = oneLine(pick(lang, 'confirmSubject', own('confirm_subject'), base).text);
      const text = pick(lang, 'confirmText', own('confirm_text'), base).text;
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
    let lang, fields = {}, main = null;
    // A redirect and a script's { ok: true } show no text, so they need no language.
    const silent = (status, redirect) => status < 300 && (!!redirect || (request.headers.get('accept') ?? '').includes('application/json'));
    const say = async (status, key, { own, base, redirect } = {}) => {
      if (silent(status, redirect)) return reply(request, url, status, null, {}, redirect);
      lang ??= await languageOf(request, fields, main);
      return reply(request, url, status, lang, pick(lang, key, own, base), redirect);
    };
    if (request.method !== 'POST') return say(405, 'post');
    if (!SLUG.test(slug)) return say(404, 'missing');
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BYTES) return say(413, 'long');
    try { fields = await readFields(request); } catch { return say(400, 'unreadable'); }
    const redirect = typeof fields._redirect === 'string' && /^\/(?![/\\])/.test(fields._redirect) ? fields._redirect : null;
    if (fields._gotcha) return say(200, 'thanks', { redirect });
    if (turnstileSecret && !(await human(fields, request))) return say(403, 'check');
    const kept = Object.fromEntries(Object.entries(fields).filter(([name]) => !name.startsWith('_') && name !== TURNSTILE));
    const chars = Object.entries(kept).flat(2).join('').length;
    if (Object.keys(kept).length > MAX_FIELDS || chars > MAX_CHARS) return say(413, 'long');
    if (!Object.values(kept).flat().some((v) => v.trim())) return say(422, 'empty');
    main = (await storage.head(branch)).sha;
    const definition = await definitionOf(main, slug);
    if (!definition) return say(404, 'missing');
    const { form, lang: base } = definition;
    const sent = await sentAt(await head());
    const hourAgo = stamp(now() - 3600 * 1000);
    const recent = sent.filter((p) => p.startsWith(`${SUBMISSIONS_DIR}/${slug}/`) && p.split('/').pop().slice(0, hourAgo.length) > hourAgo);
    if (recent.length >= PER_HOUR) return say(429, 'busy');
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
    // The form in the page's language, where it is translated.
    if (confirm || !silent(201, redirect)) lang ??= await languageOf(request, fields, main);
    // (A form found in another language is missing in the default one.) The submission is stored
    // already, so a failed read only costs the translation's texts.
    let local = form;
    if (lang && base && lang !== base) {
      local = lang === site.languages[0] ? null : await storage.read(main, `${site.contentDir}/${lang}/forms/${slug}.json`)
        .then(parse, (e) => { console.error('werft forms: translated form not read:', e.message); return null; });
    }
    if (mail) await inform({ form, local, lang, base, title, fields: kept, visitor, confirm });
    return say(201, 'thanks', { own: ownTexts(local, form, (f) => f.thanks), base, redirect });
  }

  async function api(request, user) {
    const t = say(request);
    if (!editable(user.role).includes('content')) return json({ message: t('submissions.notAllowed') }, 403);
    if (request.method === 'POST') {
      const wanted = (await request.json()).delete ?? [];
      if (!wanted.length) return json({ message: t('submissions.noneChosen') }, 422);
      const paths = new Set(await sentAt(await head()));
      for (const ref of wanted) {
        const [slug, id, ...rest] = String(ref).split('/');
        if (rest.length || !SLUG.test(slug ?? '') || !ID.test(id ?? '') || !paths.has(`${SUBMISSIONS_DIR}/${slug}/${id}.json`)) return json({ message: t('submissions.notFound', { ref }) }, 404);
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
