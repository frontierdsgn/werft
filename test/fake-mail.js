// Stand-ins for the mail providers, so the drivers are tested without network or keys.
//
// fakeMailApi(): a fetch for the HTTP APIs of Cloudflare Email Service, Brevo and Resend under their
// real URLs. It checks the key, keeps each accepted request in `requests` ({ provider, url, headers,
// body }) and answers as the provider does; while `failure` is set ({ status, body }) it answers
// with that instead, and `bounce` makes Cloudflare report every recipient as bounced.
//
// fakeSmtp({ tls, implicitTls, startTls, auth, users }): an SMTP server on 127.0.0.1. `tls` is
// { key, cert }; `startTls` offers STARTTLS on the plain port; `implicitTls` speaks TLS from the
// start; `auth` lists the AUTH methods; `users` maps user → password; `rejectRcpt` answers 550 to
// those recipients; `silent` never greets. Each session lands in `sessions`: { commands (as they
// arrived, AUTH lines kept), encrypted (per command), mailFrom, rcptTo, data }.
import net from 'node:net';
import tls from 'node:tls';

export const KEYS = { cloudflare: 'cf-token', brevo: 'brevo-key', resend: 're_key', account: 'acc123' };

export function fakeMailApi() {
  const api = { requests: [], failure: null, bounce: false };
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  api.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers));
    const body = JSON.parse(init.body);
    const provider = url === `https://api.cloudflare.com/client/v4/accounts/${KEYS.account}/email/sending/send` ? 'cloudflare'
      : url === 'https://api.brevo.com/v3/smtp/email' ? 'brevo'
        : url === 'https://api.resend.com/emails' ? 'resend' : null;
    if (!provider || init.method !== 'POST') return answer(404, { message: 'not found' });
    const key = provider === 'brevo' ? headers['api-key'] : headers.authorization?.replace(/^Bearer /, '');
    if (key !== KEYS[provider]) {
      return provider === 'cloudflare'
        ? answer(403, { success: false, errors: [{ code: 10102, message: 'email.sending.error.authentication.forbidden' }], messages: [], result: null })
        : answer(401, { message: 'API key is invalid' });
    }
    if (api.failure) return answer(api.failure.status, api.failure.body);
    api.requests.push({ provider, url, headers, body });
    const n = api.requests.length;
    if (provider === 'brevo') return answer(201, { messageId: `<brevo-${n}@smtp-relay.mailin.fr>` });
    if (provider === 'resend') return answer(200, { id: `resend-${n}` });
    const to = [body.to].flat();
    return answer(200, { success: true, errors: [], messages: [], result: { delivered: api.bounce ? [] : to, permanent_bounces: api.bounce ? to : [], queued: [], message_id: `cf-${n}` } });
  };
  return api;
}

export async function fakeSmtp({ tls: credentials, implicitTls = false, startTls = !implicitTls, auth = ['PLAIN', 'LOGIN'], users = {}, rejectRcpt = [], silent = false } = {}) {
  const sessions = [];
  const sockets = new Set();
  // session: the one continued after STARTTLS, which gets no second greeting.
  const handle = (socket, encrypted, session) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket)).on('error', () => {});
    const fresh = !session;
    if (fresh) sessions.push(session = { commands: [], encrypted: [], mailFrom: null, rcptTo: [], data: null });
    let buffer = '';
    let inData = false;
    let login = null;
    const reply = (line) => socket.write(`${line}\r\n`);
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      for (let end; (end = buffer.indexOf('\r\n')) >= 0;) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') { inData = false; reply('250 2.0.0 Ok: queued'); } else session.data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          continue;
        }
        session.commands.push(line);
        session.encrypted.push(encrypted);
        const [verb] = line.split(' ');
        if (login) {
          login.push(Buffer.from(line, 'base64').toString());
          if (login.length === 1) reply('334 UGFzc3dvcmQ6');
          else { reply(users[login[0]] === login[1] ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication failed'); login = null; }
        } else if (verb === 'EHLO') {
          const features = ['fake.smtp.test', ...(startTls && !encrypted ? ['STARTTLS'] : []), ...(auth.length ? [`AUTH ${auth.join(' ')}`] : []), '8BITMIME'];
          features.forEach((f, i) => reply(`250${i === features.length - 1 ? ' ' : '-'}${f}`));
        } else if (verb === 'STARTTLS' && startTls && !encrypted) {
          reply('220 2.0.0 Ready to start TLS');
          socket.off('data', onData);
          const secure = new tls.TLSSocket(socket, { isServer: true, ...credentials });
          secure.on('secure', () => handle(secure, true, session));
          secure.on('error', () => {});
          return;
        } else if (verb === 'AUTH' && line.split(' ')[1] === 'PLAIN' && auth.includes('PLAIN')) {
          const [, user, password] = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString().split('\0');
          reply(users[user] === password ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication failed');
        } else if (line === 'AUTH LOGIN' && auth.includes('LOGIN')) { login = []; reply('334 VXNlcm5hbWU6'); } else if (verb === 'MAIL') { session.mailFrom = line.slice(10); reply('250 2.1.0 Ok'); } else if (verb === 'RCPT') {
          const to = line.slice(8);
          if (rejectRcpt.includes(to.replace(/[<>]/g, ''))) reply('550 5.1.1 Recipient address rejected');
          else { session.rcptTo.push(to); reply('250 2.1.5 Ok'); }
        } else if (verb === 'DATA') { inData = true; session.data = ''; reply('354 End data with <CR><LF>.<CR><LF>'); } else if (verb === 'QUIT') { reply('221 2.0.0 Bye'); socket.end(); } else reply('502 5.5.2 Command not recognized');
      }
    };
    socket.on('data', onData);
    if (fresh && !silent) reply('220 fake.smtp.test ESMTP');
  };
  const server = implicitTls
    ? tls.createServer(credentials, (socket) => handle(socket, true))
    : net.createServer((socket) => handle(socket, false));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    sessions,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  };
}

// The e-mail as the server received it: headers (unfolded) and the decoded text.
export function parseMail(data) {
  const [head, ...rest] = data.split('\r\n\r\n');
  const headers = {};
  for (const line of head.replace(/\r\n[ \t]/g, ' ').split('\r\n')) {
    const at = line.indexOf(':');
    headers[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
  }
  // Space between two encoded words is not part of the text (RFC 2047).
  const decodeWords = (value) => value.replace(/\?=\s+=\?/g, '?==?').replace(/=\?utf-8\?B\?([^?]*)\?=/gi, (_, b64) => Buffer.from(b64, 'base64').toString());
  return { headers, subject: decodeWords(headers.subject ?? ''), from: decodeWords(headers.from ?? ''), text: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString() };
}
