#!/usr/bin/env node
// werft command line: build, serve and manage a werft site.
import { buildToDisk } from '../lib/node.js';

const [command = 'help', ...args] = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '.';

const commands = {
  async build() {
    const started = Date.now();
    const result = await buildToDisk(dir, { out: option('out'), now: option('now') ? new Date(option('now')) : undefined });
    console.log(`Built ${result.files.length} files into ${result.outDir} in ${Date.now() - started} ms`);
    if (result.schedule.next_publish) console.log(`Next scheduled publication: ${result.schedule.next_publish}`);
  },
  help() {
    console.log(`Usage: werft <command> [site directory]

  build [dir] [--out dir]   Build the site (default output: the site's "output" setting)`);
  },
};

if (!commands[command]) { commands.help(); process.exit(1); }
await commands[command]();
