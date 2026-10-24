// A page's new address: the links in the content that lead to the old one, and the redirects. Plain
// functions without the browser, so the editor and the tests share them.

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Returns (target) → target: a link target that leads to the page `from` ("alt.html", "./alt.html",
// "alt.html#anfrage", "/<base>/alt.html", "en/alt.html", "../alt.html") then leads to `to`, anything
// else stays as it is. base: the site's path ("/" or "/salon/"); languages: the site's codes.
export function retargetLink(from, to, { base = '/', languages = [] } = {}) {
  const prefix = `(?:${escapeRegExp(base)}|(?:\\.{1,2}/)*)`;
  const lang = languages.length > 1 ? `(?:(?:${languages.slice(1).map(escapeRegExp).join('|')})/)?` : '';
  const pattern = new RegExp(`^(${prefix}${lang})${escapeRegExp(from)}\\.html(?=$|[?#])`);
  return (target) => (typeof target === 'string' ? target.replace(pattern, `$1${to}.html`) : target);
}

// Links inside a text: the whole value, Markdown links ([Text](alt.html "Titel")) and href="…".
function retargetText(text, retarget) {
  const whole = retarget(text);
  if (whole !== text) return whole;
  return text
    .replace(/(\]\(\s*<?)([^\s)>]+)/g, (m, start, target) => start + retarget(target))
    .replace(/(\bhref\s*=\s*["'])([^"']+)/gi, (m, start, target) => start + retarget(target));
}

// `data` with every link to the old page retargeted (a copy), and whether anything changed.
export function retargetLinks(data, retarget) {
  let changed = false;
  const walk = (value) => {
    if (typeof value === 'string') {
      const next = retargetText(value, retarget);
      if (next !== value) changed = true;
      return next;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  const out = walk(data);
  return { data: out, changed };
}

// Whether `data` still names the page `slug` somewhere (a full address, a link the editor cannot
// read), so the editor can list it for checking.
export function mentions(data, slug) {
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(slug)}\\.html`).test(JSON.stringify(data));
}

// The redirects after a page moved from each `from` address to its `to` (moves: [{ from, to }]):
// a redirect for each move; earlier redirects that led to an old address lead to the new one, and
// a redirect away from a new address (the page had it before) is dropped, so none loops.
export function movedRedirects(redirects = [], moves) {
  const next = new Map(moves.map((m) => [m.from, m.to]));
  const kept = redirects
    .filter((r) => !moves.some((m) => m.to === r.from) && !next.has(r.from))
    .map((r) => (next.has(r.to) ? { ...r, to: next.get(r.to) } : r));
  return [...kept, ...moves.map((m) => ({ from: m.from, to: m.to, status: 301 }))];
}
