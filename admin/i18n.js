// The admin's texts per locale (locales/<code>.js), German first and the default. A text is looked
// up by its key: t('save'), with values for its placeholders, t('pattern', { title }). A text may be
// a function of those values, for plurals and sentences that differ by more than a word. A key the
// locale lacks shows the German text.
import de from './locales/de.js';

export const LOCALES = { de };
export const DEFAULT_LOCALE = 'de';
let current = DEFAULT_LOCALE;

// The first of the browser's languages the admin has texts in, else German.
export function browserLocale(languages = globalThis.navigator?.languages ?? [globalThis.navigator?.language]) {
  return languages.map((l) => String(l ?? '').slice(0, 2).toLowerCase()).find((l) => Object.hasOwn(LOCALES, l)) ?? DEFAULT_LOCALE;
}

export const locale = () => current;
// For dates and numbers: the browser's variant of the locale (en-GB, de-AT), else the locale.
export const intlLocale = () => (globalThis.navigator?.languages ?? []).find((l) => l.toLowerCase().startsWith(`${current}-`)) ?? current;

export function t(key, values = {}) {
  const text = LOCALES[current][key] ?? de[key];
  if (text === undefined) return key;
  if (typeof text === 'function') return text(values);
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : match));
}

// Switches the texts; elements of the page marked with data-t (their text) or data-t-label,
// data-t-title, data-t-placeholder (that attribute) follow.
export function setLocale(code) {
  current = Object.hasOwn(LOCALES, code) ? code : DEFAULT_LOCALE;
  if (typeof document === 'undefined') return;
  document.documentElement.lang = current;
  for (const node of document.querySelectorAll('[data-t]')) node.textContent = t(node.dataset.t);
  for (const node of document.querySelectorAll('[data-t-label], [data-t-title], [data-t-placeholder]')) {
    for (const [data, attribute] of Object.entries(ATTRIBUTES)) if (node.dataset[data]) node.setAttribute(attribute, t(node.dataset[data]));
  }
}
const ATTRIBUTES = { tLabel: 'aria-label', tTitle: 'title', tPlaceholder: 'placeholder' };
