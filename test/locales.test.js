// The admin's texts per locale (admin/i18n.js, admin/locales/): every text the admin shows has a
// key, every locale has the same keys, and a missing text falls back to German.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { LOCALES, DEFAULT_LOCALE, t, setLocale, locale, browserLocale } from '../admin/i18n.js';

const ADMIN = new URL('../admin/', import.meta.url);
const sources = async () => Promise.all((await readdir(ADMIN)).filter((f) => /\.(js|html)$/.test(f) && f !== 'i18n.js')
  .map(async (f) => ({ file: f, text: await readFile(new URL(f, ADMIN), 'utf8') })));

test('every key the admin uses has a German text, and every German text is used', async () => {
  const de = LOCALES[DEFAULT_LOCALE];
  const used = new Set();
  for (const { file, text } of await sources()) {
    for (const [, key] of text.matchAll(/\bt\('([^']+)'/g)) { used.add(key); assert.ok(Object.hasOwn(de, key), `${file}: t('${key}') has no German text`); }
    for (const [, key] of text.matchAll(/\sdata-t(?:-[a-z]+)?="([^"]+)"/g)) { used.add(key); assert.ok(Object.hasOwn(de, key), `${file}: data-t "${key}" has no German text`); }
  }
  assert.deepEqual(Object.keys(de).filter((key) => !used.has(key)), [], 'German texts no code uses');
});

test('each key is written once in a locale file', async () => {
  for (const code of Object.keys(LOCALES)) {
    const text = await readFile(new URL(`locales/${code}.js`, ADMIN), 'utf8');
    const keys = [...text.matchAll(/^ {2}(?:'([^']+)'|([A-Za-z]\w*)):/gm)].map((m) => m[1] ?? m[2]);
    assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), [], `${code}.js`);
  }
});

test('every locale has the same keys as German, with the same placeholders', () => {
  const de = LOCALES[DEFAULT_LOCALE];
  const placeholders = (text) => (typeof text === 'function' ? 'function' : [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join());
  for (const [code, texts] of Object.entries(LOCALES)) {
    assert.deepEqual(Object.keys(texts).sort(), Object.keys(de).sort(), code);
    for (const key of Object.keys(de)) assert.equal(placeholders(texts[key]), placeholders(de[key]), `${code}: ${key}`);
  }
});

test('t() fills in values, runs text functions and falls back to German', () => {
  setLocale('de');
  assert.equal(t('source.pattern', { title: 'Anfahrt' }), 'Muster „Anfahrt“');
  assert.equal(t('previewLink.days', { count: 1 }), '1 Tag');
  assert.equal(t('previewLink.days', { count: 30 }), '30 Tage');
  assert.equal(t('no.such.key'), 'no.such.key');
  // A locale without a text: the German one.
  LOCALES.xx = { save: 'Save' };
  try {
    setLocale('xx');
    assert.equal(locale(), 'xx');
    assert.equal(t('save'), 'Save');
    assert.equal(t('cancel'), 'Abbrechen');
  } finally { delete LOCALES.xx; setLocale('de'); }
  setLocale('fr');
  assert.equal(locale(), 'de', 'an unknown locale is German');
});

test('the browser\'s first language the admin has texts in, else German', () => {
  assert.equal(browserLocale(['fr-FR', 'de-AT']), 'de');
  assert.equal(browserLocale(['fr-FR']), 'de');
  assert.equal(browserLocale([]), 'de');
});
