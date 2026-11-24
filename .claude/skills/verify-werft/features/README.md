# werft verification map

This directory is the maintained source for verifying what werft's users do: editors in the admin,
visitors on the public site, and site owners on the command line. Read this index before driving,
then use the matching feature file as the recipe. [../SKILL.md](../SKILL.md) covers launch, doctor,
evidence and cleanup.

## Baseline preconditions

- A run from `scripts/werft-verify up` with `doctor` all `ok`, and `scripts/werft-verify browser
  <run>` done once for browser journeys.
- The fixture as `up` makes it: pages Start, Kontakt (form Anfrage), Danke, 404; forms `anfrage`
  (`receive: true`) and `newsletter` (no `receive`); menu Start/Kontakt; redirect `/alt.html` →
  `/kontakt/`; users `admin@verify.test` and `editor@verify.test`.
- Never drive an instance the run did not start.

## Driving conventions

- Admin in headless Chromium through `journeys/lib.mjs` (`j.step`, `j.signIn`), with ARIA roles and
  accessible names; the admin is German.
- Public pages through the same browser, and over HTTP where a script is the user (a bot posting).
- CLI through `node <checkout>/bin/werft.js …` in the run's site, as a site's `npx werft …` would.
- Journeys may run again on the same run: they use fresh values (a timestamp) and restore what they
  change outside git history.

## Proof and skip reporting

- Per step a screenshot and an ARIA snapshot (`j.step` does both), plus the side effect: a commit in
  the site's git, a file on `werft-submissions`, the rebuilt public page, files in the web space.
- CLI proof: command, exit code, stdout and stderr (`j.record`).
- A journey that exits 3 could not run here: report it as not verified with its message.
- Do not report a feature as verified through another entry point than the one its file names.

## Features

- [Edit and save a page](./edit-page.md): admin form, live preview, save → commit → rebuilt page.
  Journey `journeys/edit-page.mjs`.
- [Form submissions](./form-submission.md): visitor form, redirect, `werft-submissions`, "Einsendungen",
  CSV, opt-in per form. Journey `journeys/form-submission.mjs`.
- [Check a site](./cli-check.md): `werft check` passes, reports a broken link with its source, leaves
  the output alone. Journey `journeys/cli-check.mjs`.
- [Publish to PHP web space](./publish-php.md): `werft publish` to `werft-publish.php`, incremental,
  foreign files kept, code refused. Journey `journeys/publish-php.mjs` (needs PHP).
- [Users and roles](./users-roles.md): sign-in per role, what an editor and an author may change. No
  journey yet: drive it from the file's recipe.
