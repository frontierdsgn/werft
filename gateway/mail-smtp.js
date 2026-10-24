// E-mail through an SMTP server, for `werft serve` only: it needs Node's sockets, which Cloudflare
// Pages Functions do not have, so mail.js does not import it and the Node adapter passes it in.
// It always encrypts and checks the server's certificate: port 465 (or secure) speaks TLS from the
// start, any other port must offer STARTTLS, and the password is only sent over TLS. AUTH PLAIN or
// LOGIN, whichever the server offers. One connection per e-mail.
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { mailer } from './mail.js';

// Replies line by line: next() resolves with the next complete reply { code, lines }.
function replies(socket) {
  let buffer = '';
  let lines = [];
  let failure = null;
  const done = [];
  const waiting = [];
  const settle = () => {
    while (waiting.length && (done.length || failure)) {
      const { resolve, reject } = waiting.shift();
      if (done.length) resolve(done.shift()); else reject(failure);
    }
  };
  const fail = (error) => { failure ??= error; settle(); };
  const onData = (chunk) => {
    buffer += chunk.toString('latin1');
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      lines.push(line.slice(4));
      if (line[3] !== '-') { done.push({ code: Number(line.slice(0, 3)), lines }); lines = []; }
    }
    if (buffer.length > 4096) socket.destroy(new Error('the server sent a line that is too long'));
    settle();
  };
  const onClose = () => fail(new Error('the server closed the connection'));
  socket.on('data', onData).on('error', fail).on('close', onClose);
  return {
    next: () => new Promise((resolve, reject) => { waiting.push({ resolve, reject }); settle(); }),
    // Hands the socket to TLS; an error on the bare socket still must not go unhandled.
    detach: () => { socket.off('data', onData).off('error', fail).off('close', onClose).on('error', () => {}); },
  };
}

const ascii = (text) => /^[\x20-\x7e]*$/.test(text);

// A header value in RFC 2047 encoded words of at most 39 bytes each, on folded lines, so a line
// stays within 78 characters.
function encodeWords(text) {
  const words = [];
  let word = [];
  for (const char of text) {
    const bytes = Buffer.from(char);
    if (word.length && Buffer.concat(word).length + bytes.length > 39) { words.push(word); word = []; }
    word.push(bytes);
  }
  if (word.length) words.push(word);
  return words.map((w) => `=?utf-8?B?${Buffer.concat(w).toString('base64')}?=`).join('\r\n ');
}

// Short ASCII as it is, anything else in folded encoded words.
const header = (text) => (ascii(text) && text.length <= 68 ? text : encodeWords(text));

// An address as SMTP without SMTPUTF8 takes it: the domain in punycode, ASCII before the @.
function asciiAddress(address) {
  const at = address.lastIndexOf('@');
  const domain = domainToASCII(address.slice(at + 1));
  if (!ascii(address.slice(0, at)) || !domain) throw new Error(`"${address}" cannot be sent over SMTP (letters such as umlauts before the @, or a domain that is not valid)`);
  return `${address.slice(0, at)}@${domain}`;
}

// The checked message as an RFC 5322 e-mail, the text base64 encoded, so no line can end the DATA.
export function smtpMessage({ from, to, replyTo, subject, text }, { id, date = new Date() }) {
  const sender = from.name ? `${ascii(from.name) ? `"${from.name}"` : encodeWords(from.name)} <${from.email}>` : from.email;
  const body = Buffer.from(text.replace(/\n/g, '\r\n')).toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${sender}`,
    `To: ${to.join(',\r\n ')}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${header(subject)}`,
    `Date: ${date.toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

// options: { from, host, port (587), secure (TLS from the start; default for port 465), user,
//   password, tls (more tls.connect options, such as ca), timeout (ms for the whole delivery) }
export function smtpMail({ from, host, port = 587, secure = Number(port) === 465, user, password, tls: tlsOptions = {}, timeout = 30000 }) {
  if (!host) throw new Error('The smtp mail driver needs a host (WERFT_MAIL_HOST).');
  if (!user !== !password) throw new Error('The smtp mail driver needs both a user and a password (WERFT_MAIL_USER, WERFT_MAIL_KEY), or neither.');
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WERFT_MAIL_PORT must be a port number (587, or 465 for TLS from the start).');
  const servername = net.isIP(host) ? undefined : host;
  const encrypt = (options) => tls.connect({ servername, ...tlsOptions, ...options });

  async function deliver(checked) {
    let message;
    try {
      message = { ...checked, from: { ...checked.from, email: asciiAddress(checked.from.email) }, to: checked.to.map(asciiAddress), replyTo: checked.replyTo && asciiAddress(checked.replyTo) };
    } catch (error) { throw new Error(`E-mail (smtp): ${error.message}.`); }
    const domain = message.from.email.split('@')[1];
    const id = `${randomUUID()}@${domain}`;
    let socket = secure ? encrypt({ host, port }) : net.connect({ host, port });
    // One deadline for the whole delivery, the TLS handshake too: a server that stalls or trickles
    // cannot hold the request.
    const deadline = setTimeout(() => socket.destroy(new Error('the server did not answer in time')), timeout);
    let reader = replies(socket);
    // Errors name the step, never the line sent: AUTH carries the password.
    const expect = async (step, ...codes) => {
      const reply = await reader.next();
      if (!codes.includes(reply.code)) throw new Error(`${step}: ${reply.code} ${reply.lines.join(' ').slice(0, 200)}`);
      return reply;
    };
    const command = (line, step, ...codes) => { socket.write(`${line}\r\n`); return expect(step, ...codes); };
    try {
      await expect('greeting', 220);
      let features = (await command(`EHLO ${domain}`, 'EHLO', 250)).lines;
      if (!secure) {
        if (!features.some((f) => /^STARTTLS\b/i.test(f))) throw new Error('the server offers no STARTTLS, and werft sends e-mail only encrypted');
        await command('STARTTLS', 'STARTTLS', 220);
        reader.detach();
        socket = encrypt({ socket, host });
        await new Promise((resolve, reject) => socket.once('secureConnect', resolve).once('error', reject));
        reader = replies(socket);
        features = (await command(`EHLO ${domain}`, 'EHLO', 250)).lines;
      }
      if (user) {
        const methods = features.find((f) => /^AUTH\b/i.test(f))?.toUpperCase().split(/\s+/) ?? [];
        const b64 = (value) => Buffer.from(value).toString('base64');
        if (methods.includes('PLAIN')) await command(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`, 'AUTH', 235);
        else if (methods.includes('LOGIN')) {
          await command('AUTH LOGIN', 'AUTH', 334);
          await command(b64(user), 'AUTH', 334);
          await command(b64(password), 'AUTH', 235);
        } else throw new Error('the server offers neither AUTH PLAIN nor AUTH LOGIN');
      }
      await command(`MAIL FROM:<${message.from.email}>`, 'MAIL FROM', 250);
      for (const to of message.to) await command(`RCPT TO:<${to}>`, `RCPT TO ${to}`, 250, 251);
      await command('DATA', 'DATA', 354);
      await command(`${smtpMessage(message, { id })}.`, 'DATA', 250);
      socket.write('QUIT\r\n');
      return { id };
    } catch (error) {
      throw new Error(`E-mail (smtp ${host}:${port}): ${error.message}`);
    } finally {
      clearTimeout(deadline);
      socket.end();
      socket.destroy();
    }
  }

  return mailer({ kind: 'smtp', from, deliver });
}

// The driver from the environment, in the form mailFromEnv's drivers take.
export const smtpFromEnv = (env, { from }) => smtpMail({
  from, host: env.WERFT_MAIL_HOST, port: env.WERFT_MAIL_PORT || 587, user: env.WERFT_MAIL_USER || undefined, password: env.WERFT_MAIL_KEY || undefined,
});
