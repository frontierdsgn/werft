---
name: verify-werft
description: Drive werft end to end from this checkout and capture proof — a disposable site under `werft dev`, the admin editor in headless Chromium (Playwright), the public site and gateway over HTTP, the CLI (`werft check`, `werft publish` to the PHP receiver). Use it to show that a change to werft works for a user (editing, saving, forms, submissions, checking, publishing), not only that `npm test` passes.
---

# Verify werft end to end

werft is a library and CLI that sites install; it has no app of its own. This skill makes a
throwaway site (`scripts/werft-verify up`), serves it with this checkout's `werft dev` (site, admin
at `/admin/` and gateway at `/api/werft/` on one port, commits to the site's own git), and drives it
like a user. The feature map in [features/README.md](features/README.md) says what to drive and what
proves it; the journeys in `journeys/` drive it.

Run it where your machine's rules let builds and tests run. Needs Node 22+, git, `curl`, `ss`, npm registry access once (for
`playwright-core`), Chromium (`chromium` or `google-chrome` on PATH, or `WERFT_VERIFY_CHROMIUM`), and
for `publish-php` a `php` CLI (`WERFT_VERIFY_PHP`). Run `npm ci` in the checkout first.

## Launch

```sh
V=.claude/skills/verify-werft/scripts/werft-verify       # from the checkout's root
export WERFT_VERIFY_ROOT=/tmp/werft-verify-$USER          # optional; default ${TMPDIR:-/tmp}
RUN=$($V up)                                              # or: $V up <run-id>
$V browser "$RUN"                                         # once per run: playwright-core into $RUN/pw
```

`up` prints the run directory, `$WERFT_VERIFY_ROOT/werft-verify-<id>/`, and returns only when the
instance is usable: the gateway answers with users, the first build is out (`/kontakt/` is 200) and
the admin is served. It stops with the server log after 30 s otherwise. Each run gets a free port, its
own site, git repository and `WERFT_SECRET`, so runs can go side by side. `run.json` in the run holds
`url`, `pid`, `site`, `evidence`, the checkout's `rev`, and the two fixture users:

| User | Role | Password |
|---|---|---|
| `admin@verify.test` (Ada) | administrator | `verify-password-1` |
| `editor@verify.test` (Eda) | editor | `verify-password-2` |

The fixture site (made fresh by `up`, never shared): pages Start (`/`), Kontakt (`/kontakt/`, the form
Anfrage), Danke (`/danke/`), a 404 page; forms `anfrage` (`receive: true`, button "Anfrage senden",
redirects to `/danke/`) and `newsletter` (no `receive`); a menu Start/Kontakt; a redirect `/alt.html`
→ `/kontakt/`; static `style.css`; settings `url` = the run's own URL. `node_modules/werft` links to
this checkout, so the site and the admin run the code under test. E-mails go to the server log.

## Doctor

```sh
$V doctor "$RUN"
```

Read-only. Every line must say `ok`: the pid is alive and is this run's `werft dev`, it owns the port,
the gateway answers with users, the build and the admin are served, the checkout is still at the
revision the run started from (else restart: the server runs old code), and the administrator can
sign in. Run it first whenever anything looks off. Never drive a server this run did not start.

## Drive

Journeys are Node scripts on [journeys/lib.mjs](journeys/lib.mjs); each takes the run directory:

```sh
node .claude/skills/verify-werft/journeys/edit-page.mjs "$RUN"        # admin: edit, preview, save → commit → public page
node .claude/skills/verify-werft/journeys/form-submission.mjs "$RUN"  # visitor form → submissions → CSV; opt-in
node .claude/skills/verify-werft/journeys/cli-check.mjs "$RUN"        # werft check: pass, broken link, restore
node .claude/skills/verify-werft/journeys/publish-php.mjs "$RUN"      # werft publish → werft-publish.php (exit 3 without PHP)
```

Exit 0 means every step passed; 1 a step failed (the message names it); 3 the journey could not run
here (a missing tool) and proves nothing. A new journey:

```js
import { journey, expect } from './lib.mjs';
const j = await journey(process.argv[2], 'my-feature');   // evidence goes to <evidence>/my-feature/
try {
  await j.signIn();                                       // the admin's sign-in form; j.signIn(j.run.editor)
  await j.step('what the user does', async (page) => {    // screenshot + ARIA snapshot after the step
    await page.getByRole('navigation').getByRole('button', { name: /^Kontakt/ }).click();
  });
  const { status, data } = await j.api('/api/werft/me');  // the gateway with an administrator's session
  j.record('me.json', data);                              // a text artifact next to the screenshots
  expect(j.git('log', '-1', '--format=%s').includes('…'), 'why it failed');  // the site's git
} finally { await j.done(); }                             // steps.json, closes the browser
```

Handles in the admin (German UI, `locale: de-DE`): the sidebar is `getByRole('navigation')` with one
button per entry, named by its title and its subtitle (`/^Start/`, `/^Einsendungen/`,
`/^Benutzer/`); the toolbar is `toolbar "Editor"` with `Speichern (Strg+S)`; the entry's form is
`main` with textboxes by label (`Titel`, `Überschrift`); sections are in `group "Abschnitte"` and
open on a click on their type (`Text`); the preview is the iframe `#ve-frame`; messages appear in
`role=status` (`Gespeichert. …`) and the toolbar's text `Alles gespeichert`. A button's name is its
`aria-label`/title where it has one (`Einsendungen „Anfrage“ als CSV herunterladen`), not its visible
text: read the step's `.aria.txt` when a locator does not match. Public pages: `getByRole('form', {
name: <form title> })`, `getByLabel('E-Mail')`.

## Evidence

Everything goes to `run.json`'s `evidence`, `$WERFT_VERIFY_ROOT/werft-verify-evidence/<id>/`, which
`down` keeps (with a copy of `server.log`): per journey a folder with one `NN-<step>.png` and
`NN-<step>.aria.txt` per step, `steps.json` (each step, its URL, ok or the error, browser console
errors, every response with status ≥ 400) and the artifacts the journey recorded (git log, stored
files, CLI output, downloads).

Proof standards:
- Drive what a user drives: the admin's buttons and forms, the public page's form, the CLI. Use
  `j.api` only to read state or for what a script would do anyway (a bot posting to a form).
- Prove the action and the resulting state: the screen after the step and the side effect behind it —
  the commit in the site's git (`j.git`), the file on `werft-submissions`, the rebuilt public page, the
  files in the web space.
- No mocks: the gateway runs on the git storage of the run's site; e-mails use werft dev's log driver
  (read them in `server.log`).
- `steps.json`'s `failedResponses` always holds `401 GET /api/werft/me` and `400 POST
  /api/werft/login/oauth/access_token` from the admin's start before sign-in; anything else there is a
  finding.
- A journey that exits 3 is reported as not verified, with its message, never as passed.

## Cleanup

```sh
$V down "$RUN"
```

Stops the server this run started (by the pid in `run.json`, after checking it is this run's `werft
dev`; it kills its process group) and deletes the run directory with the site, its git, `pw/` and a
publish web space. The evidence directory stays; delete it yourself when it is no longer needed. Run
`down` after a failed `up` or journey too (a failed `up` prints the command). Never kill werft by
name: other runs and other people's servers may be running.

## Helpers

- [scripts/werft-verify](scripts/werft-verify) (`up [id]`, `doctor <run>`, `browser <run>`,
  `down <run>`; without arguments it prints its usage).
- [journeys/lib.mjs](journeys/lib.mjs): `journey(run, name)` → `{ run, page, step, signIn, api, record,
  git, done, dir, errors, failed }`; `expect(cond, message)`.
- [features/](features/README.md): the map; add a feature file and a journey when werft gains a
  user-facing feature, and keep handles there up to date.
