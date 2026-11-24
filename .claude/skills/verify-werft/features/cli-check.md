# Check a site

`werft check` builds the site into a temporary directory and checks links, anchors, files and alt
texts of the build. It exits 0 on a clean site, 1 on an error, names each problem with its places in
the build and where it is written in the content, and leaves the site's output directory alone.

## Sub-features

- `check-clean` a clean site exits 0.
- `check-broken-link` a link to a missing page exits 1 with `broken-link`, the address and `written in <content file>:<line>`.
- `check-output` the output directory is not written.
- `check-strict` `--strict` also fails on warnings (not in the journey yet).

## How to get to it (user POV)

- `npx werft check [dir] [--strict]` in a site; in the fixture `node <checkout>/bin/werft.js check .`.

## Driving it with journeys/lib.mjs

Preconditions:

- Doctor all `ok`; the site's git is clean.

- **Clean.** Run `werft check .` in the run's site. Exit 0.
- **Break.** Add a menu item `{ "label": "Fehlt", "url": "fehlt.html" }` to `content/settings/menus.json` and run `werft check .`. Exit 1; stdout has `error broken-link: "fehlt.html"` and `written in content/settings/menus.json`.
- **Output untouched.** `_site/index.html` has no `fehlt.html`.
- **Restore.** Write the menu back; `werft check .` exits 0 and `git status --porcelain` is empty.
- **Proof.** `check-clean.json`, `check-broken.json`, `check-restored.json` (command, status, stdout, stderr). Run: `node journeys/cli-check.mjs "$RUN"`.

## Gotchas

- The menu edit is on disk, not committed: the running `werft dev` does not rebuild for it, and the
  journey restores the file even when a step fails.
- One broken menu link appears once per page that renders the menu (relative addresses differ per
  folder: `fehlt.html`, `../fehlt.html`).
