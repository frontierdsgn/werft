# werft

Git-based, host-independent CMS: static build, theme API, editor and auth gateway.

Status: released. Sites install tagged versions; while werft is 0.y.z, a breaking change raises y and
is listed in the [release notes](https://github.com/frontierdsgn/werft/releases).

[![gate](https://github.com/frontierdsgn/werft/actions/workflows/gate.yml/badge.svg?branch=main)](https://github.com/frontierdsgn/werft/actions/workflows/gate.yml)
[![latest release](https://img.shields.io/github/v/tag/frontierdsgn/werft?sort=semver&label=release)](https://github.com/frontierdsgn/werft/releases)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

## What it does

A git-based CMS core for small websites. Content lives as JSON files in the site's git repository, a
theme turns it into static HTML, and editors work in a browser admin at `/admin` with their own
logins and WordPress-style roles. The same site runs on Cloudflare Pages, on any Node server, and
(with a build host) on PHP web space such as IONOS.

The admin is werft's own editor, built for people who are not technical: plain German labels, one
clear action per place, one screen with two views of the same content.
Which existing CMSs were evaluated first: [EVALUATION.md](EVALUATION.md).

### How it fits together

```diagram
 Browser                         Host (Cloudflare Pages, Node, …)
┌──────────────────────┐        ┌──────────────────────────────────────┐
│ /admin               │  HTTP  │ gateway  /api/werft/...              │
│ werft editor:        ├───────▶│  sign-in, users, roles, scheduling,  │
│  form view,          │        │  file API (read, save, versions)     │
│  on-page view,       │        └──────────────────┬───────────────────┘
│  live preview        │                           │ one commit per save
└──────────────────────┘                           │
                                                   ▼
                                ┌──────────────────────────────────────┐
                                │ git: local checkout or GitHub (REST) │
                                └──────────────────┬───────────────────┘
                                                   │ push / file change
                                                   ▼
                                ┌──────────────────────────────────────┐
                                │ werft build: content + theme → HTML  │
                                └──────────────────────────────────────┘
```

- **Editor** ([admin/editor.js](admin/editor.js)): one app with a shared sidebar and two views,
  "Formular" ([form-view.js](admin/form-view.js), fields beside a live preview) and "Auf der Seite"
  (editing on the rendered page). Both read the fields from the site's schema
  ([lib/schema.js](lib/schema.js)) and share undo, saving and the unsaved state.
- **Gateway** ([gateway/core.js](gateway/core.js)): a small file API in the shape of Gitea's (tree,
  file contents, one commit for many files, history). It signs editors in with werft's own users
  (`.werft/users.json`, PBKDF2 password hashes), checks every change against the editor's role, and
  stores it through a storage driver. It uses only the Fetch API and Web Crypto, so the same code
  runs on Node and Cloudflare.
- **Storage drivers**: [git.js](gateway/storage/git.js) commits to a local checkout;
  [github.js](gateway/storage/github.js) commits through GitHub's REST API (GraphQL for bulk reads),
  signed in as a GitHub App ([github-app.js](gateway/storage/github-app.js)) or with a token.
- **Build** ([lib/build.js](lib/build.js)): isomorphic; the CLI builds the site, and the admin uses
  the same code for its live preview, so the preview is the published page.
- **Adapters**: [node.js](adapters/node.js) (`werft dev` / `werft serve`),
  [cloudflare.js](adapters/cloudflare.js) (Pages Functions), [php/werft-publish.php](adapters/php/werft-publish.php)
  (receiver for PHP web space).

### Editor features

| WordPress | werft |
|---|---|
| Login at /admin, users, roles | Own e-mail/password logins, no GitHub account needed. Roles Administrator, Redakteur, Autor, Mitarbeiter with WordPress's rules ([roles.js](gateway/roles.js)), enforced by the gateway. "Benutzer" in the editor for administrators. |
| Pages and posts | Pages built from sections (the theme's blocks), plus one post type per theme (e.g. events). Add, delete, reorder sections. |
| Draft, pending review, publish, schedule | Status per entry; a publish date in the future schedules it (see [Scheduling](#scheduling)). Contributors are offered only "Entwurf" and "Zur Prüfung"; when the gateway refuses a change for the editor's role, the admin says so instead of "try again later". |
| Visual editing, preview | Two views of the same [editor](#editor), switched at the top of the sidebar: "Formular" shows the fields beside a live preview rendered by the site's own theme (a click on a section in the preview opens it in the form); "Auf der Seite" edits on the page itself. A post without a page of its own (no `renderPost` in the theme) is previewed marked on the page that lists it, else alone in the theme's listing section, else as a card of its fields. |
| Media library, alt text | "Bilder": all images with where each is used; upload several at once, delete only unused ones (Administrator, Redakteur). Images are fields with file, alt text and caption. |
| Menus, site settings, SEO | Menu locations the theme declares; site settings; SEO title, description and noindex per page. |
| Revisions | Every save is a git commit. "Frühere Versionen" under each entry compares a version with the current one by content and brings it back as an unsaved change. |
| Reusable blocks | Patterns: sections shared by several pages. |
| Forms, redirects | Form definitions edited in the admin (the theme renders them); visitors' submissions kept in the repository and shown under "Einsendungen" (see [Form submissions](#form-submissions)); redirects written as `_redirects` and `.htaccess` (`/alt/*` to `/neu/:splat` works in both). |

### Editor

`/admin` is one app. The sidebar lists everything that can be edited (pages, the theme's post type,
site settings, menus, images, form submissions, users; patterns, forms and redirects folded under "Weitere Inhalte")
and is the same in both views. A switch at its top changes the view; the editor remembers the last
one, and unsaved changes, undo and "Speichern" carry over between them.

- **Formular** (the default): the entry as cards, from the top: title and main fields, the sections
  as a list to open, move and remove ("Abschnitt hinzufügen" shows the theme's blocks and patterns
  with thumbnails), "Sichtbarkeit" as choices with a sentence each, SEO folded, "Frühere Versionen".
  The live preview sits beside it, renders the page at 1200 px width scaled to fit, and can be
  hidden. Text is 15 px and controls 36–38 px high, so the form and the preview both have room;
  actions carry words, only the move and remove tools in lists are icons with tooltips, and every
  removal asks first.
- **Auf der Seite**: the site as the theme renders it, edited there like Squarespace's page editor.
  Hover outlines a section; a click on a text edits it in place (rich text gets a bar for bold,
  italic, links, headings and lists), a click on an image opens the image picker with upload. Texts
  that cannot be edited in place (a link address, a value the theme turns into a class or an
  anchor) open a small dialog; "Abschnitt bearbeiten" shows all fields of a section as a form.
  Layout follows the theme: no free positioning or resizing. Behind the lock ("Layout gesperrt")
  sections and list items can be added, duplicated, moved and removed. Desktop and mobile width.
- Both: undo and redo (Ctrl+Z, Ctrl+Y); "Speichern" (Ctrl+S) writes every changed file and upload in
  one commit. "Benutzer" (administrators only) changes users at once, without "Speichern".

How "Auf der Seite" finds the content on the page ([visual-map.js](admin/visual-map.js)): it renders
the page a second time with each text wrapped in invisible private-use markers and keeps a marker
only where the page without markers is unchanged, so a value the theme compares or slugifies is
never marked. Themes need nothing extra. Theme scripts do not run in the editor (e.g. a mobile menu
shows open).

## Install

werft is installed per site, from a git tag; there is no npm package. A site is a repository with
a `werft.config.js`, a theme and a `content/` folder. The steps below show every part.

1. **package.json**: depend on a tagged werft version and add the scripts.
   <!-- x-release-please-start-version -->
   ```json
   { "type": "module", "scripts": { "build": "werft build", "dev": "werft dev" },
     "dependencies": { "werft": "github:frontierdsgn/werft#v0.5.0" } }
   ```
   <!-- x-release-please-end -->
   A new werft version is a new tag (see [Releasing](#releasing)); sites in the frontierdsgn
   organization are moved to it with `npm run update-sites`. Any other site moves with
   `npm install github:frontierdsgn/werft#vX.Y.Z`, which updates `package.json` and
   `package-lock.json` (a plain `npm install` keeps the commit in the lockfile). To try an unreleased werft in a site, depend on a local checkout with
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
   `content/forms/` (see [Form submissions](#form-submissions)), `content/<post type>/`, `content/settings/{site,menus,redirects}.json`.
   A page is `{ "title": "Start", "status": "published", "sections": [{ "type": "text", … }] }`.
   Write the status into files you create by hand: the build publishes a file without one, but the
   admin shows it as "Entwurf" and saving it there would unpublish it.
5. **First administrator**: `npx werft user add you@example.org`, then commit `.werft/users.json`.
   Later users are added on the Benutzer page.
6. **Cloudflare**: add `functions/api/werft/[[path]].js` as in [adapters/cloudflare.js](adapters/cloudflare.js).
7. Run `npm install && npm run dev`, open `http://127.0.0.1:8787/admin/`.

## Usage

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

## Configuration

A site is configured in `werft.config.js` and its theme (see [Install](#install)) and, per host,
through environment variables.

### Hosting

#### Cloudflare Pages (default)

The site's GitHub Actions workflow deploys production: every push to `main` runs the site's `gate`,
and once it passed, the `deploy` job uploads that commit's build to Cloudflare Pages and records
the commit it shipped. Cloudflare's own Git integration only builds previews of other branches. The
admin's gateway runs as a Pages Function and commits to the repository through the GitHub API, so
each save is a commit to `main` that goes live once its `gate` passed.

1. Pages → Create → Connect to Git → choose the repository (Cloudflare builds the previews from it).
2. Build settings: root directory = the site's directory (e.g. `classic`), build command
   `npm run build`, output directory `_site`. Environment variable `NODE_VERSION` = `22`.
3. Settings → Builds → Branch control: turn off "Enable automatic production branch deployments",
   so only the `deploy` job puts a build live. If the site has forms, set Preview branches to
   "Custom branches", include `*`, exclude `werft-submissions` (or "None"), so a
   [form submission](#form-submissions) does not start a build.
4. Environment variables (Production; mark `WERFT_SECRET`, `GITHUB_APP_PRIVATE_KEY` and
   `GITHUB_TOKEN` as secrets):

   | Variable | Value |
   |---|---|
   | `WERFT_SECRET` | output of `npx werft secret` |
   | `GITHUB_APP_ID` | the werft-cms GitHub App's client ID (its app ID works too), see [GitHub App](#github-app) |
   | `GITHUB_APP_PRIVATE_KEY` | the app's private key, converted to PKCS#8 |
   | `GITHUB_TOKEN` | instead of the app: fine-grained token, repository access to this one repository, permission "Contents: Read and write" |
   | `WERFT_REPO` | `owner/repository` |
   | `WERFT_DIR` | the site's directory in the repository (e.g. `classic`), empty for the root |
   | `WERFT_BRANCH` | production branch, default `main` |
   | `WERFT_DEPLOY_HOOK` | optional: a deploy hook URL (Settings → Builds → Deploy hooks), for scheduled publishing; it bypasses `gate`, see [Scheduling](#scheduling) |
   | `WERFT_TICK_KEY` | optional, secret: lets a cron service publish scheduled entries (see [Scheduling](#scheduling)) |
   | `WERFT_GITHUB_API` | optional: GitHub Enterprise Server API URL |
   | `TURNSTILE_SECRET_KEY` | optional, secret: forms then need [Cloudflare Turnstile](#spam) |

5. In the site: give its `package.json` a `gate` script (its own checks; at least `werft build`),
   add Wrangler with `npm install --save-dev wrangler`, and add `.github/workflows/gate.yml`
   (replace `<project>` with the Pages project's name):

   ```yaml
   # The gate on every push to main and every pull request; a push to main deploys once it passed.
   name: gate
   on:
     push:
       branches: [main]
     pull_request:
   permissions:
     contents: read
   concurrency:
     group: gate-${{ github.event.pull_request.number || github.sha }}
     cancel-in-progress: ${{ github.event_name == 'pull_request' }}
   jobs:
     gate:
       name: gate
       runs-on: ubuntu-24.04
       timeout-minutes: 10
       steps:
         - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
           with:
             persist-credentials: false
         - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
           with:
             node-version: 22
             cache: npm
         - run: npm ci --no-audit --no-fund
         - run: npm run gate
     deploy:
       needs: gate
       if: github.event_name == 'push' && github.ref == 'refs/heads/main'
       runs-on: ubuntu-24.04
       timeout-minutes: 10
       environment: production
       concurrency:
         group: deploy-production
         cancel-in-progress: false
       steps:
         - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
           with:
             persist-credentials: false
         - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
           with:
             node-version: 22
             cache: npm
         - run: npm ci --no-audit --no-fund
         - run: npm run build
         # From the site's root, so Wrangler compiles functions/ (the gateway) with the build.
         - run: npx wrangler pages deploy _site --project-name <project> --branch main --commit-hash "$GITHUB_SHA"
           env:
             CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
             CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
   ```

   For a site in a subdirectory, add `defaults: { run: { working-directory: <dir> } }` to both
   jobs and `cache-dependency-path: <dir>/package-lock.json` to `setup-node`.
6. In the site's repository on GitHub: Settings → Environments → New environment `production`,
   deployment branches limited to `main`. Add the environment secret `CLOUDFLARE_API_TOKEN`, a
   Cloudflare API token with the permission "Account → Cloudflare Pages → Edit", and the variable
   `CLOUDFLARE_ACCOUNT_ID`, the Cloudflare account ID. If `main` has a ruleset that requires pull
   requests, add the werft-cms app as a bypass actor, or saves from the admin are refused.
7. Push to `main`; once `gate` and `deploy` passed, open `https://<project>.pages.dev/admin/` and
   sign in with a user from `.werft/users.json`.

With both set, the app is used. Fine-grained tokens expire; renew the token before its expiry date
or saving stops working.

##### GitHub App

frontierdsgn owns one GitHub App for all sites,
[werft-cms](https://github.com/apps/werft-cms) (the name "werft" is taken on GitHub). Commits made
through it show `werft-cms[bot]` as committer and the editor as author; editors still need no
GitHub account. The app has one permission, "Repository contents: Read and write", and no
webhook; any account can install it.

1. `GITHUB_APP_ID` is the app's client ID (on its settings page).
2. `GITHUB_APP_PRIVATE_KEY` is one of its private keys. GitHub downloads a key as PKCS#1; Web
   Crypto needs PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in werft-cms.private-key.pem -out
   werft-cms.pkcs8.pem`. Keep the files out of every repository.
3. A new site's repository must be added to the app's installation (organization settings →
   GitHub Apps → werft-cms → Configure). A client with its own organization installs the app
   there.

The gateway signs a JWT with the key, finds the installation on `WERFT_REPO` and gets a token
that lasts an hour and is limited to that repository and contents. It keeps the token until five
minutes before it expires; a new one costs three requests.

Limits of the free plan that apply: Pages Functions share the Workers free plan's daily request
quota, with 50 outgoing requests and 10 ms CPU time per request. The gateway reads up to 100 content
files in one GraphQL request and sends text files with the commit; each image costs one request, so
one save takes at most 30 files (30 images measured at 39 requests against a stand-in GitHub, 42
with the GitHub App's token requests). Signing in hashes the password with
PBKDF2 (100,000 iterations, the most Workers allow); on this machine that takes about 22 ms in Node.
On the free plan, measured on 17 October 2026 with werft 0.4.0 (inselsalon.pages.dev, Cloudflare's
analytics): a sign-in took 16–18 ms CPU time and went through, as did every other request (opening
the editor, saving, form submissions, up to 16 ms), with no errors. Cloudflare tolerated the excess
then; it does not promise to. If sign-ins fail with error 1102, lower the iterations for a user
(`npx werft user set <email> --password-prompt --iterations 20000`) or use the Workers Paid plan.

#### PHP web space (IONOS and similar)

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
`https://<project>.pages.dev/admin/`, and every save publishes to IONOS through the build: add
`npx werft publish` after the build in the `deploy` job, with `WERFT_PUBLISH_URL` and
`WERFT_PUBLISH_SECRET` in the `production` environment.
Without any build host, the owner can build and publish from their own computer with the same two
commands.

#### Own server (Node 22 or newer)

```sh
git clone <repository> site && cd site/<site dir> && npm ci
WERFT_SECRET=<werft secret> npx werft serve --port 8787
```

`werft serve` serves the site, the admin and the gateway, commits saves to the local checkout,
rebuilds after each save and checks scheduled entries every 5 minutes. Put a reverse proxy with
HTTPS in front. It does not push: to keep GitHub current, push from the server (for example a cron
job running `git push` with a deploy key).

#### Local

`npm run dev` in the site directory: `http://127.0.0.1:8787/` and `/admin/`. Saves are commits in
the local checkout. Without `WERFT_SECRET`, sessions end when the server stops.

### Scheduling

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
- A deploy hook makes Cloudflare build and deploy production directly, so it bypasses `gate`. On
  a site deployed by its `deploy` job (see [Cloudflare Pages](#cloudflare-pages-default)), scheduled
  publishing should dispatch that workflow instead; that is not built yet
  ([#21](https://github.com/frontierdsgn/werft/issues/21)). Without the hook, a due entry goes
  live with the next deploy.

Dates are entered in the editor's time zone and stored in UTC.

### Form submissions

A form posts to the gateway at `/api/werft/forms/<form>`, where `<form>` is a file in
`content/forms/` ([submissions.js](gateway/submissions.js)). The gateway commits each submission as
`.werft/submissions/<form>/<time>-<random>.json` to the branch `werft-submissions`, which it creates
with the first one; the site's own branch and history stay untouched, and no other service is
involved. Administrators and editors read them in the editor under "Einsendungen" (shown when the
site has a form), download them as CSV and delete them. Submissions hold personal data: keep the
repository private.

Deleting is final: the gateway replaces `werft-submissions` with one new commit holding the
remaining submissions and no history, so no branch leads to a deleted submission any more. Copies
made before stay where they are: a clone that fetched the branch, and on GitHub the old commits,
which are unreachable but can still be fetched by their id until GitHub cleans them up (GitHub
Support removes them on request). werft 0.4.0 kept submissions on the site's branch; delete those
there (`git rm -r .werft/submissions`), they remain in that branch's history.

```html
<form method="post" action="/api/werft/forms/newsletter">
  <label>E-Mail <input name="email" type="email" required></label>
  <input name="_gotcha" tabindex="-1" autocomplete="off" hidden>  <!-- bots fill it in -->
  <input name="_redirect" type="hidden" value="/danke.html">       <!-- optional -->
  <button>Abonnieren</button>
</form>
```

- The body is urlencoded, multipart (files are dropped) or JSON; repeated names become lists. At
  most 50 fields and 20,000 characters; fields whose name starts with `_` are not stored.
- A filled-in `_gotcha` gets the normal reply and stores nothing.
- A plain form post gets a short thank-you page with a link back, or a redirect to `_redirect` (a
  path on the site the form was on). A request with `Accept: application/json` gets `{ "ok": true }`
  or `{ "message": … }` with the status.
- A submission is not a content change: `werft serve` does not rebuild for it, and on Cloudflare
  Pages the excluded preview branch (step 4 above) keeps it from starting a build (the free plan has
  500 a month). `werft dev` and `werft serve` commit to the local `werft-submissions` branch and
  leave the working tree alone.
- On PHP web space the form's `action` is the build host's gateway, e.g.
  `https://<project>.pages.dev/api/werft/forms/newsletter`.
- No notification is sent; look at "Einsendungen".

#### Spam

- `_gotcha` above stops simple bots.
- Each form takes at most 60 submissions an hour; more get status 429 ("Gerade kommen sehr viele
  Nachrichten an …"). This bounds what a flood costs in commits and GitHub requests, and it also
  turns away real visitors while a flood lasts.
- [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) (free, also outside
  Cloudflare hosting) stops most bots without a puzzle: create a widget for the site's domain in the
  Cloudflare dashboard (Turnstile → Add widget), put its site key in the form and its secret key in
  `TURNSTILE_SECRET_KEY` (Pages environment variable, or the environment of `werft serve`). The
  gateway then takes only submissions Turnstile confirms, from every form of the site, and does not
  store the token. The widget loads from Cloudflare: name it in the privacy policy.

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<form method="post" action="/api/werft/forms/newsletter">
  …
  <div class="cf-turnstile" data-sitekey="<site key>"></div>
  <button>Abonnieren</button>
</form>
```

## Compatibility

Last verified on 18 October 2026 with werft 0.5.0 and `main`: the gate on Node 22 and 24 with PHP
8.3 (GitHub's `ubuntu-24.04` runner).

- Admin: a current Chrome, Edge, Brave, Firefox or Safari (import maps and ES modules). It loads
  nothing from other hosts and uses the system font.
- Build and `werft serve`: Node 22 or newer. Receiver: PHP 7.4 or newer.

### Known limits

- On Cloudflare each call of `/api/werft/tick` reads the content from GitHub with a handful of API
  requests, which count against the token's or the app installation's rate limit; a cron every
  few minutes is fine.

## Development

The gate is `npm test` (Node's test runner; the publish test needs `php` and skips without it). It
also unpacks the package a site installs and checks that it loads, builds a site with its admin
and holds every file it imports, and it scans the tracked files for credentials.
GitHub Actions runs it on Node 22 and 24 for every push to `main` and every pull request, in the
job `gate` ([gate.yml](.github/workflows/gate.yml)).

A single file: `node --test test/gateway.test.js`; a single test:
`node --test --test-name-pattern "<test name>" test/*.test.js`. How to contribute:
[CONTRIBUTING.md](CONTRIBUTING.md).

### Releasing

Releases are made by [release-please](https://github.com/googleapis/release-please)
([release.yml](.github/workflows/release.yml)). It keeps a release pull request open, built from
the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) on `main`: the next
version (while werft is 0.y.z, a breaking change raises y), set in `package.json`,
`package-lock.json` and this README, and the new entries in [CHANGELOG.md](CHANGELOG.md).
Maintainers merge it; that tags `vx.y.z` and creates a GitHub release with the same notes. The
[releases page](https://github.com/frontierdsgn/werft/releases) lists what changed in every
version, so whoever runs a werft site can read it before moving to a new tag.

The workflow signs in as a GitHub App (repository variable `RELEASE_APP_CLIENT_ID`, secret
`RELEASE_APP_PRIVATE_KEY`; the app needs "Contents", "Pull requests" and "Issues": read and write),
because a pull request opened with the workflow's own token gets no `gate` run. Without the
variable the workflow does nothing.

#### Moving the sites to a release

```sh
npm run update-sites              # the newest tag; or: npm run update-sites -- v1.2.3
npm run update-sites -- --dry-run # commits in temporary clones, pushes nothing
```

Every repository in the frontierdsgn organization whose root `package.json` depends on
`github:frontierdsgn/werft` gets the tag on its default branch, one commit with `package.json` and
`package-lock.json`. Before committing, it runs the site's own gate (`npm run gate`, if the site's
`package.json` has that script) on the new werft, and builds each site with its old and its new
werft. A site whose gate or build fails is reported as failed with the last lines of the output,
and nothing is pushed. If the public pages differ (anything outside `admin/` and
`_werft/build.json`), the site is held back and the changed files are listed; check them with
`npm run dev` in the site, then run `npm run update-sites -- --accept-changes`. After a push it
prints the site's `gate` run for the pushed commit (or the `gh run list` command that finds it
once GitHub has started it). It exits non-zero when a site failed or was held back.
Branches other than the default branch, and sites outside the organization, keep their version.

The script ([scripts/release.js](scripts/release.js)) needs git, npm and `gh`, signed in with push
access to the organization's repositories. It works in temporary clones and leaves local
checkouts alone.

## Contributing, support and security

- Pull requests are welcome, also from forks: [CONTRIBUTING.md](CONTRIBUTING.md). Every change must
  be useful to any werft site, not only to one; the rules are in [AGENTS.md](AGENTS.md).
- Bugs and feature requests: [issues](https://github.com/frontierdsgn/werft/issues/new/choose).
- Vulnerabilities: privately, as described in [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE).
