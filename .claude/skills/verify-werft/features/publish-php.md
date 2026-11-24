# Publish to PHP web space

`werft publish` sends the built site to `adapters/php/werft-publish.php` in a web space without Node,
signed with `WERFT_PUBLISH_SECRET`: only changed files, deletions of removed ones, never the admin.
The receiver writes only files it published itself, keeps others, and refuses code, PHP
configuration and `.htaccess` lines other than werft's own.

## Sub-features

- `publish-first` the first publish writes the whole build without `admin/`, with `.htaccess` (redirects, `ErrorDocument 404`).
- `publish-incremental` a second publish without changes sends nothing.
- `publish-foreign` a file the receiver did not write stays untouched.
- `publish-refuse` a signed `put` of `x.php` gets 422 and writes nothing.
- `publish-https` `https`/`headers` in `werft.config.js` reach `.htaccess` and are accepted (not in the journey; `test/publish.test.js` covers it, a real Apache run is manual).

## How to get to it (user POV)

- `WERFT_PUBLISH_URL=… WERFT_PUBLISH_SECRET=… npx werft publish [dir]` after `werft build`, locally
  or in the site's deploy job.

## Driving it with journeys/lib.mjs

Preconditions:

- Doctor all `ok`; `php` on PATH or `WERFT_VERIFY_PHP`. The journey serves `<run>/web` with
  `php -S` on a free port and copies the receiver there with a test secret.

- **First publish.** `werft publish .` in the run's site. Exit 0; `web/kontakt/index.html` equals `_site/kontakt/index.html`; no `web/admin`; `web/.htaccess` has `ErrorDocument 404 /404.html` and `Redirect 301 /alt.html …`.
- **Again.** `werft publish .` prints `Published 0 changed and removed 0 …`.
- **Foreign file.** `web/foreign.html` still reads `not from werft`.
- **Refuse code.** A signed `{"action":"put","files":[{"path":"x.php",…}]}` answers 422; no `web/x.php`.
- **Proof.** `publish-1.json`, `publish-2.json`, `htaccess.txt`, `refused-php.txt`. Run: `node journeys/publish-php.mjs "$RUN"`.

## Gotchas

- Without PHP the journey exits 3: not verified. Report it, do not count it as passed.
- `php -S` ignores `.htaccess`: redirects, `ErrorDocument` and headers need a real Apache, which this
  journey does not start.
- The receiver refuses requests older than 5 minutes: the clock of the publisher and the server must agree.
