// Node helpers: file-system store, site loading and writing a build to disk.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from './build.js';

const PACKAGE = path.resolve(fileURLToPath(import.meta.url), '../..');
const require = createRequire(import.meta.url);

export function fsStore(root) {
  async function walk(dir, prefix = '') {
    let entries;
    try { entries = await fs.readdir(path.join(root, dir, prefix), { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await walk(dir, rel)));
      else out.push(rel);
    }
    return out.sort();
  }
  return {
    list: (dir) => walk(dir),
    readText: (p) => fs.readFile(path.join(root, p), 'utf8'),
    readBytes: async (p) => new Uint8Array(await fs.readFile(path.join(root, p))),
  };
}

// Loads <dir>/werft.config.js and the theme it names.
export async function loadSite(dir) {
  const root = path.resolve(dir);
  const site = (await import(pathToFileURL(path.join(root, 'werft.config.js')).href)).default;
  const theme = (await import(pathToFileURL(path.join(root, site.theme)).href)).default;
  return { root, site, theme };
}

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  await fs.cp(from, to, { recursive: true, dereference: true });
}

// The admin: werft's editor, the browser half of werft and the site's configuration and theme
// (the editor renders pages with them), at <output>/<site.admin ?? 'admin'>/.
async function copyAdmin(root, site, theme, outDir) {
  const admin = path.join(outDir, site.admin ?? 'admin');
  await fs.cp(path.join(PACKAGE, 'admin'), admin, { recursive: true });
  await fs.cp(path.join(PACKAGE, 'lib'), path.join(admin, 'werft'), { recursive: true, filter: (src) => !['node.js', 'publish.js'].includes(path.basename(src)) });
  await fs.cp(require.resolve('marked'), path.join(admin, 'vendor/marked.esm.js'));
  await fs.cp(path.join(root, 'werft.config.js'), path.join(admin, 'site/werft.config.js'));
  const themeDir = path.dirname(path.resolve(root, site.theme));
  const staticDir = theme.staticDir ? path.resolve(root, theme.staticDir) : null;
  await fs.cp(themeDir, path.join(admin, 'site', path.relative(root, themeDir)), { recursive: true, filter: (src) => !staticDir || !src.startsWith(staticDir) });
}

// Builds the site into its output directory, replacing what was there only once the new build is
// complete, so a server keeps serving the old one meanwhile.
export async function buildToDisk(dir, { now = new Date(), out } = {}) {
  const { root, site, theme } = await loadSite(dir);
  const finalDir = path.resolve(root, out ?? site.output ?? '_site');
  const outDir = `${finalDir}.next`;
  const result = await build({ site, theme, store: fsStore(root), now });
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  for (const { from, paths } of site.passthrough ?? []) {
    for (const p of paths) await fs.cp(path.resolve(root, from, p), path.join(outDir, p), { recursive: true });
  }
  for (const { from, to } of result.copies) {
    try { await copyDir(path.join(root, from), path.join(outDir, to)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const file of result.files) {
    const target = path.join(outDir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.text);
  }
  if (site.admin !== false) await copyAdmin(root, site, theme, outDir);
  await fs.rm(`${finalDir}.old`, { recursive: true, force: true });
  await fs.rename(finalDir, `${finalDir}.old`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await fs.rename(outDir, finalDir);
  await fs.rm(`${finalDir}.old`, { recursive: true, force: true });
  return { ...result, outDir: finalDir, root, site, theme };
}
