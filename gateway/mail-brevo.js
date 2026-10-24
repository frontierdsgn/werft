// E-mail through Brevo's transactional API (https://api.brevo.com/v3/smtp/email) with an API key.
import { mailer, postJson } from './mail.js';

export function brevoMail({ from, key, fetch = (...args) => globalThis.fetch(...args), api = 'https://api.brevo.com/v3' }) {
  return mailer({
    kind: 'brevo', from,
    deliver: async ({ from, to, replyTo, subject, text }) => {
      const answer = await postJson('brevo', fetch, `${api}/smtp/email`, { 'api-key': key }, {
        sender: from,
        to: to.map((email) => ({ email })),
        ...(replyTo && { replyTo: { email: replyTo } }),
        subject, textContent: text,
      });
      return { id: answer.messageId };
    },
  });
}
