// Node server for a werft site: serves the built site and the admin, runs the gateway on a local git
// checkout and rebuilds after every change. Used by `werft dev` and for self-hosting on a server
// with Node (`werft serve`).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildToDisk, loadSite } from '../lib/node.js';
import { createGateway, gatewaySite } from '../gateway/core.js';
import { gitStorage } from '../gateway/storage/git.js';
import { mailFromEnv } from '../gateway/mail.js';
import { smtpFromEnv } from '../gateway/mail-smtp.js';

const TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', txt: 'text/plain; charset=utf-8', xml: 'application/xml', woff2: 'font/woff2', pdf: 'application/pdf', map: 'application/json', webmanifest: 'application/manifest+json' };

async function toRequest(req, origin) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url, origin), { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
}

async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

// Whether `file` lies inside `dir` (a prefix test would also accept a sibling such as _site-old).
const inside = (dir, file) => { const rel = path.relative(dir, file); return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };

async function serveFile(res, outDir, pathname, status = 200) {
  let file = path.join(outDir, decodeURIComponent(pathname));
  if (!inside(outDir, file)) return false;
  try {
    // Symbolic links in the output must not lead out of it either.
    if (!inside(await fs.realpath(outDir), await fs.realpath(file))) return false;
    if ((await fs.stat(file)).isDirectory()) {
      if (!pathname.endsWith('/')) { res.writeHead(301, { location: `${pathname}/` }); res.end(); return true; }
      file = path.join(file, 'index.html');
    }
    const data = await fs.readFile(file);
    res.writeHead(status, { 'content-type': TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

// For an address the site does not have: the nearest 404.html above it (en/404.html for /en/…, else
// 404.html), with status 404, as Cloudflare Pages does.
async function serveNotFound(res, outDir, pathname) {
  const folders = pathname.split('/').slice(1, -1);
  for (let i = folders.length; i >= 0; i--) {
    if (await serveFile(res, outDir, `/${folders.slice(0, i).map((f) => `${f}/`).join('')}404.html`, 404)) return true;
  }
  return false;
}

// options: { dir, port, host, secret, branch, tickMinutes, mail (the e-mail driver when WERFT_MAIL
// is unset: 'log' in werft dev, none in werft serve) }
export async function serve({ dir = '.', port = 8787, host = '127.0.0.1', secret, branch, tickMinutes = 0, mail, log = console.log } = {}) {
  const { root, site, theme } = await loadSite(dir);
  const outDir = path.resolve(root, site.output ?? '_site');
  const storage = await gitStorage(root);
  const { execFileSync } = await import('node:child_process');
  branch ??= execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  let building = null;
  let again = false;
  async function rebuild(reason) {
    if (building) { again = true; return building; }
    building = (async () => {
      do {
        again = false;
        const started = Date.now();
        try {
          const result = await buildToDisk(root);
          log(`Built ${result.files.length} files in ${Date.now() - started} ms${reason ? ` (${reason})` : ''}`);
        } catch (error) { log(`Build failed: ${error.stack ?? error}`); }
      } while (again);
      building = null;
    })();
    return building;
  }
  await rebuild('start');

  const lastBuild = async () => {
    try { return JSON.parse(await fs.readFile(path.join(outDir, site.base ?? '', '_werft/build.json'), 'utf8')).built_at; } catch { return null; }
  };
  // The server's own timer publishes scheduled entries; the key lets it call the tick.
  const tickKey = crypto.randomUUID();
  const gateway = createGateway({
    storage, secret, branch, tickKey,
    turnstileSecret: process.env.TURNSTILE_SECRET_KEY || undefined,
    mail: mailFromEnv(process.env, { fallback: mail, log, drivers: { smtp: smtpFromEnv } }),
    site: gatewaySite(site, theme),
    onCommit: (commit) => { rebuild(commit.message); },
    onTick: ({ due }) => rebuild(`scheduled: ${due.join(', ')}`),
    lastBuild,
  });

  const redirects = async () => {
    try { return JSON.parse(await fs.readFile(path.join(outDir, site.base ?? '', '_werft/build.json'), 'utf8')).redirects ?? []; } catch { return []; }
  };

  const server = http.createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host ?? `${host}:${port}`}`;
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/werft')) {
        const response = await gateway(await toRequest(req, origin), { address: req.socket.remoteAddress });
        return send(res, response ?? new Response('Not found', { status: 404 }));
      }
      const redirect = (await redirects()).find((r) => r.from === url.pathname);
      if (redirect) { res.writeHead(redirect.status ?? 301, { location: redirect.to }); return res.end(); }
      if (await serveFile(res, outDir, url.pathname)) return;
      if (await serveNotFound(res, outDir, url.pathname)) return;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      log(`Request failed: ${error.stack ?? error}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const timer = tickMinutes > 0 && setInterval(() => gateway(new Request(`http://${host}:${port}/api/werft/tick?key=${tickKey}`)).catch(() => {}), tickMinutes * 60000);
  return { server, rebuild, close: () => { if (timer) clearInterval(timer); server.close(); }, url: `http://${host}:${port}` };
}
