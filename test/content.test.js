// Loading a site's content files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadContent } from '../lib/content.js';

const memoryStore = (files) => ({
  list: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
  readText: async (path) => { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[path]; },
});

test('files picked in the admin reach the theme relative to the site', async () => {
  const site = { base: 'classic', mediaDirs: ['assets/img'] };
  const page = { title: 'P', sections: [
    { image: { src: '/classic/assets/img/new.jpg' } }, // as the admin saves it
    { image: { src: 'assets/img/old.jpg' } },
    { link: { url: '/classic/kontakt.html' } }, // not a media file: unchanged
  ] };
  const content = await loadContent({ site, theme: {}, store: memoryStore({ 'content/pages/p.json': JSON.stringify(page) }) });
  assert.deepEqual(content.pages[0].sections, [{ image: { src: 'assets/img/new.jpg' } }, { image: { src: 'assets/img/old.jpg' } }, { link: { url: '/classic/kontakt.html' } }]);
});

test('content is read from the directory werft.config.js names', async () => {
  const content = await loadContent({ site: { content: 'inhalt' }, theme: {}, store: memoryStore({ 'inhalt/pages/p.json': '{"title":"P"}' }) });
  assert.equal(content.pages[0].title, 'P');
});
