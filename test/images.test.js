// Images: which uploads the editor scales down before they are committed, and the responsive
// images themes write from the variants beside a media image.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downscaleTarget, maxSize, MAX_SIZE } from '../lib/images.js';
import { build, createContext, html } from '../lib/index.js';

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (name, data = []) => [...u32(data.length), ...Buffer.from(name), ...data, 0, 0, 0, 0];
// The first bytes of a file, as far as the size and the format are read from them.
const png = (width, height, { animated = false } = {}) => Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
  ...(animated ? chunk('acTL', [...u32(2), ...u32(0)]) : []),
  ...chunk('IDAT', [0]),
]);
const jpeg = (width, height) => Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3]);
const webp = (width, height, { animated = false } = {}) => {
  const b = new Uint8Array(30);
  b.set(Buffer.from('RIFF'), 0);
  b.set(Buffer.from('WEBPVP8X'), 8);
  b[20] = animated ? 0x12 : 0x10;
  b.set([(width - 1) & 255, ((width - 1) >> 8) & 255, (width - 1) >> 16, (height - 1) & 255, ((height - 1) >> 8) & 255, (height - 1) >> 16], 24);
  return b;
};
const gif = (width, height) => Uint8Array.from([...Buffer.from('GIF89a'), width & 255, width >> 8, height & 255, height >> 8]);

test('an upload larger than the limit is scaled to it on its longer edge, in its own format', () => {
  assert.deepEqual(downscaleTarget(jpeg(6000, 4000)), { type: 'image/jpeg', quality: 0.85, width: 2560, height: 1707 });
  assert.deepEqual(downscaleTarget(jpeg(3000, 4500), 1600), { type: 'image/jpeg', quality: 0.85, width: 1067, height: 1600 });
  // PNG stays PNG, so its transparency is kept.
  assert.deepEqual(downscaleTarget(png(5120, 5120)), { type: 'image/png', quality: undefined, width: 2560, height: 2560 });
  assert.equal(downscaleTarget(webp(4000, 3000)).type, 'image/webp');
});

test('small images, animations, GIFs and other files stay as they are', () => {
  assert.equal(downscaleTarget(jpeg(2560, 1200)), null, 'not larger than the limit: never scaled up');
  assert.equal(downscaleTarget(png(800, 600)), null);
  assert.equal(downscaleTarget(png(6000, 4000, { animated: true })), null);
  assert.equal(downscaleTarget(webp(6000, 4000, { animated: true })), null);
  assert.equal(downscaleTarget(gif(6000, 4000)), null);
  assert.equal(downscaleTarget(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(downscaleTarget(new TextEncoder().encode('%PDF-1.7')), null);
});

test('werft.config.js sets the limit or turns scaling off', () => {
  assert.equal(maxSize({}), MAX_SIZE);
  assert.equal(maxSize({ images: { maxSize: 1600 } }), 1600);
  assert.equal(downscaleTarget(jpeg(6000, 4000), maxSize({ images: { maxSize: false } })), null);
  assert.equal(downscaleTarget(jpeg(6000, 4000), maxSize({ images: { maxSize: 0 } })), null);
  assert.equal(downscaleTarget(jpeg(6000, 4000), -1), null);
});

// A media index as the Node build writes it (variants.js): a.jpg with copies, b.png without.
const variant = (width, format) => ({ src: `_werft/img/assets/img/a.${width}.${format}`, width, height: Math.round((1707 * width) / 2560), type: `image/${format === 'jpg' ? 'jpeg' : format}` });
const media = {
  'assets/img/a.jpg': { width: 2560, height: 1707, variants: [variant(480, 'jpg'), variant(480, 'webp'), variant(480, 'avif'), variant(960, 'jpg'), variant(960, 'webp')] },
  'assets/img/b.png': { width: 800, height: 600 },
};
const memoryStore = (files) => ({
  list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)).sort(),
  readText: async (path) => { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[path]; },
});
const page = (title, sections) => JSON.stringify({ title, status: 'published', sections });
const theme = {
  blocks: {
    hero: { render: (s, ctx) => ctx.img(s.image, { sizes: '50vw', class: 'hero' }) },
    plain: { render: (s, ctx) => html`${ctx.img(s.src)}${ctx.img('https://example.org/x.jpg', { alt: 'X', loading: 'eager' })}${ctx.img(undefined)}${ctx.img(s.src, { width: 400, height: false, src: 'other.png', srcset: 'x 1w' })}` },
  },
  renderPage: (p, ctx) => ctx.blocks(p.sections),
};
const sections = (alt) => [{ type: 'hero', image: { src: 'assets/img/a.jpg', alt } }, { type: 'plain', src: 'assets/img/b.png' }];

test('ctx.img writes srcset, sizes, width, height and lazy loading, with modern formats first', async () => {
  const site = { mediaDirs: ['assets/img'], languages: ['de', 'en'] };
  const store = memoryStore({ 'content/pages/index.json': page('Start', sections('Fähre')), 'content/en/pages/index.json': page('Home', sections('Ferry')) });
  const { files } = await build({ site, theme, store, media });
  const text = (path) => files.find((f) => f.path === path).text;
  const expected = (prefix, alt) => `<picture><source type="image/avif" srcset="${prefix}_werft/img/assets/img/a.480.avif 480w" sizes="50vw">`
    + `<source type="image/webp" srcset="${prefix}_werft/img/assets/img/a.480.webp 480w, ${prefix}_werft/img/assets/img/a.960.webp 960w" sizes="50vw">`
    + `<img src="${prefix}assets/img/a.jpg" alt="${alt}" srcset="${prefix}_werft/img/assets/img/a.480.jpg 480w, ${prefix}_werft/img/assets/img/a.960.jpg 960w, ${prefix}assets/img/a.jpg 2560w" sizes="50vw" width="2560" height="1707" loading="lazy" decoding="async" class="hero"></picture>`
    // Without copies: the size and lazy loading; elsewhere only what is given; nothing without a
    // file; the theme's width replaces the file's, while address and srcset stay the file's.
    + `<img src="${prefix}assets/img/b.png" alt="" width="800" height="600" loading="lazy" decoding="async">`
    + '<img src="https://example.org/x.jpg" alt="X" loading="eager" decoding="async">'
    + `<img src="${prefix}assets/img/b.png" alt="" width="400" loading="lazy" decoding="async">`;
  assert.equal(text('index.html'), expected('', 'Fähre'));
  // On the pages of another language every address leads back to the shared files.
  assert.equal(text('en/index.html'), expected('../', 'Ferry'));
});

test('ctx.image offers srcset and sources for a theme that writes its own markup; the preview shows originals', async () => {
  const context = (preview) => createContext({ site: {}, theme: { blocks: {} }, content: { pages: [], posts: [], patterns: [], forms: [], settings: {}, menus: {}, redirects: [] }, media, preview });
  const a = context(false).image('assets/img/a.jpg');
  assert.equal(a.srcset, '_werft/img/assets/img/a.480.jpg 480w, _werft/img/assets/img/a.960.jpg 960w, assets/img/a.jpg 2560w');
  assert.deepEqual(a.sources.map((s) => s.type), ['image/avif', 'image/webp']);
  assert.equal(a.width, 2560);
  assert.equal(context(false).image('assets/img/b.png').srcset, undefined);
  const shown = context(true);
  assert.equal(shown.image('assets/img/a.jpg').srcset, undefined);
  assert.equal(shown.img('assets/img/a.jpg').value, '<img src="assets/img/a.jpg" alt="" width="2560" height="1707" loading="lazy" decoding="async">');
});
