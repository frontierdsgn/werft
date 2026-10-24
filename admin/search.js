// The sidebar's search: which entries match what was typed, best first, with the text that
// matched. Plain functions, so the editor and the tests share them.

// Lower case, without accents and Markdown marks, so "uber" finds "Über" and "**Fähre**" is "fahre".
export const normalize = (text) => String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const MARKS = /[*_`#>~|]+|!?\[([^\]]*)\]\([^)]*\)/g;
const plain = (text) => text.replace(/<[^>]+>/g, ' ').replace(MARKS, (m, label) => label ?? ' ').replace(/\s+/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim();

// Keys whose values are not text a person reads: kinds, states, addresses, files, dates.
const SKIP = new Set(['type', 'status', 'publish_date', 'url', 'src', 'image', 'pattern', 'form', 'noindex', 'style']);

// The readable texts of an entry, in order.
export function textsOf(data) {
  const out = [];
  const walk = (value, key) => {
    if (SKIP.has(key)) return;
    if (typeof value === 'string') { const text = plain(value); if (text && !/^(https?:|mailto:|tel:|#|\/)/.test(text)) out.push(text); } else if (Array.isArray(value)) value.forEach((v) => walk(v));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(data);
  return out;
}

// entries: [{ source, title, texts: [string], … }]. Every word of the query must occur in the
// title or a text. Matches in the title come first (its start before elsewhere), then by title.
// Each result is the entry with `snippet`: the text around the first word, when the title lacks it.
export function search(entries, query, { limit = 30 } = {}) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const results = [];
  for (const entry of entries) {
    const title = normalize(entry.title ?? '');
    const texts = (entry.texts ?? []).map((t) => [t, normalize(t)]);
    const all = [title, ...texts.map(([, n]) => n)].join('\n');
    if (!words.every((w) => all.includes(w))) continue;
    const inTitle = words.filter((w) => title.includes(w)).length;
    const rank = title.startsWith(words[0]) ? 0 : inTitle === words.length ? 1 : inTitle ? 2 : 3;
    let snippet = '';
    if (inTitle < words.length) {
      const word = words.find((w) => !title.includes(w));
      const [text, normal] = texts.find(([, n]) => n.includes(word)) ?? ['', ''];
      // NFKD keeps the length of most Latin text, so the position carries over.
      // Whole words: from the word around 30 characters before to the one around 50 after.
      const at = normal.indexOf(word);
      const from = at > 30 ? text.lastIndexOf(' ', at - 30) + 1 : 0;
      let to = at + word.length + 50;
      if (to < text.length) to = Math.max(text.lastIndexOf(' ', to), at + word.length);
      snippet = `${from ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`;
    }
    results.push({ ...entry, snippet, rank });
  }
  return results.sort((a, b) => a.rank - b.rank || String(a.title).localeCompare(String(b.title), 'de')).slice(0, limit);
}
