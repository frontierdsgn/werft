// E-mail through Resend's API (https://api.resend.com/emails) with an API key.
import { mailer, postJson } from './mail.js';

export function resendMail({ from, key, fetch = (...args) => globalThis.fetch(...args), api = 'https://api.resend.com' }) {
  return mailer({
    kind: 'resend', from,
    deliver: async ({ from, to, replyTo, subject, text }) => {
      // The checked sender name has no quotes, angle brackets or backslashes, so quoting it is safe.
      const answer = await postJson('resend', fetch, `${api}/emails`, { authorization: `Bearer ${key}` }, {
        from: from.name ? `"${from.name}" <${from.email}>` : from.email,
        to, subject, text,
        ...(replyTo && { reply_to: replyTo }),
      });
      return { id: answer.id };
    },
  });
}
