// Node helpers: file-system store, site loading and writing a build to disk.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from './build.js';

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

// Builds the site into its output directory, replacing what was there.
export async function buildToDisk(dir, { now = new Date(), out } = {}) {
  const { root, site, theme } = await loadSite(dir);
  const outDir = path.resolve(root, out ?? site.output ?? '_site');
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
  return { ...result, outDir, root, site, theme };
}
