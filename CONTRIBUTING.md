# Contributing to werft

Thank you for helping. werft is the shared core of many websites, so every change has to be useful
to any werft site, not only to the one that needed it. The rules for changes are in
[AGENTS.md](AGENTS.md); read "Every change is general" before you start.

## Before you start

- Small fixes (a bug, a typo, a missing test) are welcome directly as a pull request.
- Larger changes (a new feature, a new field type, a change to the theme API, the gateway API or
  the CLI) start with an issue, so we can agree on the general mechanism first.
- Security problems: do not open an issue; see [SECURITY.md](SECURITY.md).

## Making the change

1. Fork the repository and branch from `main`.
2. Make one change per pull request. A new contract gets a test through the public interface; a fix
   gets a test that fails without it. Update the README where behaviour or setup changes.
3. Run the gate: `npm ci && npm test` (Node 22 or newer; the publish tests also need `php` and
   skip without it). A single test file: `node --test test/gateway.test.js`.
4. Open a pull request against `main`. Its title follows
   [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), e.g.
   `fix(gateway): keep the session after a password change`; the description says what it solves,
   how you verified it and `Fixes #n` if it closes an issue.

Do not change the version or tag a release: release-please's release pull request does that.

GitHub Actions runs `npm test` in the job `gate` on every pull request; a first-time contributor's
run starts once a maintainer approves it. Pull requests are squash-merged once `gate` is green and a
maintainer has approved them; you stay the author and are credited in the changelog.

## Response times

New issues and pull requests are triaged within 7 days. An issue waiting for your answer
(`needs-info`) closes after 30 days without a reply; answering reopens it.

## Licence

Contributions are licensed under the repository's [MIT licence](LICENSE). There is no CLA.
