// The Node build makes smaller copies of the media images with sharp, keeps them in a cache, and
// builds with the originals when sharp cannot be loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildToDisk } from '../lib/node.js';

const CLI = fileURLToPath(new URL('../bin/werft.js', import.meta.url));
const image = (width, height, background = '#3a7') => sharp({ create: { width, height, channels: 3, background } });

// A site with a photo, a small image and a GIF; `images` goes into werft.config.js.
async function site(t, images) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-variants-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write('werft.config.js', `export default { name: 'T', theme: './theme/index.js', mediaDirs: ['assets/img'], output: '_site', admin: false${images ? `, images: ${JSON.stringify(images)}` : ''} };\n`);
  write('theme/index.js', "export default { blocks: {}, renderPage: (page, ctx) => ctx.html`${ctx.img('assets/img/photo.jpg', { sizes: '50vw' })}${ctx.img('assets/img/small.png')}${ctx.img('assets/img/anim.gif')}` };\n");
  write('content/pages/index.json', '{"title":"Start","status":"published"}\n');
  fs.mkdirSync(path.join(root, 'assets/img'), { recursive: true });
  await image(2000, 1000).jpeg().toFile(path.join(root, 'assets/img/photo.jpg'));
  await image(300, 200).png().toFile(path.join(root, 'assets/img/small.png'));
  await image(1200, 800).gif().toFile(path.join(root, 'assets/img/anim.gif'));
  return root;
}
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory()).sort() : []);

test('the build writes smaller copies of large JPEG, PNG and WebP images and srcset for them', async (t) => {
  const root = await site(t);
  const warnings = [];
  const { outDir } = await buildToDisk(root, { log: (line) => warnings.push(line) });
  const out = path.join(outDir, '_werft/img/assets/img');
  assert.deepEqual(list(out), ['photo.1600.jpg', 'photo.1600.webp', 'photo.480.jpg', 'photo.480.webp', 'photo.960.jpg', 'photo.960.webp']);
  assert.deepEqual(await sharp(path.join(out, 'photo.960.webp')).metadata().then((m) => [m.format, m.width, m.height]), ['webp', 960, 480]);
  assert.equal(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'),
    '<picture><source type="image/webp" srcset="_werft/img/assets/img/photo.480.webp 480w, _werft/img/assets/img/photo.960.webp 960w, _werft/img/assets/img/photo.1600.webp 1600w" sizes="50vw">'
    + '<img src="assets/img/photo.jpg" alt="" srcset="_werft/img/assets/img/photo.480.jpg 480w, _werft/img/assets/img/photo.960.jpg 960w, _werft/img/assets/img/photo.1600.jpg 1600w, assets/img/photo.jpg 2000w" sizes="50vw" width="2000" height="1000" loading="lazy" decoding="async"></picture>'
    + '<img src="assets/img/small.png" alt="" width="300" height="200" loading="lazy" decoding="async">'
    + '<img src="assets/img/anim.gif" alt="" width="1200" height="800" loading="lazy" decoding="async">');
  const index = JSON.parse(fs.readFileSync(path.join(outDir, '_werft/media.json'), 'utf8'));
  assert.deepEqual(index['assets/img/photo.jpg'].variants[0], { src: '_werft/img/assets/img/photo.480.jpg', width: 480, height: 240, type: 'image/jpeg' });
  assert.deepEqual(warnings, []);

  // A second build takes every copy from the cache; a changed image is encoded again, and the copies
  // of its old content leave the cache.
  const cache = path.join(root, 'node_modules/.cache/werft-images');
  const stamps = () => Object.fromEntries(list(cache).map((f) => [f, fs.statSync(path.join(cache, f)).mtimeMs]));
  const first = stamps();
  assert.equal(Object.keys(first).length, 6);
  await buildToDisk(root);
  assert.deepEqual(stamps(), first);
  await image(2000, 1000, '#a37').jpeg().toFile(path.join(root, 'assets/img/photo.jpg'));
  await buildToDisk(root);
  const second = Object.keys(stamps());
  assert.equal(second.length, 6);
  assert.ok(second.every((f) => !(f in first)));
});

test('werft.config.js sets the widths and adds AVIF', async (t) => {
  const root = await site(t, { widths: [250, 1000], formats: ['WebP', 'avif', 'jpeg', 'tiff'] });
  const warnings = [];
  const { outDir } = await buildToDisk(root, { log: (line) => warnings.push(line) });
  assert.deepEqual(warnings, ['werft: images.formats: tiff unknown, only jpg, png, webp and avif are made.']);
  assert.deepEqual(list(path.join(outDir, '_werft/img/assets/img')), [
    'photo.1000.avif', 'photo.1000.jpg', 'photo.1000.webp', 'photo.250.avif', 'photo.250.jpg', 'photo.250.webp',
    'small.250.avif', 'small.250.jpg', 'small.250.png', 'small.250.webp',
  ]);
  assert.match(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), /^<picture><source type="image\/avif" srcset="_werft\/img\/assets\/img\/photo\.250\.avif 250w, _werft\/img\/assets\/img\/photo\.1000\.avif 1000w" sizes="50vw"><source type="image\/webp"/);
});

test('identical images share their copies, a turned photo is sized upright, and unused copies leave the cache', async (t) => {
  const root = await site(t);
  fs.copyFileSync(path.join(root, 'assets/img/photo.jpg'), path.join(root, 'assets/img/same.jpg'));
  // Stored 1700 × 1200 on its side, shown 1200 × 1700.
  await image(1700, 1200).jpeg().withMetadata({ orientation: 6 }).toFile(path.join(root, 'assets/img/turned.jpg'));
  const warnings = [];
  const { outDir } = await buildToDisk(root, { log: (line) => warnings.push(line) });
  assert.deepEqual(warnings, []);
  const index = JSON.parse(fs.readFileSync(path.join(outDir, '_werft/media.json'), 'utf8'));
  assert.equal(index['assets/img/same.jpg'].variants.length, 6);
  assert.deepEqual([index['assets/img/turned.jpg'].width, index['assets/img/turned.jpg'].height], [1200, 1700]);
  assert.deepEqual(index['assets/img/turned.jpg'].variants.map((v) => [v.width, v.height, v.type]), [[480, 680, 'image/jpeg'], [480, 680, 'image/webp'], [960, 1360, 'image/jpeg'], [960, 1360, 'image/webp']]);
  const cache = path.join(root, 'node_modules/.cache/werft-images');
  assert.equal(fs.readdirSync(cache).length, 10);
  fs.rmSync(path.join(root, 'assets/img/turned.jpg'));
  await buildToDisk(root);
  assert.equal(fs.readdirSync(cache).length, 6);
});

test('without sharp the site is built with the originals and the build says so', async (t) => {
  const root = await site(t);
  // Node cannot resolve sharp in this build.
  const hook = path.join(root, 'no-sharp.mjs');
  fs.writeFileSync(hook, `import { register } from 'node:module';\nregister('data:text/javascript,' + encodeURIComponent('export async function resolve(s, c, next) { if (s === "sharp") throw new Error("Cannot find package sharp"); return next(s, c); }'));\n`);
  const result = spawnSync(process.execPath, ['--import', hook, CLI, 'build', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Built /);
  assert.match(result.stderr, /images keep their original size only, sharp could not be loaded/);
  const outDir = path.join(root, '_site');
  assert.deepEqual(list(path.join(outDir, '_werft/img')), []);
  assert.doesNotMatch(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), /srcset|<picture>/);
});
