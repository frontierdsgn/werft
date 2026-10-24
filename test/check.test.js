// `werft check`: each rule on a build held in memory, then the command on a site on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from '../lib/check.js';
import { build, html } from '../lib/index.js';

const cli = fileURLToPath(new URL('../bin/werft.js', import.meta.url));

// A build: { path: text } for HTML and CSS, { path: size } for other files.
const files = (map) => Object.entries(map).map(([p, v]) => (typeof v === 'number' ? { path: p, size: v } : { path: p, size: v.length, text: v }));
const run = (map, options = {}) => check({ files: files(map), ...options });
const rules = (result) => result.findings.map((f) => `${f.file}:${f.line}:${f.column} ${f.severity} ${f.rule}`);

test('a clean build has no findings', () => {
  const result = run({
    'index.html': '<a href="kontakt.html#form">K</a><a href="./">Start</a><a href="team/">Team</a><a href="team">Team</a><a href="/kontakt.html?x=1">K</a><a href="#top">Top</a><a href="#">Nichts</a>'
      + '<a href="https://example.org/missing.html">Ext</a><a href="mailto:a@b.de">M</a><a href="tel:+49">T</a><a href="//cdn.example/x.js">C</a>'
      + '<img src="assets/img/a.jpg" alt="Fähre" srcset="assets/img/a.jpg 1x, assets/img/a%20b.jpg 2x"><img src="data:image/png;base64,AAAA" alt="">'.replace('alt=""', 'alt="" role="presentation"')
      + '<link rel="stylesheet" href="assets/site.css"><link rel="canonical" href="https://example.org/"><script src="assets/site.js"></script>'
      + '<form method="post" action="/api/werft/forms/anfrage"></form><a href="/api/werft/tick">Tick</a><div style="background:url(\'assets/img/a.jpg\')"></div>',
    'kontakt.html': '<section id="form"></section>',
    'team/index.html': '<p>Team</p>',
    'assets/site.css': '/* url(gone.png) */ body { background: url(img/a.jpg) } .x { mask: url("#m") }',
    'assets/site.js': 'x',
    'assets/img/a.jpg': 10,
    'assets/img/a b.jpg': 10,
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.pages, 3);
});

test('broken-link: a link to a page or file that is not in the build, with file, line and column', () => {
  const result = run({
    'index.html': '<!doctype html>\n<nav>\n  <a href="preise.html">Preise</a> <a href="../../x.html">X</a> <a href="kontakt">K</a></nav>',
    'kontakt.html': '',
  });
  assert.deepEqual(rules(result), ['index.html:3:6 error broken-link', 'index.html:3:39 error broken-link', 'index.html:3:68 error broken-link']);
  assert.match(result.findings[0].message, /"preise\.html": there is no preise\.html in the build/);
  assert.match(result.findings[1].message, /leads above the root of the site/);
  assert.match(result.findings[2].message, /kontakt\.html exists, but only some hosts serve it without "\.html"/);
});

test('broken-link: redirects are followed and checked', () => {
  const redirects = [{ from: '/alt/*', to: '/neu/:splat' }, { from: '/preise.html', to: '/kontakt.html' }, { from: '/team.html', to: '/mitarbeiter.html' }];
  const result = run({ 'index.html': '<a href="alt/seite.html">A</a><a href="preise.html">P</a>', 'kontakt.html': '' }, { redirects });
  assert.deepEqual(rules(result), ['_redirects:3:1 error broken-link']);
  assert.match(result.findings[0].message, /from \/team\.html leads to \/mitarbeiter\.html/);
});

test('broken-anchor: a link to an id that is not on its page', () => {
  const result = run({
    'index.html': '<h2 id="angebot">A</h2><a href="#angebot">ok</a><a href="#anfahrt">Anfahrt</a><a href="kontakt.html#formular">K</a><a href="kontakt.html#alt">alt</a>',
    'kontakt.html': '<a name="alt"></a><form id="anfrage"></form>',
  });
  assert.deepEqual(rules(result), ['index.html:1:52 error broken-anchor', 'index.html:1:82 error broken-anchor']);
  assert.match(result.findings[1].message, /kontakt\.html has no element with id "formular"/);
});

test('untranslated-link: a language page links to its version of a page it does not have', () => {
  const site = { languages: ['de', 'en'] };
  const result = run({
    'index.html': '', 'impressum.html': '', 'en/index.html': '<a href="/en/impressum.html">Imprint</a><a href="../impressum.html">ok</a><a href="/en/fehlt.html">x</a>',
  }, { site });
  assert.deepEqual(rules(result), ['en/index.html:1:4 error untranslated-link', 'en/index.html:1:78 error broken-link']);
  assert.match(result.findings[0].message, /leads to en\/impressum\.html, a page "en" does not have; the "de" page is impressum\.html\. Write the link relative to the page \(e\.g\. "impressum\.html"\)/);
  // Below a base path, too.
  const below = run({ 'salon/impressum.html': '', 'salon/en/index.html': '<a href="/salon/en/impressum.html">Imprint</a>' }, { site: { ...site, base: 'salon' } });
  assert.deepEqual(rules(below), ['salon/en/index.html:1:4 error untranslated-link']);
});

test('untranslated-link: links the build leads to the default language pass, others are found', async () => {
  const store = (map) => ({
    list: async (dir) => Object.keys(map).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
    readText: async (p) => { if (!(p in map)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return map[p]; },
  });
  const site = { name: 'S', languages: ['de', 'en'] };
  const theme = {
    blocks: {},
    menus: { footer: 'Fuß' },
    renderPage: (page, ctx) => html`<title>${page.title}</title>${ctx.menu('footer').items.map((i) => html`<a href="${i.url}">${i.label}</a>`)}<a href="/${ctx.lang === 'de' ? '' : `${ctx.lang}/`}impressum.html">Impressum</a>`,
  };
  const page = (title) => JSON.stringify({ title, status: 'published' });
  const result = await build({ site, theme, media: {}, store: store({
    'content/pages/index.json': page('Start'), 'content/pages/impressum.json': page('Impressum'), 'content/en/pages/index.json': page('Home'),
    'content/settings/menus.json': JSON.stringify({ footer: { items: [{ label: 'Impressum', url: 'impressum.html' }] } }),
  }) });
  const { findings } = check({ files: result.files.map((f) => ({ path: f.path, size: f.text.length, text: f.text })), site });
  assert.deepEqual(findings.map((f) => `${f.file} ${f.rule} ${f.message.split('"')[1]}`), ['en/index.html untranslated-link /en/impressum.html']);
});

test('missing-file: images, sources, stylesheets, scripts and CSS references that are not in the build', () => {
  const result = run({
    'index.html': '<img src="assets/img/weg.jpg" alt="x"><picture><source srcset="assets/img/a.webp 1x, assets/img/b.webp 2x"></picture>'
      + '<link rel="stylesheet" href="assets/fehlt.css"><script src="assets/fehlt.js"></script><div style="background-image: url(assets/img/bg.jpg)"></div>'
      + '<style>\n.hero { background: url("assets/img/hero.jpg") }</style><video src="v.mp4" poster="assets/img/poster.jpg"></video>',
    'assets/site.css': '@import "fonts.css";\n@font-face { src: url(../fonts/inter.woff2) }',
    'assets/img/a.webp': 1,
  });
  assert.deepEqual(result.findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.message.split('"')[1]}`), [
    'assets/site.css:1 missing-file fonts.css',
    'assets/site.css:2 missing-file ../fonts/inter.woff2',
    'index.html:1 missing-file assets/img/weg.jpg',
    'index.html:1 missing-file assets/img/b.webp',
    'index.html:1 missing-file assets/fehlt.css',
    'index.html:1 missing-file assets/fehlt.js',
    'index.html:1 missing-file assets/img/bg.jpg',
    'index.html:2 missing-file assets/img/hero.jpg',
    'index.html:2 missing-file v.mp4',
    'index.html:2 missing-file assets/img/poster.jpg',
  ]);
});

test('missing-alt and empty-alt: images without alt text', () => {
  const result = run({
    'index.html': '<img src="a.jpg"><img src="a.jpg" alt=""><img src="a.jpg" alt=" "><img src="a.jpg" alt="" role="presentation"><img src="a.jpg" alt="" aria-hidden="true"><img id="lightbox" alt=""><img src="a.jpg" alt="Fähre">',
    'a.jpg': 1,
  });
  assert.deepEqual(rules(result), ['index.html:1:1 error missing-alt', 'index.html:1:18 warning empty-alt', 'index.html:1:42 warning empty-alt']);
  assert.match(result.findings[1].message, /fill in "Alternativtext" in the editor/);
});

test('large-file: files above check.maxFileSize, not counting the admin and _werft', () => {
  const map = { 'index.html': '', 'assets/img/foto.jpg': 10_000_000, 'assets/img/klein.jpg': 999_999, 'admin/vendor/big.js': 5_000_000, '_werft/media.json': 2_000_000 };
  assert.deepEqual(rules(run(map)), ['assets/img/foto.jpg:null:null warning large-file']);
  assert.match(run(map).findings[0].message, /^10\.0 MB, more than 1\.0 MB/);
  assert.deepEqual(rules(run(map, { site: { check: { maxFileSize: 500_000 } } })).length, 2);
});

test('check in werft.config.js: rules change a level, ignore leaves paths out, mistakes are refused', () => {
  const map = { 'index.html': '<img src="a.jpg" alt=""><a href="weg.html">x</a>', 'alt/seite.html': '<a href="nirgends.html">x</a>', 'a.jpg': 1 };
  const result = run(map, { site: { check: { rules: { 'empty-alt': 'error', 'broken-link': 'warning' }, ignore: ['alt/'] } } });
  assert.deepEqual(rules(result), ['index.html:1:1 error empty-alt', 'index.html:1:28 warning broken-link']);
  assert.deepEqual(rules(run(map, { site: { check: { rules: { 'broken-link': 'off', 'empty-alt': 'off' } } } })), []);
  assert.throws(() => run(map, { site: { check: { rules: { 'dead-link': 'error' } } } }), /unknown rule "dead-link"/);
  assert.throws(() => run(map, { site: { check: { rules: { 'empty-alt': 'fatal' } } } }), /must be 'error', 'warning', 'off'/);
  assert.throws(() => run(map, { site: { check: { maxFileSize: '1 MB' } } }), /maxFileSize must be a number of bytes/);
});

test('a finding names where its address is written in the content or theme', () => {
  const sources = [
    { path: 'content/settings/menus.json', text: '{\n  "main": {\n    "items": [{ "url": "preise.html" }]\n  }\n}' },
    { path: 'theme/index.js', text: "html`<link href=\"${ctx.url('assets/css/site.css')}\">`" },
  ];
  const result = run({ 'en/index.html': '<a href="preise.html">P</a><link rel="stylesheet" href="../assets/css/site.css">' }, { sources, site: { languages: ['de', 'en'] } });
  assert.deepEqual(result.findings.map((f) => f.sources), [['content/settings/menus.json:3'], ['theme/index.js:1']]);
});

// A site on disk with a broken link from its menu, an image that is missing and one without alt text.
function site(t, { content = {}, config = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'werft-check-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write('werft.config.js', `export default { name: 'T', theme: './theme/index.js', mediaDirs: ['assets/img'], output: '_site'${config} };\n`);
  write('theme/index.js', [
    "const md = (s, ctx) => ctx.md(s);",
    'export default {',
    '  blocks: { text: { label: "Text", fields: [], render: (s, ctx) => ctx.html`<section>${md(s.body, ctx)}</section>` } },',
    '  menus: { main: "Haupt" },',
    '  renderPage: (page, ctx) => ctx.html`<title>${page.title}</title><nav>${ctx.menu("main").items.map((i) => ctx.html`<a href="${i.url}">${i.label}</a>`)}</nav>${ctx.blocks(page.sections)}`,',
    '};',
  ].join('\n'));
  write('assets/img/a.jpg', 'jpg');
  const files = {
    'content/pages/index.json': JSON.stringify({ title: 'Start', status: 'published', sections: [{ type: 'text', body: '![Fähre](assets/img/a.jpg)' }] }, null, 2),
    'content/settings/menus.json': JSON.stringify({ main: { items: [{ label: 'Start', url: 'index.html' }] } }, null, 2),
    ...content,
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  return root;
}
const werft = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('werft check builds the site elsewhere, prints each problem once with its places and fails on errors', (t) => {
  const root = site(t, { content: {
    'content/settings/menus.json': JSON.stringify({ main: { items: [{ label: 'Start', url: 'index.html' }, { label: 'Preise', url: 'preise.html' }] } }, null, 2),
    'content/pages/team.json': JSON.stringify({ title: 'Team', status: 'published', sections: [{ type: 'text', body: '![](assets/img/a.jpg) ![Weg](assets/img/weg.jpg)' }] }, null, 2),
  } });
  const result = werft('check', root);
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.deepEqual(lines.slice(0, -1), [
    'error broken-link: "preise.html": there is no preise.html in the build',
    '  at index.html:1:59, team.html:1:58',
    '  written in content/settings/menus.json:10',
    'warning empty-alt: the image "assets/img/a.jpg" has no alt text: fill in "Alternativtext" in the editor, or mark it as decoration with role="presentation"',
    '  at team.html:1:105',
    '  written in content/pages/index.json:7, content/pages/team.json:7',
    'error missing-file: "assets/img/weg.jpg": there is no assets/img/weg.jpg in the build',
    '  at team.html:1:146',
    '  written in content/pages/team.json:7',
  ]);
  assert.match(lines.at(-1), /^3 errors, 1 warning in 2 pages and \d+ files, checked in \d+ ms$/);
  assert.ok(!fs.existsSync(path.join(root, '_site')), 'the site\'s output directory is left alone');
});

test('werft check passes with warnings only, and --strict fails on them', (t) => {
  const root = site(t, { content: {
    'content/pages/index.json': JSON.stringify({ title: 'Start', status: 'published', sections: [{ type: 'text', body: '![](assets/img/a.jpg)' }] }),
  } });
  const result = werft('check', root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /0 errors, 1 warning in 1 pages/);
  assert.equal(werft('check', '--strict', root).status, 1);
  assert.equal(werft('check', root, '--strict').status, 1);
});

test('werft check stops on a mistake in check of werft.config.js', (t) => {
  const root = site(t, { config: ", check: { rules: { 'empty-alt': 'loud' } }" });
  const result = werft('check', root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /check\.rules\["empty-alt"\] must be/);
});
