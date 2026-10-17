// Rich text in the visual editor: an editable element holds the HTML that the site's Markdown
// renders, and its content is turned back into Markdown on every change. Only what the CMS's
// rich-text field offers survives: paragraphs, line breaks, bold, italic, links, headings, lists.
import { markdown } from 'werft';

const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'section', 'article']);

function inline(node) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += child.data.replace(/ /g, ' '); continue; }
    if (child.nodeType !== 1) continue;
    const name = child.localName;
    const inner = inline(child);
    if (name === 'br') out += '\n';
    else if (!inner.trim()) out += inner;
    else if (name === 'strong' || name === 'b') out += `**${inner}**`;
    else if (name === 'em' || name === 'i') out += `*${inner}*`;
    else if (name === 'a') out += `[${inner}](${child.getAttribute('href') ?? ''})`;
    else if (BLOCKS.has(name)) out += `\n${inner}\n`;
    else out += inner;
  }
  return out;
}

const tidy = (text) => text.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();

export function toMarkdown(root) {
  const blocks = [];
  let run = '';
  const flush = () => { if (tidy(run)) blocks.push(tidy(run)); run = ''; };
  for (const child of root.childNodes) {
    const name = child.nodeType === 1 ? child.localName : '';
    if (!BLOCKS.has(name)) { run += child.nodeType === 3 ? child.data : child.nodeType === 1 ? inline({ childNodes: [child] }) : ''; continue; }
    flush();
    if (name === 'ul' || name === 'ol') {
      const items = [...child.children].filter((li) => li.localName === 'li').map((li, i) => `${name === 'ol' ? `${i + 1}.` : '-'} ${tidy(inline(li)).replace(/\n/g, ' ')}`);
      if (items.length) blocks.push(items.join('\n'));
    } else if (/^h[1-6]$/.test(name)) {
      const text = tidy(inline(child)).replace(/\n/g, ' ');
      if (text) blocks.push(`${'#'.repeat(Number(name[1]))} ${text}`);
    } else if (name === 'blockquote') {
      const text = toMarkdown(child);
      if (text) blocks.push(text.split('\n').map((line) => `> ${line}`).join('\n'));
    } else if (child.querySelector(':scope > p, :scope > div, :scope > ul, :scope > ol, :scope > h2, :scope > h3')) {
      const text = toMarkdown(child);
      if (text) blocks.push(text);
    } else {
      const text = tidy(inline(child));
      if (text) blocks.push(text);
    }
  }
  flush();
  return blocks.join('\n\n');
}

// Whether a text survives being edited this way. Markdown the conversion cannot write back (code,
// images, nested lists, escaped characters) is edited as Markdown source instead.
export function editableAsRich(value) {
  const html = markdown(value);
  return markdown(toMarkdown(new DOMParser().parseFromString(html, 'text/html').body)) === html;
}

// A small formatting bar for an editable element in `doc` (the page frame or the editor itself).
export function formatBar(doc, onChange) {
  const bar = document.createElement('div');
  bar.className = 've-format';
  const commands = [
    ['Fett', 'Markierten Text fett', () => doc.execCommand('bold'), 've-fmt-bold'],
    ['Kursiv', 'Markierten Text kursiv', () => doc.execCommand('italic'), 've-fmt-italic'],
    ['Link', 'Markierten Text verlinken', () => {
      const url = prompt('Adresse des Links (z. B. kontakt.html oder https://…)');
      if (url) doc.execCommand('createLink', false, url);
    }],
    ['Überschrift', 'Zwischenüberschrift', () => doc.execCommand('formatBlock', false, 'h2')],
    ['Kleine Überschrift', 'Kleine Überschrift', () => doc.execCommand('formatBlock', false, 'h3')],
    ['Normaler Text', 'Normaler Absatz', () => doc.execCommand('formatBlock', false, 'p')],
    ['• Liste', 'Aufzählung', () => doc.execCommand('insertUnorderedList')],
    ['1. Liste', 'Nummerierte Liste', () => doc.execCommand('insertOrderedList')],
  ];
  for (const [text, label, run, className] of commands) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.title = label;
    if (className) button.className = className;
    // The selection stays in the edited element while the button is pressed.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => { run(); onChange(); });
    bar.append(button);
  }
  return bar;
}
