import { Marked } from 'marked';

// Markdown as written by the rich-text editor: single newlines are line breaks, raw inline HTML is
// kept, and bare URLs or e-mail addresses are not turned into links.
const marked = new Marked({ gfm: true, breaks: true });
marked.use({ tokenizer: { url: () => undefined } });

const compact = (s) => s.replace(/>\n+</g, '><').trim();

// Block content: paragraphs, lists, headings.
export const markdown = (source) => compact(marked.parse(String(source ?? '')));
// Inline content for a single element (no surrounding <p>).
export const inline = (source) => compact(marked.parseInline(String(source ?? '')));
