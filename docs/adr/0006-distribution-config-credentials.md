---
title: "ADR-0006: Distribution, project config and credentials"
status: Accepted
date: 2026-10-24
---

# ADR-0006: Distribution, project config and credentials

## Context

The sync began as scripts inside one project's repo. Extracting it means any project, and anyone on a team, on Windows, macOS or Linux, can add it and have it work, while each project keeps its own scope and writing style.

## Decision

### 1. Distribution
- **Public and MIT licensed**, on GitHub at `smorey2/adfx`.
- **Installed from git tags, not the npm registry:** `npm i -D github:smorey2/adfx#v0.1.0`, or `npx github:smorey2/adfx init`. npm refuses the name `adfx` (too close to `add`), so the package is registered as `adfx2`; the command is still `adfx`. Commands run as `npx --no-install adfx` so a missing project copy fails instead of downloading anything.
- **A Claude Code plugin from the same repo** adds `/adfx:confluence` and `/adfx:jira`, which call the CLI installed in the project.
- **TypeScript source, erasable syntax only.** Development and tests run `src/` directly on Node's built-in type stripping, with no build. CI type-checks with `tsc` and runs the tests on Windows, macOS and Linux.
- **`dist/` is built and committed only by `npm run release <version>`,** which also tags the release. Installs and the plugin run `dist/`, so nothing is built on users' machines. Between releases, `dist/` on the main branch is the last release, by design.
- **Zero runtime dependencies.** Node 22 or later is the only requirement (contributors need a Node version that strips types by default).

### 2. Project config
- **One file per product at the project root:** `confluence.yaml` and `jira.yaml`. Commands find the nearest one in the current folder or a parent, like git, and paths in it are relative to it.
- **A strict YAML subset.** Every scalar is a string (no implicit numbers, booleans or dates, so IDs are never mangled). Anchors, tags, block scalars and multiple documents are errors. Unknown keys are errors, so a typo cannot silently change scope (ADR-0002).
- **Project style lives with the project.** `main.wording` lists the wording rules agents follow on every page. `templates` maps names to `.adoc` page skeletons, so sections, audience labels and layout are defined by each project, not by this tool.

### 3. Credentials
- **`adfx login`** asks for the Atlassian email and API token once (the token is not echoed), checks them against the site when it knows one, and saves them per user, outside every repo: `%APPDATA%\adfx\credentials.json` on Windows, `$XDG_CONFIG_HOME/adfx/credentials.json` (default `~/.config`) elsewhere, readable only by that user. Entries are per site, with an optional default.
- **Environment variables win:** `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` (for CI), then `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN` (older setups), then the file.
- The token is never accepted as a command-line argument (it would land in shell history) and never printed. `adfx whoami` shows the email and where it came from.

## Consequences

- Upgrading a project is a tag bump.
- A user without Node cannot run it; Node is the one prerequisite.
- The YAML subset is smaller than YAML. Config files stay simple, and the error messages say what to change.
- OS keychains are not used, which keeps the tool dependency-free; the credentials file relies on per-user file permissions.
