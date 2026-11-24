# Edit and save a page

An editor opens a page in the admin, changes its title and a section's text, sees the change in the
live preview before saving, saves, and the public site shows the new version after the rebuild that
the save starts. Every save is one git commit by the signed-in user.

## Sub-features

- `edit-open` opens a page from the sidebar.
- `edit-field` changes a field of the page (title) and of a section (heading).
- `edit-preview` shows unsaved changes in the preview, rendered by the site's theme.
- `edit-save` saves: one commit, author is the user, message `Geändert: <title>`.
- `edit-publish` the rebuilt public page shows the saved version.

## How to get to it (user POV)

- `/admin/`, sign in, sidebar "Seiten" → the page, view "Formular" (the default).
- The same page in view "Auf der Seite" (editing on the page itself): not covered by the journey yet.
- Saving: the toolbar's "Speichern" or Ctrl+S.

## Driving it with journeys/lib.mjs

Preconditions:

- Doctor all `ok`; the page Start exists with a Text section (fixture).

- **Open.** Choose Start in the sidebar. `page.getByRole('navigation').getByRole('button', { name: /^Start/ }).click()`. The main area has `heading "Start…" [level=1]`.
- **Edit.** Fill the title. `page.getByRole('textbox', { name: 'Titel', exact: true }).fill(title)`. "Speichern (Strg+S)" becomes enabled.
- **Edit a section.** Open the section and fill its heading. `page.getByRole('group', { name: 'Abschnitte' }).getByText('Text', { exact: true }).first().click()`, then `getByRole('textbox', { name: 'Überschrift' }).fill(heading)`.
- **Preview.** `page.frameLocator('#ve-frame').getByRole('heading', { name: heading })` appears before saving.
- **Save.** `getByRole('button', { name: 'Speichern (Strg+S)' }).click()`. `role=status` says "Gespeichert. Die Website wird neu erstellt." and the toolbar "Alles gespeichert".
- **Proof.** `git log -1` in the run's site: one new commit by `Ada <admin@verify.test>` changing `content/pages/index.json`; `GET /` (poll up to 20 s) holds the new `<h1>` and heading. Run: `node journeys/edit-page.mjs "$RUN"`.

## Gotchas

- The rebuild runs after the save returns: poll the public page, do not read it once.
- The title textbox needs `exact: true`: the SEO field "Titel im Browser und in Suchmaschinen" also matches "Titel".
- The journey leaves its change committed (that is the proof); the next run starts from the new title,
  so it matches the page by prefix.
- The admin answers `401 /api/werft/me` and `400 …/access_token` before sign-in; expected.
