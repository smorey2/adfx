---
title: "ADR-0007: Page templates and creating pages"
status: Accepted
date: 2026-11-02
amends: ADR-0005 (§4.4, no page creation)
---

# ADR-0007: Page templates and creating pages

## Context

Teams write the same kinds of pages again and again (a process, a batch job, an integration), each with its own sections, audience labels and layout. Those conventions belong to each project, not to this tool. Until now pages had to be created in Confluence and then pulled, so an agent could not take a request from "write a page about X" to a real page.

## Decision

1. **Templates are project files.** `templates:` in `confluence.yaml` maps a name to an `.adoc` skeleton, conventionally in `<mirror>/_templates/`. A skeleton is ordinary AsciiDoc in the mirror's dialect (ADR-0005 §2). An optional `= Title` header in it is ignored, except `:confluence-heading-offset:`, which carries over. `_templates/` is never treated as mirrored pages.
2. **`confluence new "<title>" --parent <page>` writes a draft.** The draft lives where the page will be mirrored (under its parent's folder) and has `:confluence-parent:`, `:confluence-space:` and `:scope-root:`, but no `:confluence-id:`. The parent must be in scope, and a sibling with the same title is refused.
3. **The first push creates the page.** `confluence push` lists drafts with the edited files; its dry run shows `create "<title>" under "<parent>"`, and `--apply` creates it (POST `/wiki/api/v2/pages`) under the same confirmation rules as any push (ADR-0005 §3).
4. **The body is built from the file alone.** There is no live page to recover hidden data from, so the rules for new blocks apply (ADR-0005 §4.7), with one addition: a new page may include a table of contents (`toc::[]`). Other macros, images and mentions are added in Confluence after the first push.
5. **No duplicates.** Right after creating the page, the file is given the new page ID at version 0, so a second push cannot create it again; the file is then pulled at the real version. If that pull fails (Confluence search can lag behind a new page), the next `confluence pull` completes it.

## Consequences

- An agent can go from a request to a page in one reviewed flow: `new`, fill in the template, push dry run, confirm, `--apply`.
- When a page gains its first child, its file moves from `<slug>.adoc` to `<slug>/index.adoc` on the next full pull (ADR-0003 layout).
- Adding more creatable macros means building their ADF from nothing; each one needs a test against a real site before it is allowed.
