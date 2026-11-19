# Working on werft

## Profile
- Purpose: the shared core (build, theme API, editor, auth gateway) that werft sites install from a git tag
- Stage: released (repository standard)
- Gate: `npm test` (CI job `gate`)
- Landing: PR, squash-merged on a green gate; agents land: yes
- Release: release-please PR; agents release: no
- Outside issues and PRs: agents triage; outside PRs merge: owner approves
- Sensitive paths: `gateway/` (sign-in, sessions, roles, GitHub credentials, gateway API),
  `admin/session.js`, `lib/publish.js` and `adapters/` (signed publishing, host entry points),
  `bin/werft.js`, `lib/index.js` and `lib/node.js` (CLI, theme API, `werft/node`),
  `package.json` and `package-lock.json` (exports, engines, dependencies), `scripts/release.js`
  (pushes to the sites), `.github/`, `release-please-config.json`,
  `.release-please-manifest.json`, `.githooks/`, `.agents/`, `AGENTS.md`, and `README.md` or
  `CONTRIBUTING.md` changes to setup, hosting or contribution rules

Deliberate rules beyond the standard, kept on purpose: every change is general and hosting stays
where it runs today (Cloudflare Pages free plan, Node 22 or newer, PHP web space), see "Every change
is general"; contributions come as fork-and-PR with a test for every contract or fix, see
[CONTRIBUTING.md](CONTRIBUTING.md).

werft is the shared core of many websites. Read [README.md](README.md) before changing it.

## Landing a change
- Branch `<type>/<slug>` from `main` (`<type>/<issue>-<slug>` for an issue), one concern per pull
  request, title in Conventional Commits (`feat`, `fix`, `docs`, `ci`, …; `!` and a
  `BREAKING CHANGE:` footer for a breaking change). The body states the intent, the changed
  behaviour, the rules here it touches, the evidence it works, whether a sensitive path changed,
  and `Fixes #n` where it applies; it becomes the squash commit.
- Enable the hooks once per checkout: `git config core.hooksPath .githooks` (`.agents/setup` does it
  in orbs). `.githooks/pre-push` runs `npm test` and refuses a direct push to `main`.
- Merge with `--squash --delete-branch`.
- Changes to a sensitive path (see the profile), the public interface (package exports, CLI,
  gateway API, theme API), security code, CI or release configuration get an independent review
  (another agent or the owner) before merge. The review reads the diff against the rules here and
  is recorded on the pull request against the reviewed head commit; a later push needs a new one.
- Never run `npm run update-sites` (it opens and merges pull requests in the sites' repositories,
  which deploys them) or merge a release pull request; both are the maintainers'.
- Focused test: `node --test test/gateway.test.js`, or
  `node --test --test-name-pattern "<test name>" test/*.test.js`.

## Every change is general
- A change to werft must be useful to any werft site, not only to the site that needed it. It
  never names a particular site, client, domain, text or design.
- What differs between sites comes from the site: its content, its theme (blocks, fields,
  `formFields`, `postType`, …) or `werft.config.js`. werft gains only the general mechanism a theme
  or site needs. A site's look and its own blocks stay in that site's theme.
- Example: a site needed a newsletter sign-up. werft did not get a newsletter feature; it got form
  submissions for every form in `content/forms/`, read in the editor under "Einsendungen".
- Keep werft running where it runs today: Cloudflare Pages on the free plan, Node 22 or newer, and
  PHP web space through `werft publish`. The gateway uses only the Fetch API and Web Crypto.
- Texts in the editor are plain German for people who are not technical.
