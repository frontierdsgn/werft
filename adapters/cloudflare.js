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
//   GITHUB_TOKEN       fine-grained token, "Contents: read and write" on the repository (secret)
//   WERFT_REPO         owner/repository
//   WERFT_DIR          the site's directory in the repository ('' when it is the root)
//   WERFT_BRANCH       production branch (default main)
//   WERFT_DEPLOY_HOOK  optional deploy hook URL, used to publish scheduled entries
//   WERFT_TICK_KEY     optional, lets a cron service call /api/werft/tick?key=… (secret)
//   WERFT_GITHUB_API   optional, for GitHub Enterprise Server (default https://api.github.com)
import { createGateway, gatewaySite } from '../gateway/core.js';
import { githubStorage } from '../gateway/storage/github.js';

export function pagesFunction({ site, theme, fetch: request = (...args) => fetch(...args) }) {
  let gateway;
  const create = (env) => {
    const [owner, repo] = String(env.WERFT_REPO ?? '').split('/');
    if (!owner || !repo || !env.GITHUB_TOKEN) throw new Error('Set WERFT_REPO (owner/repository) and GITHUB_TOKEN in the Pages project.');
    const base = site.base ? `/${site.base.replace(/^\/|\/$/g, '')}/` : '/';
    return createGateway({
      storage: githubStorage({ owner, repo, token: env.GITHUB_TOKEN, dir: env.WERFT_DIR ?? '', api: env.WERFT_GITHUB_API || undefined, fetch: request }),
      secret: env.WERFT_SECRET,
      branch: env.WERFT_BRANCH || 'main',
      tickKey: env.WERFT_TICK_KEY || undefined,
      // Each binary file is one GitHub request; with the gateway's own requests, 30 stay below the
      // free plan's 50 per invocation.
      maxFiles: 30,
      site: gatewaySite(site, theme),
      // The build the Pages project is serving right now.
      lastBuild: async (url) => {
        const response = await env.ASSETS.fetch(new URL(`${base}_werft/build.json`, url));
        return response.ok ? (await response.json()).built_at : null;
      },
      onTick: async () => {
        if (!env.WERFT_DEPLOY_HOOK) return false;
        const response = await request(env.WERFT_DEPLOY_HOOK, { method: 'POST' });
        if (!response.ok) throw new Error(`Deploy hook: ${response.status}`);
      },
    });
  };
  return async ({ request: incoming, env }) => {
    try {
      gateway ??= create(env);
    } catch (error) {
      return new Response(JSON.stringify({ message: error.message }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    return (await gateway(incoming)) ?? new Response('Not found', { status: 404 });
  };
}
