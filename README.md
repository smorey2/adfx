# adfx

**ADFX for Claude Code: sync Jira and Confluence with git.**

adfx keeps Confluence pages in your repo as AsciiDoc, next to your code, and pushes your edits back without losing what Confluence stores but text cannot show: inline comments, macro settings, cell colours, layouts, mentions. It is a plain command-line tool, so it works with or without Claude, on Windows, macOS and Linux.

- **Pull** in-scope pages into `docs/confluence/` as `.adoc` files, with their images.
- **Push** your edits back. Only the blocks you changed are rebuilt; every other block is copied from the live page byte for byte.
- **Safe by default.** Only pages under the roots you list are ever touched. Push is a dry run until you add `--apply`, and refuses edits it cannot carry back exactly.

- **Create** pages from your project's templates.
- **Mirror Jira, read-only:** a board's active sprint, one file per issue plus a board page.
- **Claude Code plugin:** `/adfx:confluence pull | push | new | check` shows the dry run and only writes after you confirm in chat; `/adfx:jira pull` refreshes the issue mirror.

## Install

You need [Node.js](https://nodejs.org) 22 or later. In your project:

```bash
npm i -D adfx2
```

The npm package is `adfx2` because npm refuses the name `adfx`; the command it installs is `adfx`.

To try it without installing, run `npx adfx2 init`. To pin a git tag instead of the npm release, use `npm i -D github:smorey2/adfx#v0.1.0`.

### Claude Code plugin

In Claude Code:

```
/plugin marketplace add smorey2/adfx
/plugin install adfx@adfx
```

Then use `/adfx:confluence pull`, `push`, `new` or `check`. The plugin runs the CLI installed in your project, so install that too.

To set it up for everyone working in a repo, commit this to the repo's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "adfx": { "source": { "source": "github", "repo": "smorey2/adfx" } }
  },
  "enabledPlugins": { "adfx@adfx": true }
}
```

## Quick start

In your project folder. Run it as `npx --no-install adfx`, so only your project's copy runs and nothing is downloaded from npm:

```bash
npx --no-install adfx init --root https://your-site.atlassian.net/wiki/spaces/DOCS/pages/123456/Handbook
npx --no-install adfx login
npx --no-install adfx confluence pull --dry-run
npx --no-install adfx confluence pull
```

1. `init` writes `confluence.yaml` with that page as the root: it and everything under it is in scope. It also makes `.adoc` files use LF line endings in git.
2. `login` asks for your Atlassian email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens), checks them, and saves them for your user only, never in the repo.
3. `pull` writes the pages to `docs/confluence/`. Commit them.

## Editing and pushing

Edit a `.adoc` file, then:

```bash
npx --no-install adfx confluence push
```

The dry run shows, for each edited page, the AsciiDoc diff, the exact Confluence changes, anything that would be lost, and anything refused. When it looks right:

```bash
npx --no-install adfx confluence push --apply --message "Fix the return steps"
```

The file is pulled again at the new version. Commit it.

Push refuses, and says so, when:

- Confluence changed since your pull: pull into a temporary folder, merge, and push again;
- an edit cannot be carried back exactly: new macros, edited macro placeholders, nested tables, new images, mentions of people not already on the page. Make those in Confluence.

Editing text that has an inline comment detaches the comment. The dry run lists it under "will be lost", and pushing needs `--accept-loss`.

## New pages

```bash
npx --no-install adfx confluence new "Release Process" --parent <parent page URL> --template process
```

This writes a draft `.adoc` under the parent's folder, from the template. Fill it in, then push it: the dry run shows `create "Release Process" under "<parent>"`, and `--apply` creates the page. A new page can include a table of contents (`toc::[]`); add other macros in Confluence afterwards. See [ADR-0007](docs/adr/0007-templates-and-new-pages.md).

Templates are your project's own `.adoc` skeletons, listed in `confluence.yaml`. Sections, audience labels and layout are up to you.

## Jira

```bash
npx --no-install adfx init --board https://your-site.atlassian.net/jira/software/c/projects/ABC/boards/42
npx --no-install adfx jira pull --dry-run
npx --no-install adfx jira pull
```

This writes `jira.yaml`, then pulls the board's active sprint into `docs/jira/`: one page per issue (status, people, description, subtasks, links, comments) and `ABC/board.adoc` with the sprint by column. It is read-only, and the files are regenerated on every pull, so do not edit them. When the sprint closes, files for issues that left it are deleted; git keeps them.

```yaml
site: your-site.atlassian.net
out: docs/jira
boards:
  - id: "42"
    sprints: active            # the active sprint(s); boards without sprints: everything not done
projects:                      # optional: more issues, always limited to that project
  - key: CORE
    jql: statusCategory != Done
include: [description, comments, subtasks, links]
```

See [ADR-0008](docs/adr/0008-jira-read-only-mirror.md).

## Commands

Run these as `npx --no-install adfx …`.

| Command | What it does |
|---|---|
| `adfx init --root <page URL>` | Write `confluence.yaml` and `.gitattributes` |
| `adfx login` / `logout` / `whoami` | Save, remove or show your credentials (never the token) |
| `adfx confluence pull [--dry-run] [--page <id or URL>]` | Pull in-scope pages; never overwrites local edits |
| `adfx confluence push [files] [--page …] [--apply] [--accept-loss] [--message …]` | Dry run, or write with `--apply` |
| `adfx confluence new "<title>" --parent <page> [--template <name>]` | Write a draft for a new page; its first push creates it |
| `adfx confluence check` | Which blocks can be rebuilt exactly (the rest are pull-only) |
| `adfx confluence info` | Show the site, mirror, scope, wording rules and templates |
| `adfx confluence replace --map <file.json> [--apply]` | Replace exact table-cell values, e.g. real example data with fake |
| `adfx init --board <board URL>` | Write `jira.yaml` |
| `adfx jira pull [--dry-run]` | Pull the Jira issues `jira.yaml` names (read-only) |

Every command takes `--config <file>` and `--fixtures <file>` (read a JSON snapshot instead of the API). Run `adfx help` for the full list.

## confluence.yaml

```yaml
site: your-site.atlassian.net
out: docs/confluence                 # mirror folder, relative to this file
message: Published with adfx   # default version comment
roots:                               # synced with everything under them
  - id: "123456"
    title: Handbook                  # for people; only id is used
    type: page                       # page | folder
exclude:                             # never pulled or pushed
  - id: "234567"
main:
  wording:                           # rules agents follow on every page
    - Spell out contractions; "cannot" is one word.
    - "American spelling: canceled, canceling."
templates:                           # page skeletons for "confluence new"
  process: docs/confluence/_templates/process.adoc
```

Values are always read as text, and unknown keys are errors, so a typo cannot quietly change what gets synced. Changing `roots` should go through code review.

## Credentials

`adfx login` saves your email and token in `%APPDATA%\adfx\credentials.json` on Windows, or `~/.config/adfx/credentials.json` elsewhere, readable only by you. For CI, set `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` instead; environment variables always win. The older `CONFLUENCE_EMAIL` and `CONFLUENCE_API_TOKEN` also work.

## How it works

- [ADR-0002](docs/adr/0002-scope.md): what is in scope, and how that is enforced.
- [ADR-0005](docs/adr/0005-asciidoc-round-trip.md): the AsciiDoc format, the ADF mapping, and how push patches pages.
- [ADR-0006](docs/adr/0006-distribution-config-credentials.md): distribution, config and credentials.
- [ADR-0007](docs/adr/0007-templates-and-new-pages.md): page templates and creating pages.
- [ADR-0008](docs/adr/0008-jira-read-only-mirror.md): the read-only Jira mirror.

## Development

```bash
git clone https://github.com/smorey2/adfx && cd adfx
npm install
npm test
npm run typecheck
npm run dev -- confluence pull --dry-run
```

The source is TypeScript and runs directly on Node; there is no build while developing. `npm run release <version>` type-checks, tests, builds `dist/`, commits it and tags the release. `dist/` only changes in release commits.

## License

MIT
