// Tagged template for theme markup. Interpolated values are escaped unless wrapped in raw();
// newlines and the indentation after them in the template source are dropped, so templates can be
// written readably and still produce the compact markup of hand-written pages.

export class Raw {
  constructor(value) { this.value = value; }
  toString() { return this.value; }
}

export const raw = (value) => (value instanceof Raw ? value : new Raw(value == null ? '' : String(value)));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escape = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ESCAPES[c]);

const toHTML = (value) => {
  if (value == null || value === false) return '';
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(toHTML).join('');
  return escape(value);
};

// Whether a URL may go into href, src and similar attributes: relative, or http(s), mailto or tel.
// A javascript: URL runs when the link is followed, on the origin the admin shares with the site.
const CHARACTER_REFERENCE = /&(?:#(x[0-9a-f]+|\d+)|(colon|tab|newline));?/gi;
const NAMED = { colon: ':', tab: '\t', newline: '\n' };
export function safeURL(value) {
  let plain;
  try {
    plain = String(value ?? '').replace(CHARACTER_REFERENCE, (_, code, name) => (name ? NAMED[name.toLowerCase()] : String.fromCodePoint(code[0] === 'x' || code[0] === 'X' ? parseInt(code.slice(1), 16) : Number(code))));
  } catch { return false; }
  plain = plain.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  return !/^[a-z][a-z0-9+.-]*:/i.test(plain) || /^(https?|mailto|tel):/i.test(plain);
}

const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'poster', 'cite'];
const URL_ATTRIBUTE = new RegExp(`\\s(${URL_ATTRIBUTES.join('|')})="$`, 'i');
const squeeze = (s) => s.replace(/\n\s*/g, '');

export function html(strings, ...values) {
  let out = squeeze(strings[0]);
  values.forEach((value, i) => {
    const unsafe = !(value instanceof Raw) && URL_ATTRIBUTE.test(out) && !safeURL(value);
    out += (unsafe ? '#' : toHTML(value)) + squeeze(strings[i + 1]);
  });
  return new Raw(out);
}

// Attribute helper: attr('id', x) renders ` id="x"` only when x is set.
export const attr = (name, value) => {
  if (value == null || value === false || value === '') return raw('');
  if (value === true) return raw(` ${name}`);
  return raw(` ${name}="${URL_ATTRIBUTES.includes(name) && !safeURL(value) ? '#' : escape(value)}"`);
};

// Plain multi-line text: each line escaped, joined with <br>.
export const lines = (text) => raw(String(text ?? '').split(/\r?\n/).map(escape).join('<br>'));
