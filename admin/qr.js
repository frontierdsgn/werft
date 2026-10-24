// QR codes for the editor (the address an authenticator app reads when two-factor sign-in is set
// up): byte mode, error correction level M, versions 1 to 40 (up to 2331 bytes), the mask with the
// lowest penalty, as ISO/IEC 18004 describes. No dependencies; qrSVG() returns an SVG element's
// markup, qrMatrix() the modules (true = dark).

// Error correction level M per version (ISO/IEC 18004, table 9): blocks, and error correction
// codewords per block.
const BLOCK_COUNT = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const BLOCK_EC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = BLOCK_COUNT.map((count, ver) => [count, BLOCK_EC[ver]]);
// The centres of the alignment patterns along each axis.
function alignment(ver) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

// All codewords of a version (data and error correction).
function rawCodewords(ver) {
  let modules = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; modules -= (25 * n - 10) * n - 55; if (ver >= 7) modules -= 36; }
  return Math.floor(modules / 8);
}
const dataCodewords = (ver) => rawCodewords(ver) - BLOCKS[ver][0] * BLOCKS[ver][1];

// GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1.
function multiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}

// The error correction codewords of `data` (Reed-Solomon, `degree` of them).
export function reedSolomon(data, degree) {
  const divisor = Array(degree - 1).fill(0).concat([1]);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < divisor.length; j++) { divisor[j] = multiply(divisor[j], root); if (j + 1 < divisor.length) divisor[j] ^= divisor[j + 1]; }
    root = multiply(root, 2);
  }
  const result = Array(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= multiply(coef, factor); });
  }
  return result;
}

// The codewords to place: data in byte mode with padding, split into blocks, each with its error
// correction, interleaved.
function codewords(bytes, ver) {
  const capacity = dataCodewords(ver);
  const bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  const [count, ecLength] = BLOCKS[ver];
  const raw = rawCodewords(ver);
  const shortBlocks = count - (raw % count);
  const shortLength = Math.floor(raw / count);
  const blocks = [];
  for (let i = 0, k = 0; i < count; i++) {
    const block = data.slice(k, k + shortLength - ecLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = reedSolomon(block, ecLength);
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((block, j) => { if (i !== shortLength - ecLength || j >= shortBlocks) result.push(block[i]); });
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// The penalty of a symbol (rules 1 to 4 of the standard); the mask with the lowest one is used.
function penalty(m) {
  const size = m.length;
  let score = 0;
  const lines = [...m, ...m.map((_, x) => m.map((row) => row[x]))];
  for (const line of lines) {
    for (let i = 0, run = 1; i < size; i++, run++) {
      if (i + 1 < size && line[i + 1] === line[i]) continue;
      if (run >= 5) score += run - 2;
      run = 0;
    }
    const text = line.map((d) => (d ? 1 : 0)).join('');
    for (const pattern of ['10111010000', '00001011101']) for (let i = text.indexOf(pattern); i >= 0; i = text.indexOf(pattern, i + 1)) score += 40;
  }
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  const dark = m.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const ver = Array.from({ length: 40 }, (_, i) => i + 1).find((v) => 4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(v) * 8);
  if (!ver) throw new Error('Too long for a QR code here.');
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  const align = alignment(ver);
  for (const ax of align) for (const ay of align) {
    if ((ax === 6 && ay === 6) || (ax === 6 && ay === align.at(-1)) || (ax === align.at(-1) && ay === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = (mask) => {
    const data = (0b00 << 3) | mask; // level M
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }
  const data = codewords(bytes, ver);
  for (let right = size - 1, i = 0; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < data.length * 8) { modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }
  }
  const masked = (mask) => {
    format(mask);
    return modules.map((row, y) => row.map((dark, x) => (fixed[y][x] ? dark : dark !== MASKS[mask](x, y))));
  };
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = masked(mask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, matrix: candidate };
  }
  return best.matrix;
}

// The QR code as SVG markup, with the quiet zone of four modules around it.
export function qrSVG(text, { label = 'QR-Code' } = {}) {
  const m = qrMatrix(text);
  const n = m.length + 8;
  const path = m.flatMap((row, y) => row.map((dark, x) => (dark ? `M${x + 4} ${y + 4}h1v1h-1z` : ''))).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" role="img" aria-label="${label.replace(/[&<>"]/g, '')}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
