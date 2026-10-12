// Comparison of two versions of a content file for the Versionen page. The CMS rewrites a file in
// its field order and adds `false` for booleans nobody set, so a plain line diff shows changes that
// are none. JSON files are compared by content: both are written in the same key order, and a
// `false` that the other version lacks is left out.

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Returns copies of a and b with the same key order (b's first) and without one-sided `false`s.
function align(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return [a.map((v, i) => align(v, b[i])[0]), b.map((v, i) => align(a[i], v)[1])];
  }
  if (!isObject(a) || !isObject(b)) return [a, b];
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const x = {}, y = {};
  for (const key of keys) {
    if ((a[key] === false && !(key in b)) || (b[key] === false && !(key in a))) continue;
    const [p, q] = align(a[key], b[key]);
    if (key in a) x[key] = p;
    if (key in b) y[key] = q;
  }
  return [x, y];
}

const escapeHTML = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// Line diff (longest common subsequence); content files are small. Returns [kind, line] pairs,
// kind ' ', '-' (only in a) or '+' (only in b).
export function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  const m = x.length, n = y.length;
  const table = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; }
    else if (j < n && (i === m || table[i][j + 1] > table[i + 1][j])) out.push(['+', y[j++]]);
    else out.push(['-', x[i++]]);
  }
  return out;
}

// The changes from text a to text b, compared by content when both are JSON.
export function versionDiff(a, b) {
  let x = a, y = b;
  try {
    const [p, q] = align(JSON.parse(a), JSON.parse(b));
    x = JSON.stringify(p, null, 2);
    y = JSON.stringify(q, null, 2);
  } catch { /* not JSON: compare the text */ }
  return lineDiff(x, y);
}

export const diffHTML = (lines) => lines.map(([kind, line]) => {
  const text = `${kind} ${escapeHTML(line)}`;
  return kind === '+' ? `<ins>${text}</ins>` : kind === '-' ? `<del>${text}</del>` : text;
}).join('\n');
