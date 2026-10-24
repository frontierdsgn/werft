// The editor's QR codes (admin/qr.js), for setting up two-factor sign-in: the Reed-Solomon code
// against the standard's worked example, a whole symbol against libqrencode's output, and the
// structure of every version used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSVG, reedSolomon } from '../admin/qr.js';

test('error correction matches the worked example for 1-M', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(reedSolomon(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('a symbol matches libqrencode (qrencode -l M -8) module for module', () => {
  // qrencode 4.1.1 picks the same mask for this text, so the whole symbol must be the same.
  const expected = [
    '111111100111001111111', '100000100111001000001', '101110101100101011101', '101110101111001011101',
    '101110101001101011101', '100000101100101000001', '111111101010101111111', '000000001101100000000',
    '101111100100101111100', '111100000110100100101', '001001111101010010010', '110011001000000111110',
    '111010111101010010000', '000000001001111100101', '111111100000101101010', '100000101001111010101',
    '101110101010100101010', '101110101000100010100', '101110101111010101100', '100000100010000110100',
    '111111101001010101010',
  ];
  assert.deepEqual(qrMatrix('abc123').map((row) => row.map((d) => (d ? 1 : 0)).join('')), expected);
});

test('every version has its size, finder patterns and a valid format for level M', () => {
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  for (const [length, version] of [[10, 1], [20, 2], [30, 3], [50, 4], [70, 5], [90, 6], [110, 7], [130, 8], [160, 9], [200, 10], [240, 11], [500, 17], [1000, 26], [2331, 40]]) {
    const m = qrMatrix('x'.repeat(length)).map((row) => row.map((d) => (d ? 1 : 0)).join(''));
    const size = version * 4 + 17;
    assert.equal(m.length, size, `version ${version}`);
    for (const [x, y] of [[0, 0], [size - 7, 0], [0, size - 7]]) assert.deepEqual(m.slice(y, y + 7).map((r) => r.slice(x, x + 7)), finder);
    // The format bits around the top-left finder: level M (00) and a mask, with a valid BCH code.
    const bits = [0, 1, 2, 3, 4, 5, 7].map((y) => +m[y][8]).concat([+m[8][8], +m[8][7]], [5, 4, 3, 2, 1, 0].map((x) => +m[8][x]));
    const value = bits.reduce((v, b, i) => v | (b << i), 0) ^ 0x5412;
    let rem = value >> 10;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    assert.equal(value >> 13, 0, 'level M');
    assert.equal(value & 0x3ff, rem & 0x3ff, 'BCH');
  }
  assert.throws(() => qrMatrix('x'.repeat(2332)), /Too long/);
  // An authenticator address with a long site name and e-mail (218 bytes) fits.
  const url = `otpauth://totp/${encodeURIComponent('Praxis für Physiotherapie Müller')}:${encodeURIComponent('info@physio-mueller.de')}?secret=${'A'.repeat(32)}&issuer=${encodeURIComponent('Praxis für Physiotherapie Müller')}&algorithm=SHA1&digits=6&period=30`;
  assert.equal(qrMatrix(url).length, 11 * 4 + 17);
});

test('renders SVG with a quiet zone and a label', () => {
  const svg = qrSVG('abc123', { label: 'QR-Code für die App' });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29" role="img" aria-label="QR-Code für die App"/);
  assert.equal((svg.match(/h1v1h-1z/g) ?? []).length, qrMatrix('abc123').flat().filter(Boolean).length);
});
