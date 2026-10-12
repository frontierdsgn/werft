# Choice of the base CMS

Evaluated on 2026-10-12 against these requirements: content stays in the client's GitHub repository;
runs on Cloudflare Pages' free plan, on PHP web space (IONOS) and on the client's own server;
editors log in at `/admin` without a GitHub account; WordPress's editor features (roles, drafts,
scheduling, preview, media with alt text, menus, settings, SEO, revisions with restore, forms,
redirects); open source. Versions and licences come from `npm view`, the GitHub API and each
project's documentation, fetched on that day; "unverified" means no fetched source confirmed it.

| CMS | Licence | Content in git | Runs on CF Pages free | PHP web space | Login without GitHub | Roles | Drafts / review | Scheduling | Preview | Revisions with restore | Version |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Sveltia** | MIT | yes | yes (static app) | yes (static) | no: GitHub/GitLab/Gitea/Forgejo account or token | no (roadmap) | editorial workflow | no (roadmap) | preview pane, custom templates | history only (restore on roadmap) | 0.235.0 |
| Decap | MIT | yes | yes (static app) | yes (static) | only via Git Gateway (deprecated by Netlify) or paid Decap Turbo | paid Turbo add-on | editorial workflow | no (issue #263 open) | preview pane | no | 3.16.3 |
| Pages CMS | MIT | yes (GitHub only) | unverified | static site only | e-mail code for collaborators | no | no | no | no | no | 2.1.8 |
| TinaCMS | Apache-2.0 | yes | static site + TinaCloud | static site + TinaCloud | TinaCloud accounts | 2 on free plan | paid tier | no | visual editing (React) | unverified | 3.14.4 |
| Keystatic | MIT | yes | via framework adapter (likely) | no | GitHub, or Keystatic Cloud (3 users free) | no | branches | no | preview URL | no | 0.6.9 |
| Payload | MIT | no (database) | no (paid Workers) | no | yes | yes | yes | yes | live preview | yes | 3.90.2 |
| Directus | source-available (MSCL) | no (database) | no | no | yes | yes | versions | unverified | live preview | yes | 12.5.0 |
| Strapi | MIT core, paid parts | no (database) | no | no | yes | yes | yes | paid | paid | paid | 5.57.0 |
| Grav | MIT | flat files | no | **yes** | yes | yes | unverified | `publish_date` | Editor Pro | paid plugin | 2.2.6 |
| Statamic | proprietary (Pro paid per site) | flat files | static export only | yes (PHP 8.3 + Composer) | yes | Pro only | Pro only | yes | live preview | Pro only | 6.35.1 |
| EmDash (Cloudflare) | MIT | no (D1/SQLite) | yes, without plugin sandbox | no | yes | WordPress roles | yes | yes | yes | yes | 1.2.0 |

## Decision

**Sveltia CMS as the editor, unmodified, plus werft.** No candidate meets the requirements alone:

- The git-based editors (Sveltia, Decap, Pages CMS, Keystatic) keep content in the repository and
  run anywhere static files do, but none offers logins without a git account together with roles,
  scheduling and revision restore on a free, self-hosted setup.
- The complete CMSs (Payload, Directus, Strapi, EmDash) keep content in a database and do not run
  on PHP web space; Payload, Directus and Strapi need a Node server with a database.
- Grav and Statamic run on IONOS but not on Cloudflare Pages; Statamic's roles, drafts and
  revisions need a paid licence per site.

Sveltia is the most complete and most active of the git-based editors (release on 2026-10-11) and
can talk to Gitea. werft's gateway emulates that Gitea API, which closes Sveltia's gaps without
forking it: own logins and WordPress roles, scheduling, revision restore, and a preview rendered by
the site's own theme. Forms and redirects are werft content types. If Sveltia ships its planned
v1.0 user management, the gateway's login part could be dropped.

Alternatives for the owner to weigh: EmDash, if content in a Cloudflare D1 database instead of git
is acceptable and IONOS is not needed; Grav, if PHP hosting is the priority and Cloudflare is not.
