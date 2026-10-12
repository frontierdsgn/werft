import { Marked } from 'marked';
import { safeURL } from './html.js';

// Markdown as written by the rich-text editor: single newlines are line breaks, raw inline HTML is
// kept, and bare URLs or e-mail addresses are not turned into links.
const marked = new Marked({ gfm: true, breaks: true });
marked.use({ tokenizer: { url: () => undefined } });

const compact = (s) => s.replace(/>\n+</g, '><').trim();

// The HTML that may come out of Markdown: these tags with these attributes, rebuilt from their parts.
// Every other "<" is shown as text, so scripts, event handlers and javascript: links cannot get
// through, whoever wrote the text.
const TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'small', 'sub', 'sup', 'span', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ATTRIBUTES = { '*': ['class', 'title', 'lang'], a: ['href'], img: ['src', 'alt', 'width', 'height'], ol: ['start'], th: ['align'], td: ['align'] };
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/y;
const ATTRIBUTE = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

export function sanitize(html) {
  let out = '';
  let i = 0;
  for (let lt = html.indexOf('<'); lt >= 0; lt = html.indexOf('<', i)) {
    out += html.slice(i, lt);
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    const name = m?.[2].toLowerCase();
    if (!m || !TAGS.has(name)) { out += '&lt;'; i = lt + 1; continue; }
    if (m[1]) out += `</${name}>`;
    else {
      const allowed = [...ATTRIBUTES['*'], ...(ATTRIBUTES[name] ?? [])];
      const attributes = [...m[3].matchAll(ATTRIBUTE)].map(([, key, double, single]) => [key.toLowerCase(), double ?? single ?? ''])
        .filter(([key, value]) => allowed.includes(key) && (!['href', 'src'].includes(key) || safeURL(value)));
      out += `<${name}${attributes.map(([key, value]) => ` ${key}="${value.replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`).join('')}${m[4] ? ' /' : ''}>`;
    }
    i = TAG.lastIndex;
  }
  return out + html.slice(i);
}

// Block content: paragraphs, lists, headings.
export const markdown = (source) => sanitize(compact(marked.parse(String(source ?? ''))));
// Inline content for a single element (no surrounding <p>).
export const inline = (source) => sanitize(compact(marked.parseInline(String(source ?? ''))));
