// Sends a built site to the PHP receiver (adapters/php/werft-publish.php) on web space without
// Node, such as IONOS: only changed files go over the wire, and files removed from the build are
// deleted there. Requests are signed with the shared WERFT_PUBLISH_SECRET.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';

async function* walk(dir, rel = '') {
  for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(dir, p);
    else if (entry.isFile()) yield p;
  }
}

// options: { outDir, url, secret, exclude: path prefixes not to publish, batchBytes, fetch, log }
export async function publish({ outDir, url, secret, exclude = [], batchBytes = 2 * 1024 * 1024, fetch: request = globalThis.fetch, log = () => {} }) {
  if (!url || !secret) throw new Error('Set WERFT_PUBLISH_URL and WERFT_PUBLISH_SECRET.');
  const send = async (body) => {
    const text = JSON.stringify(body);
    const t = String(Math.floor(Date.now() / 1000));
    const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-werft-signature': `t=${t},s=${createHmac('sha256', secret).update(`${t}\n${text}`).digest('hex')}` }, body: text });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Publish ${body.action}: ${response.status} ${data.message ?? ''}`.trim());
    return data;
  };

  const local = {};
  for await (const p of walk(outDir)) {
    if (exclude.some((prefix) => p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))) continue;
    local[p] = createHash('sha256').update(await fs.readFile(path.join(outDir, p))).digest('hex');
  }
  const remote = (await send({ action: 'manifest' })).files ?? {};
  const changed = Object.keys(local).filter((p) => remote[p] !== local[p]);
  const removed = Object.keys(remote).filter((p) => !(p in local));

  let batch = [];
  let size = 0;
  const flush = async () => { if (batch.length) await send({ action: 'put', files: batch }); batch = []; size = 0; };
  for (const p of changed) {
    const data = await fs.readFile(path.join(outDir, p));
    if (size && size + data.length > batchBytes) await flush();
    batch.push({ path: p, content: data.toString('base64') });
    size += data.length;
  }
  await flush();
  if (removed.length) await send({ action: 'delete', paths: removed });
  await send({ action: 'done', files: local });
  log(`Published ${changed.length} changed and removed ${removed.length} of ${Object.keys(local).length} files to ${url}`);
  return { changed, removed };
}
