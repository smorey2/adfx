---
description: Sync the project's Confluence mirror with adf-bridge. Pull pages into the repo as AsciiDoc, push edited .adoc files back to Confluence, create a new page from a project template, or check which blocks can be pushed.
argument-hint: "pull|push|new|check [page URL, page ID, .adoc file, or new page title]"
---

Sync this project's Confluence mirror with adf-bridge. How it works: https://github.com/smorey2/adf-bridge (ADR-0005 for push, ADR-0007 for new pages).

Arguments: $ARGUMENTS

The first word is the action: `pull`, `push`, `new` or `check`. If it is missing, ask which one. The rest is an optional target: a page URL or ID (pass it as `--page <it>`), an `.adoc` path (push and check), or a title (new).

## Running adf-bridge

- In this skill, `adf-bridge` means `npx --no-install adf-bridge`, run from the project. `--no-install` makes sure the copy pinned in the project runs, never a download. If `npx --no-install adf-bridge --version` fails, it is not installed: tell the user to add it with `npm i -D github:smorey2/adf-bridge#v0.1.0` (or the release they use), and stop.
- If there is no `confluence.yaml`, ask for the Confluence page whose tree the project should sync, then run `adf-bridge init --root <page URL>`.
- Run `adf-bridge whoami`. If it says "not signed in", ask the user to run `npx adf-bridge login` in their own terminal and tell you when it is done. Never ask for the API token in chat, never put it on a command line, and never print it.
- Run `adf-bridge confluence info` once per session. It lists the mirror folder, the scope, the project's **wording rules** and its **templates**. Follow the wording rules whenever you write page text.

## pull (Confluence → repo)

1. Run `adf-bridge confluence pull --dry-run`, plus the target.
2. Summarise: pages new or updated, conflicts, local edits, unsupported macros, images not attached, orphans. Stop if the scope cross-check failed.
3. Ask before running it again without `--dry-run`, then report what was written and that it needs committing.

## push (repo → Confluence)

1. Run `adf-bridge confluence push`, plus the target. It is a dry run. Without a target it covers every file with local edits, and every new-page draft.
2. Summarise each page: blocks changed, added and removed; the "Confluence changes" lines; anything under "will be lost"; pages it would create; and every REFUSED or CONFLICT line, with what to do about it. Refused changes have to be made in Confluence. For a conflict, pull into a temporary folder (`--out`), merge, then push again. Stop if no page is ready.
3. List exactly which pages will be written or created, and ask the user to confirm. Only after a clear yes in chat, run the same command with `--apply`. Add `--accept-loss` only if the user explicitly accepted the listed losses. One confirmation covers one run; ask again for the next push.
4. Report the new versions and created pages. Pushed files are pulled again automatically; say that they need committing.

## new (create a page)

1. You need a title, a parent page (URL or ID, inside the scope) and a template. Offer the templates from `confluence info`; if the project has none, the page starts empty.
2. Run `adf-bridge confluence new "<title>" --parent <parent> --template <name>`. It writes a draft `.adoc` and prints its path.
3. Fill in the draft with what the user asked for, keeping the template's sections and following the wording rules. Do not edit the `:confluence-…:` header lines.
4. Push it as above. The dry run shows `create "<title>" under "<parent>"`; after the user confirms, `--apply` creates the page and the file becomes a normal mirror file. A new page can include a table of contents (`toc::[]`); other macros are added in Confluence afterwards.

## check

Run `adf-bridge confluence check`, plus the target. Report the pages and blocks that cannot be rebuilt exactly; those are pull-only until the converter handles them.

## Rules

- Only pages under the `confluence.yaml` roots. adf-bridge checks scope; never work around a scope refusal, and never edit `roots` or `exclude` without the user asking.
- Write to Confluence only through `adf-bridge confluence push --apply`, as above. Never use other tools (MCP connectors, REST calls) to create or change pages or comments.
- Editing the text of `.adoc` files is what push is for. Never hand-edit the header attributes, and never edit pulled files to "fix" conversion output.
