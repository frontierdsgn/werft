# werft

A git-based CMS core for small websites. Content lives as JSON files in the site's git repository, a
theme turns it into static HTML, and editors work in a browser admin at `/admin` with their own
logins and WordPress-style roles. The same site runs on Cloudflare Pages, on any Node server, and
(with a build host) on PHP web space such as IONOS.

werft is version 0.1.0, licensed MIT. The admin is [Sveltia CMS](https://github.com/sveltia/sveltia-cms)
(MIT), used unmodified; werft adds the parts Sveltia lacks. Why Sveltia and not another CMS:
[EVALUATION.md](EVALUATION.md).

## How it fits together

```diagram
 Browser                         Host (Cloudflare Pages, Node, …)
┌──────────────────────┐        ┌──────────────────────────────────────┐
│ /admin               │  HTTP  │ gateway  /api/werft/...              │
│ Sveltia CMS          ├───────▶│  sign-in, users, roles, scheduling   │
│ + werft preview,     │        │  Gitea API subset for Sveltia        │
│   Versionen,         │        └──────────────────┬───────────────────┘
│   Benutzer pages     │                           │ one commit per save
└──────────────────────┘                           ▼
                                ┌──────────────────────────────────────┐
                                │ git: local checkout or GitHub (REST) │
                                └──────────────────┬───────────────────┘
                                                   │ push / file change
                                                   ▼
                                ┌──────────────────────────────────────┐
                                │ werft build: content + theme → HTML  │
                                └──────────────────────────────────────┘
```

- **Gateway** ([gateway/core.js](gateway/core.js)): speaks the part of the Gitea API that Sveltia's
  Gitea backend uses, so Sveltia needs no changes. It signs editors in with werft's own users
  (`.werft/users.json`, PBKDF2 password hashes), checks every change against the editor's role, and
  stores it through a storage driver. It uses only the Fetch API and Web Crypto, so the same code
  runs on Node and Cloudflare.
- **Storage drivers**: [git.js](gateway/storage/git.js) commits to a local checkout;
  [github.js](gateway/storage/github.js) commits through GitHub's REST API (GraphQL for bulk reads).
- **Build** ([lib/build.js](lib/build.js)): isomorphic; the CLI builds the site, and the admin uses
  the same code for its live preview, so the preview is the published page.
- **Adapters**: [node.js](adapters/node.js) (`werft dev` / `werft serve`),
  [cloudflare.js](adapters/cloudflare.js) (Pages Functions), [php/werft-publish.php](adapters/php/werft-publish.php)
  (receiver for PHP web space).

## Editor features

| WordPress | werft |
|---|---|
| Login at /admin, users, roles | Own e-mail/password logins, no GitHub account needed. Roles Administrator, Redakteur, Autor, Mitarbeiter with WordPress's rules ([roles.js](gateway/roles.js)), enforced by the gateway. Users page for administrators. |
| Pages and posts | Pages built from sections (the theme's blocks), plus one post type per theme (e.g. events). Add, delete, reorder sections. |
| Draft, pending review, publish, schedule | Status per entry; a publish date in the future schedules it (see [Scheduling](#scheduling)). Contributors are offered only "Entwurf" and "Zur Prüfung"; when the gateway refuses a change for the editor's role, the admin says so instead of "try again later". |
| Visual editing, preview | Form editor beside a live preview rendered by the site's own theme. A post without a page of its own (no `renderPost` in the theme) is previewed marked on the page that lists it, else alone in the theme's listing section, else as a card of its fields. |
| Media library, alt text | Sveltia's media library; images are fields with file, alt text and caption. |
| Menus, site settings, SEO | Menu locations the theme declares; site settings; SEO title, description and noindex per page. |
| Revisions | Every save is a git commit. The Versionen page compares any version with the current one by content (the key order and the `false` defaults the CMS writes are no changes) and restores it after asking. |
| Reusable blocks | Patterns: sections shared by several pages. |
| Forms, redirects | Form definitions edited in the admin (the theme renders them); redirects written as `_redirects` and `.htaccess` (`/alt/*` to `/neu/:splat` works in both). |

## Commands

```sh
npx werft build [dir]          # build into the site's output directory
npx werft dev [dir] [--port 8787]
                               # site, /admin and gateway on this checkout; commits locally
npx werft serve [dir]          # the same for production; needs WERFT_SECRET
npx werft user add <email> --role editor --name "Name"
npx werft user list|set|remove
npx werft secret               # a random secret for WERFT_SECRET / WERFT_PUBLISH_SECRET
npx werft publish [dir]        # send the build to werft-publish.php
```

Tests: `npm test` in this directory (Node's test runner; the publish test needs `php` and skips without it).

## Setting up a new site

A site is a repository with a `werft.config.js`, a theme and a `content/` folder. The steps below
show every part.

1. **package.json**: depend on a tagged werft version and add the scripts.
   ```json
   { "type": "module", "scripts": { "build": "werft build", "dev": "werft dev" },
     "dependencies": { "werft": "github:frontierdsgn/werft#v0.1.0" } }
   ```
   A new werft version is a new tag; a site moves to it by changing the tag and running
   `npm install`. To try an unreleased werft in a site, depend on a local checkout with
   `"werft": "file:../werft"` and add `install-links=true` to the site's `.npmrc`: npm then
   installs a copy of werft with its own dependencies. After changing werft, reinstall it in the
   site: `rm -rf node_modules/werft && npm install`.
2. **werft.config.js**:
   ```js
   export default {
     name: 'Firmenname',
     theme: './theme/index.js',
     content: 'content',            // content directory
     mediaDirs: ['assets/img'],     // the first one receives uploads
     output: '_site',
     base: '',                      // set when the site is served below a path, e.g. 'salon'
     passthrough: [{ from: '.', paths: ['alt'] }], // copied unchanged into the output
   };
   ```
3. **Theme** (`theme/index.js`), a plain object:
   - `blocks`: `{ type: { label, fields, render(section, ctx) } }`. Fields come from `werft`'s
     `fields` helpers (`string`, `text`, `markdown`, `picture`, `link`, `list`, `object`, …); `render`
     returns `ctx.html\`…\`` and escapes by default.
   - `renderPage(page, ctx)`: the page frame around `ctx.blocks(page.sections)`.
   - Optional: `menus` (location → label), `settingsFields`, `formFields`, `postType`
     (`{ name, label, singular, fields, date }`), `staticDir` (CSS, JS, fonts copied as they are).
     `date` names the post field that orders posts (default `publish_date`); declare it with
     `fields.date(name, label)`, which stores an ISO date (`2026-11-14`) and shows it in the
     editor's locale (14.11.2026 in a German browser). Older files with "14.11.2026" are read too.
   - `ctx` offers `settings`, `menu(id)`, `image(src)` (with width and height), `posts()`, `form(slug)`,
     `md()`, `inline()`. `posts()` returns the published posts newest first by their date, posts
     without a date last by slug; `posts({ slugs })` returns the named posts in that order, and
     `limit` cuts the list. The admin lists posts newest first too.
4. **Content**: `content/pages/<slug>.json` (`index` becomes `index.html`), `content/patterns/`,
   `content/forms/`, `content/<post type>/`, `content/settings/{site,menus,redirects}.json`.
   A page is `{ "title": "Start", "status": "published", "sections": [{ "type": "text", … }] }`.
   Write the status into files you create by hand: the build publishes a file without one, but the
   admin shows it as "Entwurf" and saving it there would unpublish it.
5. **First administrator**: `npx werft user add you@example.org`, then commit `.werft/users.json`.
   Later users are added on the Benutzer page.
6. **Cloudflare**: add `functions/api/werft/[[path]].js` as in [adapters/cloudflare.js](adapters/cloudflare.js).
7. Run `npm install && npm run dev`, open `http://127.0.0.1:8787/admin/`.

## Hosting

### Cloudflare Pages (default)

Cloudflare builds the site from the GitHub repository; the admin's gateway runs as a Pages Function
and commits to the repository through the GitHub API. Each save is a commit, and each commit
triggers a Cloudflare build.

1. Pages → Create → Connect to Git → choose the repository.
2. Build settings: root directory = the site's directory (e.g. `classic`), build command
   `npm run build`, output directory `_site`. Environment variable `NODE_VERSION` = `22`.
3. Environment variables (Production; mark the first two as secrets):

   | Variable | Value |
   |---|---|
   | `WERFT_SECRET` | output of `npx werft secret` |
   | `GITHUB_TOKEN` | fine-grained token, repository access to this one repository, permission "Contents: Read and write" |
   | `WERFT_REPO` | `owner/repository` |
   | `WERFT_DIR` | the site's directory in the repository (e.g. `classic`), empty for the root |
   | `WERFT_BRANCH` | production branch, default `main` |
   | `WERFT_DEPLOY_HOOK` | optional: a deploy hook URL (Settings → Builds → Deploy hooks), for scheduled publishing |
   | `WERFT_TICK_KEY` | optional, secret: lets a cron service publish scheduled entries (see [Scheduling](#scheduling)) |
   | `WERFT_GITHUB_API` | optional: GitHub Enterprise Server API URL |

4. Deploy, open `https://<project>.pages.dev/admin/`, sign in with a user from `.werft/users.json`.

Fine-grained tokens expire; renew the token before its expiry date or saving stops working.

Limits of the free plan that apply: Pages Functions share the Workers free plan's daily request
quota, with 50 outgoing requests and 10 ms CPU time per request. The gateway reads up to 100 content
files in one GraphQL request and sends text files with the commit; each image costs one request, so
one save takes at most 30 files (30 images measured at 39 requests against a stand-in GitHub). Signing in hashes the password with
PBKDF2 (100,000 iterations, the most Workers allow); on this machine that takes about 22 ms in Node.
Whether Cloudflare counts it against the 10 ms limit is unknown: after the first deploy, sign in and
check the Functions log for CPU-limit errors. If it fails, lower the iterations for a user
(`npx werft user set <email> --password-prompt --iterations 20000`) or use the Workers Paid plan.

### PHP web space (IONOS and similar)

PHP web space cannot run the gateway or the build, which are JavaScript. The site is built elsewhere
and pushed there:

1. Copy [adapters/php/werft-publish.php](adapters/php/werft-publish.php) into the web root and set
   `WERFT_PUBLISH_SECRET` in it to the output of `npx werft secret`.
2. On the build host, set `WERFT_PUBLISH_URL` (the file's URL) and `WERFT_PUBLISH_SECRET`, and build
   with `npm run build && npx werft publish`.

`werft publish` sends only changed files, signed with HMAC-SHA256 (requests older than 5 minutes are
refused). The receiver only writes and deletes files it published itself, refuses PHP and other
code files, accepts `.htaccess` only with redirect lines and writes nothing through symbolic links.
A file already in the web space with the same name and different content stops the publish:
remove or rename it there first (identical files are taken over). The admin is not published: editors
use the admin on the build host.

With Cloudflare Pages as the build host, the domain points at IONOS, the admin stays at
`https://<project>.pages.dev/admin/`, and every save publishes to IONOS through the Cloudflare build.
Without any build host, the owner can build and publish from their own computer with the same two
commands.

### Own server (Node 20 or newer)

```sh
git clone <repository> site && cd site/<site dir> && npm ci
WERFT_SECRET=<werft secret> npx werft serve --port 8787
```

`werft serve` serves the site, the admin and the gateway, commits saves to the local checkout,
rebuilds after each save and checks scheduled entries every 5 minutes. Put a reverse proxy with
HTTPS in front. It does not push: to keep GitHub current, push from the server (for example a cron
job running `git push` with a deploy key).

### Local

`npm run dev` in the site directory: `http://127.0.0.1:8787/` and `/admin/`. Saves are commits in
the local checkout. Without `WERFT_SECRET`, sessions end when the server stops.

## Scheduling

An entry with status "Veröffentlicht" and a future "Veröffentlichen am" date is left out of the
build until it is due. Publishing it changes no file, so something must rebuild the site after the
date passes. The gateway's `/api/werft/tick` does that when an entry has fallen due since the last
build, once per due entry (again after 15 minutes if that build did not publish it), and does
nothing otherwise. It needs a signed-in user or the tick key.

- `werft serve` calls it every 5 minutes.
- On Cloudflare Pages it needs `WERFT_DEPLOY_HOOK`, and something must call it: every admin page
  load does. For an exact time, set `WERFT_TICK_KEY` (e.g. the output of `npx werft secret`) and
  let an external cron service or a Cloudflare Worker with a cron trigger request
  `https://<site>/api/werft/tick?key=<WERFT_TICK_KEY>`.

Dates are entered in the editor's time zone and stored in UTC.

## Browser and host requirements

- Admin: a current Chrome, Edge, Brave, Firefox or Safari (Sveltia uses `Uint8Array.prototype.toHex`,
  available since Chrome 140, Firefox 133 and Safari 18.2).
- Build and `werft serve`: Node 20 or newer. Receiver: PHP 7.4 or newer.
- The admin loads its fonts from cdn.jsdelivr.net: werft serves Sveltia's prebuilt bundle, and only
  Sveltia's module build (which needs a bundler such as Vite) avoids that. The public site loads
  nothing from there.

## Known limits

- Sveltia trims leading and trailing spaces of text fields on save; themes must add separators
  themselves.
- Sveltia rewrites a content file in its field order when it saves it, and writes default values
  (e.g. `"noindex": false`). The built HTML does not change.
- Sveltia's media dialog lists stock photo services (Pexels, Pixabay, Unsplash); they only work
  with an API key the editor enters.
- On Cloudflare each call of `/api/werft/tick` reads the content from GitHub with a handful of API
  requests, which count against the token's rate limit; a cron every few minutes is fine.
