# Working on werft

werft is the shared core of many websites. Read [README.md](README.md) before changing it.

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

## Contributing from outside
- Fork the repository, branch from `main`, open a pull request against `main`. One gap or feature
  per pull request, with what it solves and how you verified it.
- `npm test` passes (GitHub Actions runs it on every pull request; a first-time contributor's run
  starts once a maintainer approves it). A new contract gets a test through the public interface; a fix gets a test
  that fails without it. Update the README where behaviour or setup changes.
- Do not change the version or tag a release: the maintainers merge and release
  (`npm run release`, see the README).
