// The orientation a camera recorded in a JPEG's Exif data (APP1, tag 0x0112), 1 when there is none.
function orientation(b, start, end) {
  if (String.fromCharCode(...b.subarray(start, start + 4)) !== 'Exif') return 1;
  const tiff = start + 6;
  const little = b[tiff] === 0x49;
  const u16 = (i) => (little ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  const u32 = (i) => (little ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000 : b[i] * 0x1000000 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]));
  const ifd = tiff + u32(tiff + 4);
  for (let n = 0, count = ifd + 2 <= end ? u16(ifd) : 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 1;
}

// Width and height from the header of a JPEG, PNG, GIF or WebP file; for a JPEG as it is shown, after
// the orientation the camera recorded (a photo taken upright is stored on its side).
export function imageSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  if (b[0] === 0x89 && b[1] === 0x50) return { width: u32(16), height: u32(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { width: u16le(6), height: u16le(8) };
  if (b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (kind === 'VP8L') {
      const n = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    let turned = false;
    while (i < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      if (marker === 0xe1) turned ||= orientation(b, i + 4, i + 2 + u16(i + 2)) >= 5;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return turned ? { width: u16(i + 5), height: u16(i + 7) } : { width: u16(i + 7), height: u16(i + 5) };
      }
      i += 2 + u16(i + 2);
    }
  }
  return undefined;
}
