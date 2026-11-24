# Form submissions

A visitor sends a form on the public site; the gateway keeps it on the branch `werft-submissions`
(not in the site's history) and sends the visitor on to `_redirect` on the site. Administrators and
editors read submissions under "Einsendungen", download them as CSV with formula-like cells
neutralised, and delete them. Only a form with `"receive": true` takes submissions.

## Sub-features

- `form-send` a plain form post is stored and redirects to `/danke/` on the site's address.
- `form-store` the submission is a file on `werft-submissions`; `main` is unchanged.
- `form-optin` a form without `receive` answers 404 and stores nothing.
- `form-read` "Einsendungen" lists it, newest first, for administrators and editors.
- `form-csv` the CSV download holds it; a cell starting with `=`, `+`, `-`, `@` gets a leading `'`.
- `form-delete` deleting removes it from every commit of `werft-submissions` (not in the journey yet).
- `form-redirect-guard` a foreign referer or `_redirect` never leads off the site (gateway tests cover it; not in the journey).

## How to get to it (user POV)

- Visitor: `/kontakt/`, form "Anfrage", "Anfrage senden".
- A script or bot: `POST /api/werft/forms/<form>` (urlencoded, `Accept: application/json` for JSON).
- Editor: `/admin/`, sidebar "Einsendungen".

## Driving it with journeys/lib.mjs

Preconditions:

- Doctor all `ok`; forms `anfrage` (`receive: true`) and `newsletter` (none) as in the fixture.

- **Send.** Open `/kontakt/`, fill `getByRole('form', { name: 'Anfrage' })` → `getByLabel('E-Mail')`, `getByLabel('Nachricht')`, click `Anfrage senden`. The browser lands on `/danke/` with `heading "Danke"`.
- **Stored.** `git ls-tree -r werft-submissions` in the run's site has `.werft/submissions/anfrage/<time>-<id>.json` with the fields; `git rev-parse main` is unchanged.
- **Opt-in.** `POST /api/werft/forms/newsletter` answers `404 {"message":"Dieses Formular gibt es nicht."}`.
- **Read.** Sign in as `editor@verify.test`, sidebar `/^Einsendungen/`: heading `Anfrage (n)` and a list item with the e-mail.
- **CSV.** `getByRole('button', { name: 'Einsendungen „Anfrage“ als CSV herunterladen' })` with `page.waitForEvent('download')`; the file has the row and `"'=HYPERLINK(…)"`.
- **Proof.** `stored-submission.json`, `newsletter-response.txt`, `anfrage.csv` and the screenshots. Run: `node journeys/form-submission.mjs "$RUN"`.

## Gotchas

- The CSV button's accessible name is its title, not "Als Tabelle herunterladen (CSV)".
- The redirect goes to the site setting `url` (the run's URL in the fixture); a fixture without it
  sends the visitor to the gateway's host, which is the same here and different on PHP web space.
- `_gotcha` filled in means "bot": success reply, nothing stored. Do not fill hidden fields.
- 60 submissions per form per hour; many repeated runs on one instance hit 429.
