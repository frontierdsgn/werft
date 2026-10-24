// Node only: the smaller copies of the media images that themes offer through srcset (images.js).
// The build makes them with sharp, an optional dependency, and keeps them in a cache by the
// image's content, so a build encodes only new or changed images. Without sharp the site is built
// with the originals.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { imageType, typeOf } from './images.js';

export const WIDTHS = [480, 960, 1600];
export const CACHE = 'node_modules/.cache/werft-images';
// Encoder settings; a change here changes the cache key, so old copies are not reused.
const ENCODE = {
  jpg: ['jpeg', { quality: 80, mozjpeg: true }],
  png: ['png', { compressionLevel: 9 }],
  webp: ['webp', { quality: 80 }],
  avif: ['avif', { quality: 50, effort: 2 }],
};
const KEY = createHash('sha256').update(JSON.stringify(ENCODE)).digest('hex').slice(0, 8);
const OWN = { jpg: 'jpg', jpeg: 'jpg', png: 'png', webp: 'webp' };

// Where a copy goes in the output: _werft/img/<image path without extension>.<width>.<format>.
export const variantPath = (src, width, format) => `_werft/img/${src.replace(/\.[^./]+$/, '')}.${width}.${format}`;

async function loadSharp() {
  try { return (await import('sharp')).default; } catch (error) { return { error }; }
}

// Adds `variants` to the media index entries of JPEG, PNG and WebP images (not GIFs, animations or
// images narrower than a width) and returns the files to copy into the output: [{ from, to }],
// `from` in the cache, `to` relative to the site's root. `images` in werft.config.js sets the
// widths and the formats besides the image's own (default ['webp']; 'avif' is slower to encode).
// Copies no image of this build uses are removed from the cache. Nothing here fails the build.
export async function makeVariants({ root, site, media, log = console.warn, load = loadSharp }) {
  const { widths = WIDTHS, formats: wanted = ['webp'] } = site.images ?? {};
  const formats = wanted.map((f) => OWN[String(f).toLowerCase()] ?? String(f).toLowerCase());
  const unknown = formats.filter((f) => !ENCODE[f]);
  if (unknown.length) log(`werft: images.formats: ${unknown.join(', ')} unknown, only jpg, png, webp and avif are made.`);
  const candidates = Object.entries(media).filter(([src, entry]) => OWN[src.split('.').pop().toLowerCase()] && entry.width > Math.min(...widths));
  if (!candidates.length) return [];
  const sharp = await load();
  if (sharp.error) {
    log(`werft: images keep their original size only, sharp could not be loaded (${sharp.error.message.split('\n')[0]}). Run npm install to get it.`);
    return [];
  }
  const cache = path.join(root, CACHE);
  try { await fs.mkdir(cache, { recursive: true }); } catch (error) {
    log(`werft: images keep their original size only, ${CACHE} cannot be written (${error.message}).`);
    return [];
  }
  // One encode per cache file, also for images with the same content.
  const encoding = new Map();
  const encode = (from, bytes, width, format) => {
    if (!encoding.has(from)) {
      encoding.set(from, (async () => {
        try { return (await sharp(from).metadata()).height; } catch {}
        const temp = `${from}.${randomUUID()}.tmp`;
        try {
          const { height } = await sharp(bytes).rotate().resize({ width, withoutEnlargement: true }).toFormat(...ENCODE[format]).toFile(temp);
          await fs.rename(temp, from);
          return height;
        } finally { await fs.rm(temp, { force: true }); }
      })());
    }
    return encoding.get(from);
  };
  const copies = [];
  const work = async ([src, entry]) => {
    try {
      const bytes = await fs.readFile(path.join(root, src));
      if (imageType(bytes)?.animated) return;
      const hash = createHash('sha256').update(bytes).digest('hex');
      const variants = [];
      for (const width of widths.filter((w) => w < entry.width).sort((a, b) => a - b)) {
        for (const format of [...new Set([OWN[src.split('.').pop().toLowerCase()], ...formats])]) {
          if (!ENCODE[format]) continue;
          const from = path.join(cache, `${hash}-${KEY}-${width}.${format}`);
          const height = await encode(from, bytes, width, format);
          const to = variantPath(src, width, format);
          variants.push({ src: to, width, height, type: typeOf(to) });
          copies.push({ from, to });
        }
      }
      if (variants.length) entry.variants = variants;
    } catch (error) {
      log(`werft: ${src} keeps its original size only (${error.message})`);
    }
  };
  // A few images at a time; sharp spreads each over its own threads too.
  const queue = [...candidates];
  await Promise.all(Array.from({ length: Math.min(queue.length, Math.max(1, os.availableParallelism() >> 1)) }, async () => {
    while (queue.length) await work(queue.shift());
  }));
  // Copies of images that changed or are gone are not needed again.
  const used = new Set(copies.map((c) => path.basename(c.from)));
  for (const name of await fs.readdir(cache).catch(() => [])) if (!used.has(name)) await fs.rm(path.join(cache, name), { force: true }).catch(() => {});
  return copies;
}
