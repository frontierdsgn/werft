// Cloudflare Pages Functions: the gateway on the GitHub repository the Pages project builds from.
// Every save is a commit there, and Cloudflare rebuilds the site on its own after each push.
// Scheduled entries need a deploy hook, since publishing them changes no file.
//
//   functions/api/werft/[[path]].js:
//     import { pagesFunction } from 'werft/cloudflare';
//     import site from '../../../werft.config.js';
//     import theme from '../../../theme/index.js';
//     export const onRequest = pagesFunction({ site, theme });
//
// Environment (Pages project settings):
//   WERFT_SECRET       random, at least 32 characters (secret; `werft secret` makes one)
//   GITHUB_APP_ID      the GitHub App's client ID or app ID; the app has "Contents: read and write"
//                      and is installed on the repository
//   GITHUB_APP_PRIVATE_KEY  the app's private key as PKCS#8 PEM (secret; see gateway/storage/github-app.js)
//   GITHUB_TOKEN       instead of the app: fine-grained token, "Contents: read and write" on the
//                      repository (secret)
//   WERFT_REPO         owner/repository
//   WERFT_DIR          the site's directory in the repository ('' when it is the root)
//   WERFT_BRANCH       production branch (default main)
//   WERFT_DEPLOY_WORKFLOW  optional, the workflow file that deploys the site (e.g. gate.yml): scheduled
//                      entries start it (workflow_dispatch) instead of a deploy hook, so they pass the
//                      site's gate; the GitHub App or token needs "Actions: Read and write"
//   WERFT_DEPLOY_HOOK  optional deploy hook URL, used to publish scheduled entries (bypasses the gate)
//   WERFT_TICK_KEY     optional, lets a cron service call /api/werft/tick?key=… (secret)
//   WERFT_GITHUB_API   optional, for GitHub Enterprise Server (default https://api.github.com)
//   TURNSTILE_SECRET_KEY  optional, forms then need Cloudflare Turnstile (secret)
//   WERFT_MAIL, WERFT_MAIL_FROM  optional, the e-mail driver and sender (see gateway/mail.js)
//   WERFT_MAIL_KEY     the mail provider's API key or token (secret); WERFT_MAIL_ACCOUNT the
//                      Cloudflare account ID for WERFT_MAIL=cloudflare
//
// Bindings (Pages project settings → Functions):
//   WERFT_KV           optional KV namespace; failed sign-ins then count across all isolates
import { createGateway, gatewaySite } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';
import { githubApp } from '../gateway/storage/github-app.js';
import { mailFromEnv } from '../gateway/mail.js';

export function pagesFunction({ site, theme, fetch: request = (...args) => fetch(...args) }) {
  let gateway;
  // What this isolate last started the deploy workflow for (the commit and the entries due): a gate
  // that fails is not started again for them every quarter hour; another entry falling due is.
  let dispatched = null;
  const create = (env) => {
    const [owner, repo] = String(env.WERFT_REPO ?? '').split('/');
    const app = env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY;
    if (!owner || !repo || !(app || env.GITHUB_TOKEN)) throw new Error('Set WERFT_REPO (owner/repository) and GITHUB_APP_ID with GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN, in the Pages project.');
    const api = env.WERFT_GITHUB_API || undefined;
    const base = site.base ? `/${site.base.replace(/^\/|\/$/g, '')}/` : '/';
    const storage = githubStorage({
      owner, repo, dir: env.WERFT_DIR ?? '', api, fetch: request,
      ...(app ? { auth: githubApp({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, owner, repo, api, fetch: request }) } : { token: env.GITHUB_TOKEN }),
    });
    return createGateway({
      storage,
      secret: env.WERFT_SECRET,
      branch: env.WERFT_BRANCH || 'main',
      tickKey: env.WERFT_TICK_KEY || undefined,
      turnstileSecret: env.TURNSTILE_SECRET_KEY || undefined,
      mail: mailFromEnv(env, { fetch: request }),
      throttleStore: env.WERFT_KV && {
        get: (key) => env.WERFT_KV.get(key, 'json'),
        // KV keeps a key for at least 60 seconds.
        put: (key, value, ttl) => env.WERFT_KV.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttl) }),
        delete: (key) => env.WERFT_KV.delete(key),
      },
      fetch: request,
      // Each binary file is one GitHub request; with the gateway's own requests and the GitHub App's
      // three for a new token, 30 stay below the free plan's 50 per invocation.
      maxFiles: 30,
      site: gatewaySite(site, theme),
      render: { site, theme },
      // The build the Pages project is serving right now.
      lastBuild: async (url) => {
        const response = await env.ASSETS.fetch(new URL(`${base}_werft/build.json`, url));
        return response.ok ? (await response.json()).built_at : null;
      },
      onTick: async ({ head, due }) => {
        if (env.WERFT_DEPLOY_WORKFLOW) {
          const key = JSON.stringify([head, due]);
          if (dispatched === key) return true;
          await storage.dispatch(env.WERFT_DEPLOY_WORKFLOW, env.WERFT_BRANCH || 'main');
          dispatched = key;
          return true;
        }
        if (!env.WERFT_DEPLOY_HOOK) return false;
        const response = await request(env.WERFT_DEPLOY_HOOK, { method: 'POST' });
        if (!response.ok) throw new Error(`Deploy hook: ${response.status}`);
      },
    });
  };
  return async (context) => {
    const { request: incoming, env } = context;
    try {
      gateway ??= create(env);
    } catch (error) {
      return new Response(JSON.stringify({ message: error.message }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    // Cloudflare routes by the host name, so the request's origin is the site's.
    const origin = new URL(incoming.url).origin;
    return (await gateway(incoming, { address: incoming.headers.get('cf-connecting-ip'), origin, waitUntil: context.waitUntil && ((p) => context.waitUntil(p)) })) ?? new Response('Not found', { status: 404 });
  };
}
