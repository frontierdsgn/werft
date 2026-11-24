<profile>

- Purpose: the shared core (build, theme API, editor, auth gateway) that werft sites install from a git tag.
- Stage: released (repository standard)
- Gate: `npm test` (CI job `gate`, also the pre-push hook). Focused test: `node --test test/gateway.test.js`, or `node --test --test-name-pattern "<name>" test/*.test.js`.
- Setup: `npm ci`, then `git config core.hooksPath .githooks` once per checkout.
- Landing: PR, squash-merged on a green gate; agents land: yes
- Release: release-please PR; agents release: no
- Outside issues and PRs: agents triage; outside PRs merge: owner approves
- Sensitive paths: `gateway/`, `admin/session.js`, `lib/publish.js`, `adapters/`, `bin/werft.js`, `lib/index.js`, `lib/node.js`, `package.json`, `package-lock.json`, `scripts/release.js`, `.github/`, `release-please-config.json`, `.release-please-manifest.json`, `.githooks/`, `.agents/`, `AGENTS.md`, setup, hosting or contribution rules in `README.md` or `CONTRIBUTING.md`, and any change to the public interface (package exports, CLI, gateway API, theme API).

</profile>

<rules>

- Never run `npm run update-sites`: it opens and merges pull requests in the sites' repositories, which deploys them.
- Make every change useful to any werft site. Never name a particular site, client, domain, text or design in werft.
- What differs between sites comes from the site's content, its theme or `werft.config.js`; werft gains only the general mechanism. A site's look and own blocks stay in its theme.
- Keep werft running on Cloudflare Pages' free plan, Node 22 or newer, and PHP web space through `werft publish`. The gateway uses only the Fetch API and Web Crypto.
- Write editor texts in plain German for people who are not technical.

</rules>
