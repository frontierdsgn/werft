// E-mail from the gateway: one small interface with interchangeable drivers, chosen through the
// environment. Every driver gets the same checked message, so no driver has to guard against header
// injection or a missing recipient itself. Drivers use only the Fetch API (or nothing), so the same
// code runs on Node and Cloudflare.
//
//   const mail = mailFromEnv(env);   // null when the site sends no e-mail
//   await mail?.send({ to: ['a@example.org'], subject: 'Betreff', text: 'Text',
//     replyTo: 'visitor@example.org', fromName: 'Site name' });   // replyTo, fromName optional
//
// send() resolves when the driver accepted the message and rejects when it did not; callers that
// must not fail because of e-mail (form submissions) catch it. A message the check refuses rejects
// with code 'invalid_mail' and an English text for the log; the editor says it in German.
//
// Drivers: memory (tests: keeps the messages in `sent`, rejects with `failure` while it is set),
// log (prints each message, password-reset links too: for `werft dev`, whose default it is, and
// for trying things out), and the providers in their own files: cloudflare (mail-cloudflare.js),
// brevo (mail-brevo.js), resend (mail-resend.js), smtp (mail-smtp.js, Node only, so the Node
// adapter passes it in). Environment: WERFT_MAIL (the driver), WERFT_MAIL_FROM (the sender
// address), WERFT_MAIL_KEY (the provider's API key or token, the SMTP password), WERFT_MAIL_ACCOUNT
// (cloudflare: the account ID), WERFT_MAIL_HOST, WERFT_MAIL_PORT, WERFT_MAIL_USER (smtp).
import { cloudflareMail } from './mail-cloudflare.js';
import { brevoMail } from './mail-brevo.js';
import { resendMail } from './mail-resend.js';

const MAX_RECIPIENTS = 20;
const MAX_SUBJECT = 200;
const MAX_TEXT = 100000;
// No spaces, control characters or the characters that delimit addresses in a header; a dot in the
// domain.
const ADDRESS = /^[^\s\0-\x1f\x7f@<>()[\]\\,;:"]+@(?:[^\s\0-\x1f\x7f@<>()[\]\\,;:".]+\.)+[^\s\0-\x1f\x7f@<>()[\]\\,;:".]+$/;
const DEV_FROM = 'werft@localhost.invalid';

export const isAddress = (value) => typeof value === 'string' && value.length <= 254 && ADDRESS.test(value);

const invalid = (message) => Object.assign(new TypeError(`E-mail: ${message}`), { code: 'invalid_mail' });

// One line of a header: no line breaks or other control characters, so nothing can add a header.
function line(value, name, max) {
  const text = String(value ?? '').trim();
  if (/[\0-\x1f\x7f]/.test(text)) throw invalid(`${name} must be one line.`);
  if (text.length > max) throw invalid(`${name} is longer than ${max} characters.`);
  return text;
}

function check({ to, subject, text, replyTo, fromName } = {}, from) {
  const seen = new Set();
  const recipients = [to ?? []].flat().map((a) => String(a).trim()).filter((a) => !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
  if (!recipients.length) throw invalid('no recipient.');
  if (recipients.length > MAX_RECIPIENTS) throw invalid(`at most ${MAX_RECIPIENTS} recipients.`);
  for (const address of recipients) if (!isAddress(address)) throw invalid(`"${address}" is not an e-mail address.`);
  if (replyTo && !isAddress(replyTo)) throw invalid(`reply-to "${replyTo}" is not an e-mail address.`);
  const name = line(fromName, 'The sender name', 100).replace(/["<>\\]/g, '');
  if (typeof text !== 'string' || !text.trim()) throw invalid('no text.');
  if (text.length > MAX_TEXT) throw invalid(`the text is longer than ${MAX_TEXT} characters.`);
  return {
    from: { email: from, ...(name && { name }) },
    to: recipients,
    ...(replyTo && { replyTo }),
    subject: line(subject, 'The subject', MAX_SUBJECT) || '(ohne Betreff)',
    text: text.replace(/\r\n?/g, '\n'),
  };
}

// A driver: kind (its name), from (the sender address) and deliver(message), which receives the
// checked message { from: { email, name? }, to: [address], replyTo?, subject, text } and resolves
// with { id? } once the provider accepted it.
export function mailer({ kind, from, deliver }) {
  if (!isAddress(from)) throw new Error(`WERFT_MAIL_FROM must be an e-mail address (mail driver ${kind}).`);
  return { kind, from, send: async (message) => deliver(check(message, from)) };
}

export function memoryMail({ from = DEV_FROM } = {}) {
  const sent = [];
  const driver = mailer({
    kind: 'memory', from,
    deliver: async (message) => {
      if (driver.failure) throw driver.failure;
      sent.push(message);
      return { id: `memory-${sent.length}` };
    },
  });
  return Object.assign(driver, { sent, failure: null });
}

export function logMail({ from = DEV_FROM, log = console.log } = {}) {
  return mailer({
    kind: 'log', from,
    deliver: async ({ to, replyTo, subject, text }) => {
      log(`E-Mail an ${to.join(', ')}${replyTo ? ` (Antwort an ${replyTo})` : ''}: ${subject}\n${text}`);
      return {};
    },
  });
}

// A provider's HTTP API: posts the JSON body and resolves with the answer's JSON; rejects with the
// status and the provider's own message (never the key) when the provider refused or did not answer.
export async function postJson(kind, fetch, url, headers, body, { timeout = 15000 } = {}) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    throw new Error(`E-mail (${kind}): no answer from the provider (${error.name === 'TimeoutError' ? 'timeout' : error.message}).`);
  }
  const answer = await response.json().catch(() => null);
  if (!response.ok) {
    const said = answer && (answer.message ?? answer.errors?.map((e) => e.message).join('; '));
    throw new Error(`E-mail (${kind}): the provider refused the e-mail (${response.status}${said ? `: ${String(said).slice(0, 200)}` : ''}).`);
  }
  return answer ?? {};
}

const need = (kind, env, ...names) => {
  for (const name of names) if (!env[name]) throw new Error(`WERFT_MAIL=${kind} needs ${name}.`);
};

// Each driver from the environment: (env, { from, fetch, log }) → driver.
const DRIVERS = {
  log: (env, { from, log }) => logMail({ from, log }),
  cloudflare: (env, { from, fetch }) => {
    need('cloudflare', env, 'WERFT_MAIL_ACCOUNT', 'WERFT_MAIL_KEY');
    return cloudflareMail({ from, account: env.WERFT_MAIL_ACCOUNT, token: env.WERFT_MAIL_KEY, fetch });
  },
  brevo: (env, { from, fetch }) => { need('brevo', env, 'WERFT_MAIL_KEY'); return brevoMail({ from, key: env.WERFT_MAIL_KEY, fetch }); },
  resend: (env, { from, fetch }) => { need('resend', env, 'WERFT_MAIL_KEY'); return resendMail({ from, key: env.WERFT_MAIL_KEY, fetch }); },
};

// The driver the environment names, null without one. fallback: the driver when WERFT_MAIL is
// unset; fetch: for drivers that call a provider's HTTP API; drivers: more drivers in the same
// form as DRIVERS, for those that only run on one host (the Node adapter passes smtp).
export function mailFromEnv(env, { fallback, log, fetch = (...args) => globalThis.fetch(...args), drivers = {} } = {}) {
  const kind = env.WERFT_MAIL || fallback;
  if (!kind) return null;
  const from = env.WERFT_MAIL_FROM || undefined;
  const known = { ...DRIVERS, ...drivers };
  if (Object.hasOwn(known, kind)) return known[kind](env, { from, fetch, log });
  if (kind === 'smtp') throw new Error('WERFT_MAIL: the smtp driver works only with werft serve; on Cloudflare use cloudflare, brevo or resend.');
  throw new Error(`WERFT_MAIL: unknown mail driver "${kind}" (known: ${Object.keys(known).join(', ')}).`);
}
