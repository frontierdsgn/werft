#!/usr/bin/env node
// werft command line: build, serve and manage a werft site.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { buildToDisk, loadSite } from '../lib/node.js';
import { USERS_FILE, hashPassword, parseUsers, serializeUsers, findUser } from '../gateway/auth.js';
import { ROLES } from '../gateway/roles.js';

const [command = 'help', ...args] = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

function ask(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer); }));
}

async function serveCommand(dev) {
  const { serve } = await import('../adapters/node.js');
  let secret = process.env.WERFT_SECRET;
  if (!secret) {
    if (!dev) { console.error('Set WERFT_SECRET (werft secret prints a new one).'); process.exit(1); }
    secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  }
  const port = Number(option('port') ?? process.env.PORT ?? 8787);
  const host = option('host') ?? (dev ? '127.0.0.1' : '0.0.0.0');
  const { url } = await serve({ dir: positional[0] ?? '.', port, host, secret, branch: option('branch'), tickMinutes: dev ? 0 : 5, mail: dev ? 'log' : undefined });
  console.log(`Site:  ${url}/\nAdmin: ${url}/admin/`);
  if (dev && !process.env.WERFT_SECRET) console.log('Sessions end when this server stops (no WERFT_SECRET set).');
}

const commands = {
  async build() {
    const started = Date.now();
    const result = await buildToDisk(positional[0] ?? '.', { out: option('out'), now: option('now') ? new Date(option('now')) : undefined });
    console.log(`Built ${result.files.length} files into ${result.outDir} in ${Date.now() - started} ms`);
    if (result.schedule.next_publish) console.log(`Next scheduled publication: ${result.schedule.next_publish}`);
  },
  dev: () => serveCommand(true),
  serve: () => serveCommand(false),
  // Sends the built site to werft-publish.php on PHP web space (WERFT_PUBLISH_URL, WERFT_PUBLISH_SECRET).
  async publish() {
    const { publish } = await import('../lib/publish.js');
    const { root, site } = await loadSite(positional[0] ?? '.');
    await publish({
      outDir: path.resolve(root, option('out') ?? site.output ?? '_site'), url: process.env.WERFT_PUBLISH_URL, secret: process.env.WERFT_PUBLISH_SECRET,
      // The admin needs the gateway, which PHP web space cannot run; editors use the build host's admin.
      exclude: site.admin === false ? [] : [site.admin ?? 'admin'], log: console.log,
    });
  },
  secret() {
    console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'));
  },
  // werft user add|set|remove|list <email> [--role r] [--name n] [--password p] [dir]
  async user() {
    const [action = 'list', email] = positional;
    const site = positional[2] ?? '.';
    const file = path.join(site, USERS_FILE);
    const users = parseUsers(await fs.readFile(file, 'utf8').catch(() => ''));
    if (action === 'list') {
      for (const u of users) console.log(`${u.email}\t${u.role}\t${u.name ?? ''}`);
      return;
    }
    if (!email) throw new Error('Which e-mail address?');
    const existing = findUser(users, email);
    let next;
    if (action === 'remove') {
      if (!existing) throw new Error(`No user ${email}`);
      next = users.filter((u) => u !== existing);
    } else if (action === 'add' || action === 'set') {
      if (action === 'add' && existing) throw new Error(`${email} exists; use "werft user set".`);
      if (action === 'set' && !existing) throw new Error(`No user ${email}`);
      const role = option('role') ?? existing?.role ?? 'administrator';
      if (!ROLES[role]) throw new Error(`Roles: ${Object.keys(ROLES).join(', ')}`);
      let password = option('password') ?? process.env.WERFT_PASSWORD;
      if (!password && (action === 'add' || args.includes('--password-prompt'))) password = await ask('Password (min. 10 characters): ', { hidden: true });
      if (password !== undefined && password.length < 10) throw new Error('Passwords need at least 10 characters.');
      const user = { ...existing, email: existing?.email ?? email, name: option('name') ?? existing?.name ?? email, role };
      if (password) user.password = await hashPassword(password, option('iterations') ? Number(option('iterations')) : undefined);
      next = existing ? users.map((u) => (u === existing ? user : u)) : [...users, user];
    } else {
      throw new Error(`Unknown action ${action}`);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, serializeUsers(next));
    console.log(`Updated ${file}. The gateway reads users from the branch, so commit it:\n  git add ${file} && git commit -m "Users" -- ${file}`);
  },
  help() {
    console.log(`Usage: werft <command> [options]

  build [dir] [--out dir] [--now iso-date]   Build the site
  dev [dir] [--port 8787]                     Local server: site, /admin and gateway on this git checkout
  serve [dir] [--port] [--host]               Same for production; needs WERFT_SECRET, publishes scheduled entries
  user list|add|set|remove [email] [dir]      Manage .werft/users.json (--role, --name, --password)
  publish [dir]                               Send the build to werft-publish.php (WERFT_PUBLISH_URL, WERFT_PUBLISH_SECRET)
  secret                                      Print a new random secret

Roles: ${Object.entries(ROLES).map(([k, r]) => `${k} (${r.label})`).join(', ')}`);
  },
};

if (!commands[command]) { commands.help(); process.exit(1); }
try { await commands[command](); } catch (error) { console.error(error.message); process.exit(1); }
