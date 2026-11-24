# Users and roles

People sign in to the admin with e-mail and password. What they see and may change depends on their
role: administrators everything including users and settings, editors content and submissions,
authors and contributors their posts. The gateway enforces the same rules on every save.

## Sub-features

- `role-signin` sign-in through the admin's form; a wrong password is refused with a message.
- `role-editor` an editor sees "Einsendungen" but cannot change site settings or users.
- `role-admin-users` an administrator adds a user on "Benutzer"; the user can sign in.
- `role-signout` "Abmelden" ends the session.

## How to get to it (user POV)

- `/admin/` → "Anmelden" with E-Mail and Passwort.
- Sidebar "Benutzer" (administrators), "Mein Konto" (everyone).
- `npx werft user add|set|list|remove` in the site (CLI, commits nothing by itself).

## Driving it with journeys/lib.mjs

Preconditions:

- Doctor all `ok`; fixture users `admin@verify.test` and `editor@verify.test`.

- **Wrong password.** On `/admin/`, fill `getByLabel('E-Mail')` and `getByLabel('Passwort', { exact: true })` with a wrong password, click `Anmelden`. The form shows `role=alert` with a message; `#ve-app` stays hidden.
- **Editor.** `j.signIn(j.run.editor)`. The sidebar has `/^Einsendungen/`; `j.api('/api/werft/me', { as: j.run.editor })` reports `role: "editor"` and an `editable` list without `settings`.
- **Editor refused.** `j.api` a save of `content/settings/site.json` as the editor (`POST /api/werft/api/v1/repos/werft/site/contents`, see `test/languages.test.js` for the body) answers 403; `git log` shows no commit.
- **Admin adds a user.** As administrator open `/^Benutzer/`, add one, then sign in as that user.
- **Proof.** Screenshots of each sign-in state, `me.json` per role, the 403 body, `git log`.

## Gotchas

- No journey file exists yet: write `journeys/users-roles.mjs` from this recipe before claiming it.
- Repeated wrong passwords lock the address out for a while (throttle): use one attempt per run.
- A role with `twoFactor` in `werft.config.js` must set up two-factor first; the fixture has none.
