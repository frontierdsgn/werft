// Images: which uploads the editor scales down, and the scaling itself (in the browser).
import { imageSize } from './image-size.js';

// The longer edge an upload may have, in pixels, unless werft.config.js sets `images.maxSize`
// (0 or false keeps every upload as it is). WordPress uses the same limit.
export const MAX_SIZE = 2560;
const QUALITY = { 'image/jpeg': 0.85, 'image/webp': 0.85, 'image/png': undefined };

export const maxSize = (site) => site?.images?.maxSize ?? MAX_SIZE;

// The format of a JPEG, PNG, GIF or WebP file from its first bytes, with `animated` for an
// animated PNG or WebP (canvas would keep only the first frame).
export function imageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ascii = (from, length) => String.fromCharCode(...b.subarray(from, from + length));
  if (b[0] === 0xff && b[1] === 0xd8) return { type: 'image/jpeg' };
  if (ascii(1, 3) === 'PNG') {
    // An animated PNG has an acTL chunk before its first image data.
    for (let i = 8; i + 8 <= b.length;) {
      const name = ascii(i + 4, 4);
      if (name === 'acTL') return { type: 'image/png', animated: true };
      if (name === 'IDAT') break;
      i += 12 + ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    }
    return { type: 'image/png' };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { type: 'image/webp', animated: ascii(12, 4) === 'VP8X' && (b[20] & 0x02) !== 0 };
  if (ascii(0, 3) === 'GIF') return { type: 'image/gif' };
  return undefined;
}

// A size scaled so that its longer edge is `max`.
export function fit(width, height, max) {
  const scale = max / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// What the editor does with an upload: null keeps the file as it is (not a JPEG, PNG or WebP,
// animated, of unknown size, or not larger than `max`); else the size it is scaled down to, in its
// own format. It never scales up.
export function downscaleTarget(bytes, max = MAX_SIZE) {
  const kind = imageType(bytes);
  const size = imageSize(bytes);
  if (!(max > 0) || !kind || kind.animated || !(kind.type in QUALITY) || !size?.width || !size?.height) return null;
  if (Math.max(size.width, size.height) <= max) return null;
  return { type: kind.type, quality: QUALITY[kind.type], ...fit(size.width, size.height, max) };
}

// Browser only: the upload scaled down and encoded again, as { bytes, width, height, from }, or
// null when it stays as it is (see downscaleTarget) or the result would not be smaller. The
// orientation a camera recorded is applied; other metadata (such as the location) is dropped.
export async function downscale(bytes, max = MAX_SIZE) {
  const target = downscaleTarget(bytes, max);
  if (!target) return null;
  const bitmap = await createImageBitmap(new Blob([bytes], { type: target.type }), { imageOrientation: 'from-image' });
  const from = { width: bitmap.width, height: bitmap.height };
  const { width, height } = fit(from.width, from.height, max);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: target.type, quality: target.quality });
  // A browser that cannot write the format returns PNG instead; the file name would then lie.
  if (blob.type !== target.type || blob.size >= bytes.length) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height, from };
}

// ---- Variants: smaller copies of a media image, for srcset ----
// The Node build makes them (variants.js) and lists them in the media index under their image as
// `variants` ({ src, width, height, type }, smallest first); themes get them through ctx.image()
// and ctx.img().
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' };
export const typeOf = (path) => TYPES[path.split('.').pop().toLowerCase()];

// srcset in the image's own format (its variants and the image itself) and one <source> per other
// format (AVIF, then WebP), with each address passed through `url`. Empty without variants.
export function responsive(src, entry, url = (path) => path) {
  const variants = entry?.variants ?? [];
  if (!variants.length || !entry.width) return {};
  const item = (path, width) => `${String(url(path)).replace(/ /g, '%20').replace(/,/g, '%2C')} ${width}w`;
  const list = (type) => variants.filter((v) => v.type === type).map((v) => item(v.src, v.width));
  const own = typeOf(src);
  const sources = ['image/avif', 'image/webp'].filter((type) => type !== own && list(type).length).map((type) => ({ type, srcset: list(type).join(', ') }));
  return { srcset: list(own).length ? [...list(own), item(src, entry.width)].join(', ') : undefined, sources };
}

// ---- Where the content names a media file ----
// A value names `path` (`assets/img/foto.jpg`) as it is stored: alone or after a space, quote,
// bracket or `=` (Markdown, HTML), directly, below `/` or below the site's root `root`
// (`/salon/`). An address on another host, another folder or a longer file name does not.
const escapeRE = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const naming = (path, root = '/') => new RegExp(`(^|[\\s("'=\\[,])(${escapeRE(root)}|/)?${escapeRE(path)}(?=$|[^\\p{L}\\p{N}_./-]|\\.(?![\\p{L}\\p{N}_]))`, 'gu');

// A copy of `data` in which every mention of the media file `from` names `to` instead.
export function replaceMedia(data, from, to, { root = '/' } = {}) {
  const pattern = naming(from, root);
  const walk = (value) => {
    if (typeof value === 'string') return value.replace(pattern, (_, before, prefix = '') => before + prefix + to);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(data);
}

// "Ersetzen" in the editor: every mention of `from` in the entries ([[path, data]]) for which
// `may(path)` holds names `to`. Returns the changed entries and `left`: whether any entry still
// mentions `from` in some form (then its file must stay).
export function replaceEverywhere(entries, from, to, { root = '/', may = () => true } = {}) {
  const changed = [];
  let left = false;
  for (const [path, data] of entries) {
    if (!data) continue;
    const next = may(path) ? replaceMedia(data, from, to, { root }) : data;
    if (JSON.stringify(next) !== JSON.stringify(data)) changed.push([path, next]);
    // The new file's own name may contain the old one (foto.jpg.png).
    const text = JSON.stringify(next);
    if ((to.includes(from) ? text.split(to).join('') : text).includes(from)) left = true;
  }
  return { changed, left };
}

// The picture fields ({ src, alt, … }) in `data` that show the media file `path`.
export function picturesOf(data, path, { root = '/' } = {}) {
  const pattern = naming(path, root);
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if (typeof value.src === 'string' && value.src.match(pattern)) found.push(value);
      Object.values(value).forEach(walk);
    }
  };
  walk(data);
  return found;
}

// A picture's focal point as CSS (`30% 70%`, for object-position), or undefined when it has none
// or the value is not a point.
export function focusOf(picture) {
  const value = typeof picture?.focus === 'string' ? picture.focus.trim() : '';
  return /^(100(\.0+)?|\d{1,2}(\.\d+)?)% (100(\.0+)?|\d{1,2}(\.\d+)?)%$/.test(value) ? value : undefined;
}
