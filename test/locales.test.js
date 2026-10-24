// The admin's texts per locale (admin/i18n.js, admin/locales/) and the gateway's messages
// (gateway/messages.js): every text has a key, every locale has the same keys, a missing text falls
// back to German, and werft's own field labels have each locale's text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { LOCALES, DEFAULT_LOCALE, FIELD_TEXTS, t, setLocale, locale, browserLocale, fieldText } from '../admin/i18n.js';
import { MESSAGES } from '../gateway/messages.js';
import { schema } from '../lib/schema.js';
import * as fields from '../lib/fields.js';

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
    // The texts, then the field texts (export const fields), each object on its own.
    for (const part of (await readFile(new URL(`locales/${code}.js`, ADMIN), 'utf8')).split(/^export const fields/m)) {
      const keys = [...part.matchAll(/^ {2}(?:'([^']+)'|([^\s':]+)):/gm)].map((m) => m[1] ?? m[2]);
      assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), [], `${code}.js`);
    }
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
  LOCALES.xx = {};
  try {
    assert.equal(browserLocale(['fr-FR', 'xx-YY', 'de-AT']), 'xx');
    assert.equal(browserLocale(['fr-FR', 'de-AT', 'xx']), 'de');
    assert.equal(browserLocale(['xxx-YY']), 'de', 'the whole language code counts');
    assert.equal(browserLocale(['fr-FR']), 'de');
    assert.equal(browserLocale([]), 'de');
  } finally { delete LOCALES.xx; }
});

test('the gateway has messages in the admin\'s locales, with the same keys, and uses each', async () => {
  assert.deepEqual(Object.keys(MESSAGES).sort(), Object.keys(LOCALES).sort());
  const placeholders = (text) => (typeof text === 'function' ? 'function' : [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join());
  for (const [code, texts] of Object.entries(MESSAGES)) {
    assert.deepEqual(Object.keys(texts).sort(), Object.keys(MESSAGES.de).sort(), code);
    for (const key of Object.keys(texts)) assert.equal(placeholders(texts[key]), placeholders(MESSAGES.de[key]), `${code}: ${key}`);
  }
  const dir = new URL('../gateway/', import.meta.url);
  const files = [...(await readdir(dir)).filter((f) => f.endsWith('.js') && f !== 'messages.js'), ...(await readdir(new URL('storage/', dir))).map((f) => `storage/${f}`)];
  const code = (await Promise.all(files.map((f) => readFile(new URL(f, dir), 'utf8')))).join('\n');
  // Keys are passed as t('…'), returned (denial(), mayChange()) or handed on (tooMany, a driver's reason).
  const spaces = new Set(Object.keys(MESSAGES.de).filter((key) => key.includes('.')).map((key) => key.split('.')[0]));
  for (const [, key, space] of code.matchAll(/'((\w+)\.\w+)'/g)) if (spaces.has(space)) assert.ok(Object.hasOwn(MESSAGES.de, key), `'${key}' has no German message`);
  for (const [, key] of code.matchAll(/\bt\('([^']+)'/g)) assert.ok(Object.hasOwn(MESSAGES.de, key), `t('${key}') has no German message`);
  assert.deepEqual(Object.keys(MESSAGES.de).filter((key) => !code.includes(`'${key}'`)), [], 'messages no code uses');
});

// Every label, hint, description and choice of the admin schema, for a theme that uses each of
// werft's field builders; the theme's own labels start with "Theme".
function schemaTexts() {
  const theme = {
    blocks: { hero: { label: 'Theme hero', fields: [fields.link(), fields.picture(), fields.string('heading', 'Theme heading')] } },
    menus: { main: 'Theme menu' },
    postType: { name: 'events', label: 'Theme events', singular: 'Theme event', fields: [fields.string('title', 'Theme title'), fields.date('date', 'Theme date'), fields.terms('tags', 'Theme tags')] },
    taxonomies: [{ name: 'tags', label: 'Theme tags', singular: 'Theme tag' }],
    settingsFields: [fields.organization()],
    formFields: [fields.string('intro', 'Theme intro')],
  };
  const texts = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const key of ['label', 'hint', 'description']) if (typeof node[key] === 'string') texts.add(node[key]);
    for (const option of node.options ?? []) if (typeof option === 'object') texts.add(option.label);
    for (const key of ['fields', 'types', 'field', 'files', 'collections']) walk(node[key]);
  };
  for (const site of [{ contentDir: 'content' }, { contentDir: 'content', languages: ['de', 'en'] }]) {
    for (const lang of [undefined, 'en']) walk(schema({ site, theme, lang }));
  }
  // Labels without words (arrows) and the theme's stay as they are.
  return [...texts].filter((text) => /\p{L}/u.test(text) && !text.startsWith('Theme'));
}

test('werft\'s own field labels, hints and choices have a text in every locale, and no other', () => {
  const texts = schemaTexts();
  // The labels of collections and settings files are shown through the admin's own texts.
  const shownElsewhere = new Set(['Seiten', 'Seite', 'Formulare', 'Formular', 'Website', 'Menüs', 'Einstellungen', 'Abschnitte, die auf mehreren Seiten gleich erscheinen. Eine Änderung wirkt überall.']);
  for (const [code, table] of Object.entries(FIELD_TEXTS)) {
    assert.deepEqual(texts.filter((text) => !shownElsewhere.has(text) && !Object.hasOwn(table, text)), [], `${code}: missing`);
    assert.deepEqual(Object.keys(table).filter((text) => !texts.includes(text)), [], `${code}: no longer werft's`);
  }
  assert.deepEqual(Object.keys(FIELD_TEXTS).sort(), Object.keys(LOCALES).filter((code) => code !== DEFAULT_LOCALE).sort());
  setLocale('en');
  try {
    assert.equal(fieldText('Alternativtext'), 'Alternative text');
    assert.equal(fieldText('Theme heading'), 'Theme heading', 'a theme\'s label stays');
    assert.equal(fieldText(undefined), undefined);
  } finally { setLocale('de'); }
  assert.equal(fieldText('Alternativtext'), 'Alternativtext');
});
