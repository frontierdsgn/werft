// E-mail through Cloudflare Email Service's REST API (Email Sending, in beta in 2026): Pages
// Functions cannot use the send_email binding, so the gateway posts to the API with a token that
// may send e-mail (permission "Email Sending: Edit"). The sending domain is onboarded under Email
// Service > Email Sending. Free only to the destination addresses verified in the account; any
// other recipient needs the Workers Paid plan.
import { mailer, postJson } from './mail.js';

export function cloudflareMail({ from, account, token, fetch = (...args) => globalThis.fetch(...args), api = 'https://api.cloudflare.com/client/v4' }) {
  const url = `${api}/accounts/${encodeURIComponent(account)}/email/sending/send`;
  return mailer({
    kind: 'cloudflare', from,
    deliver: async ({ from, to, replyTo, subject, text }) => {
      const answer = await postJson('cloudflare', fetch, url, { authorization: `Bearer ${token}` }, {
        from: { address: from.email, ...(from.name && { name: from.name }) },
        to, subject, text,
        ...(replyTo && { reply_to: replyTo }),
      });
      const result = answer.result ?? {};
      // Cloudflare answers 200 even when every recipient bounced at once.
      if (!result.delivered?.length && !result.queued?.length) {
        const refused = [['bounced', result.permanent_bounces], ['suppressed', result.suppressed_recipients]].filter(([, list]) => list?.length).map(([what, list]) => `${what}: ${list.join(', ')}`);
        throw new Error(`E-mail (cloudflare): no recipient accepted the e-mail${refused.length ? ` (${refused.join('; ')})` : ''}.`);
      }
      return { id: result.message_id };
    },
  });
}
