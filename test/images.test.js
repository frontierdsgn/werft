// Images: which uploads the editor scales down before they are committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downscaleTarget, maxSize, MAX_SIZE } from '../lib/images.js';

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
