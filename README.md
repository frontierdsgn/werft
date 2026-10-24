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
- **Mail drivers** ([mail.js](gateway/mail.js)): Cloudflare Email Service, Brevo and Resend through
  their HTTP APIs; [mail-smtp.js](gateway/mail-smtp.js), like git.js, needs Node and runs only in
  `werft serve` and `werft dev`. See [E-mail](#e-mail).
- **Build** ([lib/build.js](lib/build.js)): isomorphic; the CLI builds the site, and the admin uses
  the same code for its live preview, so the preview is the published page.
- **Adapters**: [node.js](adapters/node.js) (`werft dev` / `werft serve`),
  [cloudflare.js](adapters/cloudflare.js) (Pages Functions), [php/werft-publish.php](adapters/php/werft-publish.php)
  (receiver for PHP web space).

### Editor features

| WordPress | werft |
|---|---|
| Login at /admin, users, roles | Own e-mail/password logins, no GitHub account needed. Roles Administrator, Redakteur, Autor, Mitarbeiter with WordPress's rules ([roles.js](gateway/roles.js)), enforced by the gateway. "Benutzer" in the editor for administrators; "Mein Konto" for everyone. |
| Pages and posts | Pages built from sections (the theme's blocks), plus one post type per theme (e.g. events). Add, delete, reorder sections. "Seite duplizieren" (in a page's settings and at the end of its form) copies a page in the language being edited as a draft under a new title and address, without its publishing date and SEO title. "Adresse" in a page's settings changes its address (administrators, since it adds a redirect): in one save the page and its translations are renamed, links in the content follow, a published page's old address redirects to the new one, and what still names the old address (a full URL) is listed. |
| Draft, pending review, publish, schedule | Status per entry; a publish date in the future schedules it (see [Scheduling](#scheduling)). Contributors are offered only "Entwurf" and "Zur Prüfung"; when the gateway refuses a change for the editor's role, the admin says so instead of "try again later". |
| Visual editing, preview | Two views of the same [editor](#editor), switched at the top of the sidebar: "Formular" shows the fields beside a live preview rendered by the site's own theme (a click on a section in the preview opens it in the form); "Auf der Seite" edits on the page itself. A post without a page of its own (no `renderPost` in the theme) is previewed marked on the page that lists it, else alone in the theme's listing section, else as a card of its fields. |
| Media library, alt text | "Bilder": all images with where each is used, searchable by file name, alternative text and page, and filtered to unused images or images used without alternative text (marked "Ohne Alternativtext auf: …"); upload several at once, "Ersetzen" swaps an image for a new upload everywhere the editor may change (the old file stays while anything else still names it), delete only unused ones (replace and delete: Administrator, Redakteur). Large photos are scaled down before they are saved (see [Images](#images)). Images are fields with file, alt text, caption and focal point. |
| Menus, site settings, SEO | Menu locations the theme declares; site settings; SEO title, description, share image and noindex per page, written into the page by [`ctx.head()`](#install). |
| Revisions | Every save is a git commit. "Frühere Versionen" under each entry compares a version with the current one by content and brings it back as an unsaved change. "Gelöschte Inhalte" (under "Weitere Inhalte", administrators and editors) lists pages, posts, patterns and forms deleted in the last 30 (on request 100) commits that changed the content, and brings one back as it was last saved, a page or post as a draft, as an unsaved change. |
| Reusable blocks | Patterns: sections shared by several pages. |
| Forms, redirects | Form definitions edited in the admin (the theme renders them); visitors' submissions kept in the repository and shown under "Einsendungen" (see [Form submissions](#form-submissions)); redirects written as `_redirects` and `.htaccess` (`/alt/*` to `/neu/:splat` works in both). |

### Editor

`/admin` is one app. The sidebar lists everything that can be edited (pages, the theme's post type,
site settings, menus, images, form submissions, users; patterns, forms and redirects folded under "Weitere Inhalte")
and is the same in both views. Its search ("Suchen …") finds pages, posts, patterns and forms by
their titles and texts in the language being edited, and images by name, ignoring case and accents;
Enter opens the first match, Escape ends the search. A switch at its top changes the view; the editor remembers the last
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
- "Mein Konto" (every role): one's own name, one's own password (with the current one; wrong
  guesses count against the session like [sign-in](#sign-in) attempts, 5 then a growing wait; the
  other devices are then signed out) and "Überall abmelden". The gateway takes only the name and
  the password there, only for the signed-in user, and refuses a session the change has ended.
- Unsaved changes are also kept in the browser (its local storage, per user, site and branch), so
  a closed tab or a crash does not lose them. When the admin opens again on that browser, it offers
  "Wiederherstellen", "Verwerfen" or "Später" and names entries someone saved since; restoring
  replaces those with the kept changes, as unsaved changes. New images too large for the browser's
  storage are not kept, and the message says so. "Abmelden" removes them from the browser.

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
     languages: ['de', 'en'],       // optional, the first is the default; see Languages
     images: { maxSize: 2560, widths: [480, 960, 1600], formats: ['webp'] }, // optional; see Images
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
     Once the site setting `url` is set, the build writes `feed.xml` (RSS 2.0, `en/feed.xml` for a
     language with posts of its own) with the 20 newest published posts by their publish date
     (else the date field), leaving out noindex posts: title, link to the post's page (to the home
     page without `renderPost`), date and the text `postType.feed.description(post, ctx)` returns
     (with the post's `ctx` as in `renderPost`; default: the post's SEO description), shown as
     plain text. `postType.feed.title` (text, or
     a function of the language) replaces the title "<site name>: <post type label>". A site set
     to "Nicht indexieren" or without public posts gets no feed. The build's `feed.xml` replaces a
     file of that name from the theme; a theme with its own feed sets `feed: false`, which also
     leaves out the link.
   - `ctx` offers `settings`, `menu(id)`, `image(src)` (with width and height), `img(image, options)`
     (a responsive `<img>`, see [Images](#images)), `posts()`, `form(slug)`,
     `md()`, `inline()`. `posts()` returns the published posts newest first by their date, posts
     without a date last by slug; `posts({ slugs })` returns the named posts in that order, and
     `limit` cuts the list. The admin lists posts newest first too.
   - For [languages](#languages), `ctx` (inside `renderPage`, `renderPost` and block renders) also
     offers `lang` (the entry's language; without `languages` the site setting `lang`, else `'de'`),
     `languages` (the configured list, `[]` without the option), `url(path)`, `asset(path)` and
     `translations`.
     `url(path)` turns a path relative to the site's root (`assets/css/site.css`, a media file
     from the content, `en/kontakt.html`, `''` for the home page) into an address that works from
     the page being rendered (`../assets/css/site.css` on `en/` pages, unchanged on pages at the
     root); addresses with a scheme or starting with `/`, `#` or `?` stay as they are. Use it for the
     theme's assets and for media files outside Markdown. `asset(path)` is `url(path)` with a hash
     of the file's content for a stylesheet or script (`.css`, `.js`, `.mjs`) in the theme's
     `staticDir` (`assets/css/site.css?v=3f2a…`), so a visitor's browser does not keep an old copy
     after the file changed. The path is written as the file's path inside `staticDir` (no `./`
     or `/` in front; files below a symbolically linked folder get no hash). Only the build adds
     the hash (not the editor's preview), and only to the address given to `asset()`: files a
     stylesheet or script names itself (fonts in `url()`, `@import`, a module's `import`) keep
     their addresses. A JavaScript module that other modules import is best loaded with `url()`,
     or the browser runs it twice. `translations` is one item per language,
     `{ lang, url, current, exists }`: `url` leads to the entry in that language if it is
     published (`exists`), else to that language's home page, and is ready for an `href`.
   - `search: true` adds [site search](#site-search); `ctx.search()` then renders the search box.
   - `ctx.head(options)` (inside `renderPage` and `renderPost`) writes the tags for `<head>`:
     `<title>` (the SEO title, else the entry's title, with the setting `title_suffix`; the site's
     name for an untitled entry), the description, `robots` noindex (the page's or the site's),
     Open Graph (`og:*`) and `twitter:card` for link previews. The canonical address, `og:url`, a
     share image given as a media path and, for a site in several languages, `hreflang` links to
     the entry's published and indexed versions (with `x-default` for the default language) need
     the default language's site setting `url`, the address of the home page (with the base path,
     e.g. `https://example.org/salon/`). The share image is the page's SEO image, else the site
     setting `share_image`; with width and height when it is a media file. `options`
     (`{ title, description, image, type }`) replace what the entry gives; `image` is a media
     path, an `https://` address or a `fields.picture()` value (its `alt` becomes `og:image:alt`),
     e.g. `ctx.head({ description: post.teaser, image: post.image })` in `renderPost` (a post has
     SEO fields only if its type adds `fields.seo()`). It links the language's feed of posts
     (see `postType` above). With the site setting `icon` ("Symbol der Website (Favicon)", set in
     the default language and used for all), it also writes
     `<link rel="icon">` (with its type, and its size for a PNG, JPEG, GIF or WebP),
     `apple-touch-icon` (for a PNG or JPEG) and `<link rel="manifest">` for
     `manifest.webmanifest`, which the build then writes at the site's root; the icon is used as
     uploaded, so a square PNG of 512 × 512 pixels serves every place. A theme with its own icon
     tags or `manifest.webmanifest` leaves the setting empty, since the build's manifest replaces
     a file of that name. The theme keeps
     writing `<meta charset>`, the viewport and its assets.
4. **Content**: `content/pages/<slug>.json` (`index` becomes `index.html`), `content/patterns/`,
   `content/forms/` (see [Form submissions](#form-submissions)), `content/<post type>/`, `content/settings/{site,menus,redirects}.json`;
   other languages in `content/<lang>/` (see [Languages](#languages)).
   A page is `{ "title": "Start", "status": "published", "sections": [{ "type": "text", … }] }`.
   The page `404` is the [not-found page](#not-found-page).
   Write the status into files you create by hand: the build publishes a file without one, but the
   admin shows it as "Entwurf" and saving it there would unpublish it.
5. **First administrator**: `npx werft user add you@example.org`, then commit `.werft/users.json`.
   Later users are added on the Benutzer page.
6. **Cloudflare**: add `functions/api/werft/[[path]].js` as in [adapters/cloudflare.js](adapters/cloudflare.js).
7. Run `npm install && npm run dev`, open `http://127.0.0.1:8787/admin/`.

## Usage

```sh
npx werft build [dir]          # build into the site's output directory
npx werft check [dir] [--strict]
                               # build elsewhere and check links, media and alt texts
npx werft dev [dir] [--port 8787]
                               # site, /admin and gateway on this checkout; commits locally
npx werft serve [dir]          # the same for production; needs WERFT_SECRET
npx werft user add <email> --role editor --name "Name"
npx werft user list|set|remove
npx werft secret               # a random secret for WERFT_SECRET / WERFT_PUBLISH_SECRET
npx werft publish [dir]        # send the build to werft-publish.php
```

### Checking a site

`werft check` builds the site into a temporary directory (the output directory stays as it is) and
checks every page and stylesheet of the build, without network access. Each problem is printed once
with its places (`file:line:column` in the build) and, where its address is written in the content
or the theme, that file and line (`written in content/settings/menus.json:12`).

| Rule | Default | Finds |
|---|---|---|
| `broken-link` | error | a link (`<a>`, `<area>`, `<iframe>`, `<link rel="alternate">` …) to a page or file that is not in the build, or a redirect to one; a link to a redirect's source passes |
| `broken-anchor` | error | `page.html#name` or `#name` without an element with that `id` (or `<a name>`) on the page |
| `untranslated-link` | error | on a page of a language other than the default, a link to that language's version of a page it does not have, which the build does not rewrite (e.g. `/en/impressum.html`; see [Languages](#languages)) |
| `missing-file` | error | an image, `srcset` candidate, stylesheet, script, video, poster or CSS `url()`/`@import` that is not in the build |
| `missing-alt` | error | `<img>` without an `alt` attribute |
| `empty-alt` | warning | `<img alt="">` not marked as decoration (`role="presentation"` or `"none"`, `aria-hidden="true"`); an image without a source (filled in by a script) passes |
| `large-file` | warning | a file above 1 MB (`check.maxFileSize`) |

Addresses on other hosts, `mailto:`/`tel:` and the gateway (`/api/werft/…`) are not checked, nor
are the admin and `_werft/`. A link must name a file or a folder with an `index.html`: `kontakt`
for `kontakt.html` only works on some hosts and is reported. `werft check` exits with 1 when there
is an error, with `--strict` also on a warning. A site changes the rules in `werft.config.js`:

```js
check: {
  rules: { 'empty-alt': 'error', 'large-file': 'off' }, // 'error', 'warning' or 'off'
  maxFileSize: 2_000_000,                               // bytes
  ignore: ['alt/'],                                     // paths in the build that are not checked
},
```

In a site's gate, `werft check` replaces `werft build` (it builds too, but does not write the output
directory; a gate step that needs `_site` still runs `werft build`): `"gate": "werft check"`, or
`npx --no-install werft check` as a step of a gate script. A finding then stops the deploy, also
when an editor's save caused it; warnings do not.

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
   so only the `deploy` job puts a build live. Set Preview branches to "Custom branches", include
   `*`, exclude `werft-submissions` and `werft-sessions` (or "None"), so a
   [form submission](#form-submissions) or a [sign-out](#sessions) does not start a build.
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
   | `WERFT_MAIL`, `WERFT_MAIL_FROM` | optional: the [e-mail](#e-mail) driver and the sender address |
   | `WERFT_MAIL_KEY`, `WERFT_MAIL_ACCOUNT` | for e-mail through a provider, see [E-mail](#e-mail); the key is a secret |

   Optional binding: a KV namespace bound as `WERFT_KV` makes the [sign-in limits](#sign-in)
   count across Cloudflare's isolates.

5. In the site: give its `package.json` a `gate` script (its own checks; at least `werft build`, better
   [`werft check`](#checking-a-site)),
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
       # One deploy at a time, the others queue in order.
       concurrency:
         group: deploy-production
         cancel-in-progress: false
         queue: max
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
         # Only the newest commit on main deploys: an older one whose gate finished late would
         # otherwise roll production back.
         - id: main
           run: echo "sha=$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)" >> "$GITHUB_OUTPUT"
           env:
             GH_TOKEN: ${{ github.token }}
         # From the site's root, so Wrangler compiles functions/ (the gateway) with the build.
         - if: steps.main.outputs.sha == github.sha
           run: npx wrangler pages deploy _site --project-name <project> --branch main --commit-hash "$GITHUB_SHA"
           env:
             CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
             CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
   ```

   For a site in a subdirectory, add `defaults: { run: { working-directory: <dir> } }` to both
   jobs and `cache-dependency-path: <dir>/package-lock.json` to `setup-node`. A commit that is no
   longer the newest on `main` when its turn comes is not deployed; if the newer one fails its
   gate, production stays as it was until a commit passes.
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
code files, accepts `.htaccess` only with redirect lines and a local `ErrorDocument 404 /….html`
(see [Not-found page](#not-found-page)) and writes nothing through symbolic links.
A file already in the web space with the same name and different content stops the publish:
remove or rename it there first (identical files are taken over). The admin is not published: editors
use the admin on the build host.

With Cloudflare Pages as the build host, the domain points at IONOS, the admin stays at
`https://<project>.pages.dev/admin/`, and every save publishes to IONOS through the `deploy` job:
add `WERFT_PUBLISH_URL` as a variable and `WERFT_PUBLISH_SECRET` as a secret of the `production`
environment, and this step after the Wrangler step, with the same `if`:

```yaml
- if: steps.main.outputs.sha == github.sha
  run: npx werft publish
  env:
    WERFT_PUBLISH_URL: ${{ vars.WERFT_PUBLISH_URL }}
    WERFT_PUBLISH_SECRET: ${{ secrets.WERFT_PUBLISH_SECRET }}
```

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

### Languages

A site in several languages names them in `werft.config.js`, the default first:
`languages: ['de', 'en']` (codes that differ only in case are refused). Without the option a site
builds as before. The default language's
content stays where it is; each other language has its own in `content/<lang>/`, laid out the same
way:

| File | In `content/en/` |
|---|---|
| `pages/<slug>.json` | The page in English. A translation has the slug of its original; that is how the two are found. A page may exist in one language only. |
| `patterns/`, `forms/` | Translated patterns and forms; one that is missing comes from the default language (same slug). |
| `<post type>/` | The language's own posts, once one of them is public (published and due). Until then the language lists the default language's posts; their pages are published once, in the default language, and `ctx.postUrl()` on the language's pages leads there. |
| `settings/site.json` | Only what differs: laid over the default settings key by key (lists are replaced as a whole, `null` removes a value), so the phone number and the like are kept once. `lang` is the language's code unless the file sets it. |
| `settings/menus.json` | Replaces the default menu of each location it has. |

Redirects (`content/settings/redirects.json`) and media are shared. The default language is built at
the site's root as before; the others below their code (`en/index.html`, `en/<slug>.html`, posts at
`en/<postType.url>`). Inside a language, links in the content (`kontakt.html`, `#anfrage`) lead to
pages of the same language. On every page and post page of a language, a relative link that leads
to a page the language does not have (`impressum.html` from `en/`, `../impressum.html` from
`en/termine/`; also `index.html` and `./`, with `?…` or `#…`), for example from a menu or settings
it takes from the default language, is rewritten to the default language's page of that name
(`../impressum.html`, `../../impressum.html`), in the build and in the editor's preview. Markdown images from the media folders are made relative to the page.
`sitemap.xml` lists every language and names the versions of an entry with
`<xhtml:link rel="alternate" hreflang="…">`. The theme writes the `lang` attribute, its assets and a
language switch with `ctx.lang`, `ctx.url()` and `ctx.translations` (see [Install](#install)):

```js
html`<html lang="${ctx.lang}"><link rel="stylesheet" href="${ctx.url('assets/css/site.css')}">
  ${ctx.translations.map((t) => html`<a href="${t.url}" hreflang="${t.lang}">${t.lang}</a>`)}`
```

In the editor, "Sprache" at the top of the sidebar picks the language; the sidebar, both views and
the preview then show that language. A page that exists in another language is listed under "Noch
nicht übersetzt"; "Übersetzen" copies it, as a draft with the same slug, for translating in place.
Site settings and menus are edited complete and saved with only what differs from the default
language. A pattern or form that is not translated shows the default language's until it is
changed, which saves it in the language being edited. A language without posts of its own lists
and edits the default language's posts (the sidebar says so); "Eigene … beginnen" (for roles that
may publish) creates its first own post, and once one of its own posts is published the language
shows only its own. The gateway checks `content/<lang>/…` like
the same path of the default language (roles and kinds), and a translated form's submissions go with
its original's. The gateway's thank-you page, its messages and the confirmation e-mail are in the
language of the page the form was on (see [Form submissions](#form-submissions)).

### Images

The editor scales an uploaded JPEG, PNG or WebP down before it is saved when its longer edge is
larger than `images.maxSize` in `werft.config.js` (default 2560 pixels, as in WordPress; `0` keeps
every upload as it is). It keeps the format and the proportions, so a PNG keeps its transparency,
applies the orientation the camera recorded and drops other metadata such as the location, and
tells the editor what it did. It never scales up, and keeps the original when scaling would not
make the file smaller or the browser cannot write the format. GIFs, animated PNGs and WebPs,
smaller images and other files are saved as they are, as are files added to the media directory
without the editor. In Chrome, a 6000 × 4000 JPEG of 24 MB became 2560 × 1707 and 1.8 MB in under
a second (measured 24 October 2026, Chromium 155, a photo-sized image of noise, the worst case for
its size).

`werft build` makes smaller copies of every JPEG, PNG and WebP image in the media directories, 480,
960 and 1600 pixels wide (only widths below the image's own) in its own format and as WebP, into
`_werft/img/` in the output; the repository keeps only the originals. `images` in `werft.config.js`
changes that: `widths: [400, 800, 1200]`, and `formats: ['webp', 'avif']` adds AVIF (about 40 %
smaller than WebP, slower to encode). GIFs and animated images keep their one size. Each width and
format is one more file per image in the output: Cloudflare Pages' free plan takes at most 20,000
files per deployment, so a site with thousands of images uses fewer widths or formats. The copies
are made with [sharp](https://sharp.pixelplumbing.com/), an optional dependency installed with
werft; where it cannot be installed, the build says so and the site uses the originals. The build
keeps the copies in `node_modules/.cache/werft-images`, by the image's content, encodes only new or
changed images and removes the copies no image needs any more: four 2560-pixel photos took 1.5 s in
the first build and 0.1 s in the next (measured 24 October 2026 on a 48-thread workstation, Node 22;
about one second of one core per photo). To keep the cache between GitHub Actions runs, add this
step after `npm ci` in the site's `deploy` job (and in `gate`, if it builds):

```yaml
- uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
  with:
    path: node_modules/.cache/werft-images
    key: werft-images-${{ hashFiles('assets/img/**') }} # the site's mediaDirs
    restore-keys: werft-images-
```

Themes write images with `ctx.img(image, options)`; `image` is a picture field (`{ src, alt }`) or
a path. It writes `<img>` with `width` and `height` from the file, `alt` (from the field, or
`options.alt`, else empty), `loading="lazy"` and `decoding="async"`, and for an image with copies
`srcset` and `sizes` (`options.sizes`, default `100vw`) inside a `<picture>` with a `<source>` for
the WebP (and AVIF) copies, so the browser loads the smallest file that fills the space. Every
other option becomes an attribute (`class`, `style`, `loading: 'eager'` for the first image of a
page, `fetchpriority`; `width` and `height` replace the file's), and `false` leaves one out:

```js
ctx.img(section.image, { sizes: '(min-width: 60em) 50vw, 100vw', class: 'hero' })
// <picture><source type="image/webp" srcset="_werft/img/assets/img/foto.480.webp 480w, …" sizes="…">
//   <img src="assets/img/foto.jpg" alt="…" srcset="_werft/img/assets/img/foto.480.jpg 480w, …,
//   assets/img/foto.jpg 2560w" sizes="…" width="2560" height="1707" loading="lazy" decoding="async"
//   class="hero"></picture>
```

A picture field (`fields.picture()`) has a focal point, "Wichtiger Bildteil": the editor clicks
the part of the image that must stay visible when the theme crops it (or moves it with the arrow
keys). It is stored as `"focus": "30% 70%"`, and `ctx.img()` writes it as `object-position`, ahead
of the theme's own `style`, so `object-fit: cover` keeps that part in view. A theme that writes its
own markup uses `ctx.image(section.image).focus`, which is set only for a valid point (anything else
in the content could carry other CSS); `fields.picture(name, label, { focus: false })` leaves the
field out. Picking another image for the field removes the point.

`ctx.image(src)` (a path or a picture field) gives the same as data: `width`, `height`, `variants`
(`{ src, width, height, type }`), `srcset` and `sources` (`{ type, srcset }`), with addresses that
work from the page being rendered. The editor's preview shows the originals.

### Sign-in

The gateway slows down password guessing ([throttle.js](gateway/throttle.js)). Each attempt counts
against the e-mail address entered and against the client's address. A successful sign-in clears
the e-mail address's count (or the device token's, see below) and does not count against the
client's address; that address keeps its failures.

- After 5 attempts for one e-mail address, or 20 from one client address (IPv6: its /64 network),
  the next attempt waits 1 minute, and each further failure doubles the wait up to 15 minutes. While
  it lasts, the gateway answers 429 "Zu viele Anmeldeversuche. Bitte in … Minuten noch einmal
  versuchen." without checking the password. An hour without attempts forgets them. A guesser gets
  about 100 tries a day per account.
- An e-mail address without an account counts the same and is hashed as often as the first user's
  password, so neither the replies nor their timing show which accounts exist.
- A browser that signed in to an account keeps a device token for it, also after "Abmelden" (not
  after its data is cleared). Its attempts count against that token only, so guessing from
  elsewhere does not lock the owner out of their usual browser; on a shared computer the next
  person gets the token's tries besides the account's. On a new browser the owner waits like the
  guesser: as long as someone keeps guessing, that can be all the time.

Where the counts live:

- `werft serve` and `werft dev`: in the server's memory, at most 10,000 counts. Beyond that a flood
  of new e-mails or addresses pushes out the oldest forgotten counts, then single attempts, then
  counts not in a wait, and a count in a wait only when all 10,000 are in one; a restart forgets
  them. Behind a reverse proxy all clients have the proxy's address and share the limit of
  20.
- Cloudflare Pages: in the memory of each Workers isolate. Cloudflare runs several and replaces
  them often, so a guesser gets more tries than above. With a KV namespace (create one in the
  Cloudflare dashboard, then add it to the Pages project's bindings as `WERFT_KV`) all isolates
  share the counts: a sign-in reads up to two keys, a failed one writes up to two, and a successful
  one after failures deletes the key of the e-mail address or device token. The Workers Free plan,
  which covers the whole Cloudflare account and so every site on it, has 100,000 reads, 1,000
  writes and 1,000 deletes a day, so after about 500 failed sign-ins in a day, on any of them, the
  gateway counts per isolate again until the quota resets at 00:00 UTC; KV also takes up to 60 seconds to show a write in
  other locations. A store that counts exactly (D1, a Durable Object) would need a database or a
  separate Worker per site; werft does not use one.

Not covered: guesses spread over many addresses still get the per-account limit for each account,
and a guessed or leaked password works on the first try. The limits do not replace a long password
(the gateway takes no shorter than 10 characters).

### Sessions

Signing in starts a session ([core.js](gateway/core.js)): an access token for 12 hours, which the
admin keeps only in the open page, and a refresh token for 30 days in an HttpOnly cookie
(`werft_refresh`, path `/api/werft/`, SameSite=Strict, Secure when the request came over HTTPS,
also through a reverse proxy that sends `X-Forwarded-Proto: https`), which scripts on the site
cannot read. A reload, or an access token that has expired, renews the session with the cookie.

- "Abmelden" ends the session on the server: its refresh token is refused from then on, and so is
  its access token (at once in the same process; on Cloudflare in other isolates within a minute).
- "Überall abmelden" in "Mein Konto" (everyone, for themselves) and on "Benutzer" (administrators,
  for anyone) ends every session of that person. Changing a user's password or role, or deleting
  the user, ends them too.
- Ended sessions are listed in `.werft/sessions.json` on the branch `werft-sessions`, which the
  gateway creates with the first sign-out: one small commit per sign-out, never on the site's
  branch, so nothing is rebuilt. Entries are dropped once their tokens have expired. Renewing a
  session reads the list (one GitHub request more while it is unchanged, about four after a
  change); other requests use a copy at most a minute old. A sign-out costs about 8 to 12 requests.
  If it cannot be recorded, the editor says so and stays open to try again.
- werft 0.5 kept both tokens in `localStorage`. The admin moves such a session to the cookie on its
  next renewal and deletes the stored tokens; a copy taken before then ends only with "Überall
  abmelden" or after its 30 days.

### Not-found page

A page with the slug `404` (`content/pages/404.json`, per language in `content/<lang>/pages/`)
builds to `404.html` (`en/404.html`), stays out of `sitemap.xml` and is noindex. Every host answers
an address the site does not have with the nearest one and status 404:

- Cloudflare Pages finds `404.html` on its own.
- `werft dev` and `werft serve` answer with the nearest `404.html` above the address
  (`en/404.html` for `/en/…`, else `404.html`), else with "Not found".
- On PHP web space the build writes `ErrorDocument 404 /404.html` into `.htaccess` (and
  `en/.htaccess` for a language with its own page); the receiver accepts these lines. The root
  `.htaccess` then exists even without redirects and applies to the whole web space: a hand-made
  `.htaccess` already there stops the publish (see [PHP web space](#php-web-space-ionos-and-similar));
  move its lines elsewhere or remove it first.

The page is shown at the address that was asked for, so its relative links would start from there;
[`ctx.head()`](#install) writes `<base href>` for its folder, so the theme's `ctx.url()` addresses
and the links in the content work. Call it before the theme's stylesheets and scripts, since an
address before `<base>` still starts from the requested one. On this page an anchor alone (`#main`, a skip
link) leads to the home page of its folder, so the page is best kept without one. A theme that writes
its own head gives the page root-relative addresses instead.

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

### E-mail

The gateway sends e-mail through a driver ([mail.js](gateway/mail.js)) that the environment
names: `WERFT_MAIL` is the driver, `WERFT_MAIL_FROM` the sender address (Pages environment
variables, or the environment of `werft serve` and `werft dev`). Without `WERFT_MAIL`, `werft dev`
uses `log`; `werft serve` and Pages send nothing, and `/api/werft/status` reports `"mail": false`.

| `WERFT_MAIL` | Sends | Also set |
|---|---|---|
| `log` | nothing: prints each e-mail to the log, links for a new password too, so it is for development and trying out | |
| `cloudflare` | through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) (its REST API; Pages Functions cannot use the `send_email` binding) | `WERFT_MAIL_ACCOUNT` (the account ID), `WERFT_MAIL_KEY` (an API token with "Email Sending: Edit") |
| `brevo` | through [Brevo](https://www.brevo.com/)'s transactional API | `WERFT_MAIL_KEY` (an API key) |
| `resend` | through [Resend](https://resend.com/)'s API | `WERFT_MAIL_KEY` (an API key) |
| `smtp` | through an SMTP server; `werft serve` and `werft dev` only, not on Cloudflare | `WERFT_MAIL_HOST`, `WERFT_MAIL_PORT` (default 587), `WERFT_MAIL_USER` and `WERFT_MAIL_KEY` (the password) when the server wants a login |

A missing setting stops the gateway at start with a message naming it. Mark `WERFT_MAIL_KEY` as
a secret. What each provider costs (as of October 2026; check its pricing page):

- `cloudflare`: Email Sending is in beta. It is free only to the destination addresses verified in
  the Cloudflare account (enough for notifications to the site's owner); any other recipient, such
  as a visitor or a new password, needs the Workers Paid plan.
- `brevo` and `resend`: a free plan with a daily limit (Brevo 300 e-mails a day, Resend 100 a day
  and 3,000 a month), paid plans above it.
- `smtp`: whatever the mail server's provider charges. werft always encrypts: port 465 speaks TLS
  from the start, any other port must offer STARTTLS, and the server's certificate must be valid;
  it never sends the password unencrypted. Domains with umlauts go out in punycode; an address with
  umlauts before the @ cannot go over SMTP, so such a recipient fails the e-mail and such a
  reply-to is left out.

The sending domain (the one in `WERFT_MAIL_FROM`) has to prove it may send, or the e-mails land in
spam: an SPF and a DKIM record, which the provider names when the domain is added there, and a
DMARC record (`_dmarc.<domain>`, e.g. `v=DMARC1; p=none`). Cloudflare adds them itself when the
domain's DNS is at Cloudflare (Email Service → Email Sending → Onboard Domain); for Brevo and
Resend, add the domain in their dashboard and its records at the DNS host; for SMTP, the mail
server's provider names them.

A provider processes personal data (recipients, and what a visitor wrote): the site's operator
needs a data processing agreement with the provider and names it in the privacy policy.

Every driver gets the same checked message (one to 20 recipients, plain addresses, subject and
sender name on one line), so a value from a visitor cannot add a header. A driver for another
provider is a small file next to [mail.js](gateway/mail.js) and an entry in its `DRIVERS`. Tests use
`memoryMail()`, which keeps the e-mails it gets in `sent` and fails while `failure` is set; the
provider drivers are tested against fakes of their APIs ([fake-mail.js](test/fake-mail.js)).

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
- The thank-you page and the messages are in the language of the page the form was on: the field
  `_lang` if it names one of the site's [languages](#languages), else a folder of the page's address
  named after one (`en/kontakt.html`), else the default language; a site without `languages` takes
  `lang` from its settings. A form posted from another host (PHP web space) sends only that host as
  referer, so there the theme writes the language into the form:
  `<input name="_lang" type="hidden" value="${ctx.lang}">`. The text after sending is
  the form's `thanks` ("Text nach dem Absenden" in the editor) in that language, else werft's own
  (German and English), else the default language's `thanks`, else werft's German one, marked with
  its language. A translation whose `thanks` is still the original's (the editor copies the whole
  form) counts as having none.
- A submission is not a content change: `werft serve` does not rebuild for it, and on Cloudflare
  Pages the excluded preview branch (step 3 above) keeps it from starting a build (the free plan has
  500 a month). `werft dev` and `werft serve` commit to the local `werft-submissions` branch and
  leave the working tree alone.
- On PHP web space the form's `action` is the build host's gateway, e.g.
  `https://<project>.pages.dev/api/werft/forms/newsletter`.
- With [e-mail](#e-mail) set up, a submission can also be sent by e-mail (see below).

#### E-mail for a submission

In the editor, each form has "E-Mail bei neuer Einsendung" (the field `notify` of
`content/forms/<form>.json`):

```json
{ "title": "Anfrage", "notify": { "to": "team@example.org, chef@example.org", "confirm": true,
  "confirm_subject": "Ihre Anfrage", "confirm_text": "Danke, wir melden uns bis morgen." } }
```

- `to`: the addresses that get each submission ("Neue Einsendung: <title>", one line per field),
  separated by commas. The reply-to is the visitor's address: the field `email` (`e-mail`,
  `mail`), else the first field that holds an address.
- `confirm`: the visitor gets a confirmation to that address, with `confirm_subject` (default
  "Ihre Nachricht an <site name>") and `confirm_text` (default "Vielen Dank, Ihre Nachricht ist
  angekommen."). It holds nothing the visitor wrote, so nobody can send their own text to someone
  else through the site, and each address gets at most one a day, from any form of the site. The
  gateway finds the confirmations of the last day in the names of the submission files, which carry
  a short keyed hash of the address; deleting a submission resets this for its address. Rarely
  (about one in 65,000 submissions of that day) a visitor goes unconfirmed because another
  submission's file name looks the same. With confirmations on, use [Turnstile](#spam) so bots
  cannot send them to strangers.
- The submission is stored first. An e-mail that fails is written to the log and the visitor still
  gets the normal reply, so nothing is lost; it stays under "Einsendungen".
- The recipients and whether to confirm are read from the form in the default language; the editor
  shows them there only. They are part of the content: anyone who can read the repository, and the
  theme through `ctx.form()`, sees the addresses. The confirmation's subject and text come from the
  form in the page's language, with the same fallbacks as `thanks`.

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

### Site search

With `search: true` in the theme, the build writes a search index per language and a small script,
and `ctx.search(options)` renders a search box in the page frame or a block. The visitor's browser
loads the index the first time the box is used and searches it itself: no other service, the same
on Cloudflare Pages, a Node server and PHP web space. Without the option `ctx.search()` throws.

```js
html`<header>${ctx.search({ label: 'Suche', placeholder: 'Suchbegriff', empty: 'Nichts gefunden.' })}</header>
  <main>${ctx.blocks(page.sections)}</main>`
```

- The index is `_werft/search/<ctx.lang>.json`: `{ lang, entries: [{ url, title, text }] }`, one
  entry per published page and post page of the language (a language that shows the default
  language's posts lists those), except those set to `noindex` in SEO.
  `url` is relative to the site's root (`''` for the home page, `en/` for the English one), `title`
  is the entry's title (else its first `<h1>`), `text` the text of the page's `<main>` (else its
  `<body>`) without `<nav>`, `<search>`, scripts and styles. Put the content in `<main>`, so the
  menu, header and footer do not make every page match.
- The script `_werft/search.js` (3.0 KB, 1.2 KB gzipped, no dependencies) shows the box, which is
  hidden until then (without JavaScript there is no box that does nothing), and lists up to 10
  matches while the visitor types: every word must occur in the title or the text, case and accents
  are ignored (`fahre` finds "Fähre"), matches in the title come first, each with an excerpt.
- Markup to style: `<search class="werft-search"><form data-werft-search="…"><label><span>Suche</span>
  <input type="search" name="q"></label><ul aria-live="polite">` with one `<li><a>title</a><p>excerpt</p></li>`
  per result, or one `<li>` with the `empty` text. The texts default to German; a site in several
  languages passes them per `ctx.lang`.
- The index holds the text of every public page and is loaded whole, so it suits small sites; its
  size is that of the site's text.
- The editor's preview runs no theme scripts, so the box does not show there.

## Compatibility

Last verified on 18 October 2026 with werft 0.5.0 and `main`: the gate on Node 22 and 24 with PHP
8.3 (GitHub's `ubuntu-24.04` runner).

- Admin: a current Chrome, Edge, Brave, Firefox or Safari (import maps and ES modules). It loads
  nothing from other hosts and uses the system font.
- Build and `werft serve`: Node 22 or newer. Receiver: PHP 7.4 or newer.

### Known limits

- "Gelöschte Inhalte" reads the file list of every commit it searches, one gateway request each;
  on GitHub storage each costs a commit and a tree request (plus one per directory level of
  `WERFT_DIR`), so a search of 100 commits counts at least 200 requests against the rate limit (from the code, not measured).
  A page moved to a new address is not listed when its old address redirects or its content was
  unchanged by the move.

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
`github:frontierdsgn/werft` gets a pull request to its default branch: one commit with
`package.json` and `package-lock.json` on the branch `build/werft-vX.Y.Z`, titled
`build(deps): bump werft from … to …`. Before committing, it runs the site's own gate
(`npm run gate`, if the site's `package.json` has that script) on the new werft, and builds each
site with its old and its new werft. A site whose gate or build fails is reported as failed with
the last lines of the output, and nothing is pushed. If the public pages differ (anything outside
`admin/` and `_werft/build.json`), the site is held back and the changed files are listed; check
them with `npm run dev` in the site, then run `npm run update-sites -- --accept-changes`.

It then waits up to 30 minutes for the site's `gate` check on the pull request's head commit. Once
that check concluded `success`, it squash-merges the pull request
(`gh pr merge --squash --delete-branch --match-head-commit <sha>`) and prints the merge commit and
the `gate` run on the default branch (or the `gh run list` command that finds it once GitHub has
started it); a site set up as in [Cloudflare Pages](#cloudflare-pages-default) deploys the commit
once that run passed. If the check failed, never appeared or did not finish in time, the pull
request stays open and the site is reported as failed; a later run reuses it. The script exits
non-zero when a site failed or was held back. Branches other than the default branch, and sites
outside the organization, keep their version.

The script ([scripts/release.js](scripts/release.js)) needs git, npm and `gh`, signed in with
permission to push branches and to open and merge pull requests in the organization's
repositories. It works in temporary clones and leaves local checkouts alone.

## Contributing, support and security

- Pull requests are welcome, also from forks: [CONTRIBUTING.md](CONTRIBUTING.md). Every change must
  be useful to any werft site, not only to one; the rules are in [AGENTS.md](AGENTS.md).
- Bugs and feature requests: [issues](https://github.com/frontierdsgn/werft/issues/new/choose).
- Vulnerabilities: privately, as described in [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE).
