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

const squeeze = (s) => s.replace(/\n\s*/g, '');

export function html(strings, ...values) {
  let out = squeeze(strings[0]);
  values.forEach((value, i) => { out += toHTML(value) + squeeze(strings[i + 1]); });
  return new Raw(out);
}

// Attribute helper: attr('id', x) renders ` id="x"` only when x is set.
export const attr = (name, value) => (value == null || value === false || value === '' ? raw('') : value === true ? raw(` ${name}`) : raw(` ${name}="${escape(value)}"`));

// Plain multi-line text: each line escaped, joined with <br>.
export const lines = (text) => raw(String(text ?? '').split(/\r?\n/).map(escape).join('<br>'));
