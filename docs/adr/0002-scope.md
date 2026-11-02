---
title: "ADR-0002: Sync scope"
status: "Accepted; decision 4 amended by ADR-0005"
date: 2026-10-12
---

# ADR-0002: Sync scope

## Context

A project wants some of its Confluence pages in its git repo, versioned next to the code and readable by agents. Atlassian sites are usually shared by many teams, so a sync must never read beyond the project's own area. API tokens carry the user's full permissions, so the tool itself has to enforce that limit.

## Decision

1. **Allowlist of scope roots.** The sync only touches content that is a scope root, or a descendant of one. Roots are listed under `roots:` in the project's `confluence.yaml`. A root may be a page or a folder.
2. **Roots are identified by content ID, not title.** Titles get renamed and duplicated across spaces; IDs are stable. An entry may also record `space` and `title` for people to read, but only `id` is used.
3. **Ancestry is verified before anything is written.** Discovery walks the descendant tree of each root, then cross-checks it against one CQL query (`ancestor = <r1> OR ancestor = <r2> ...`). If the two sets differ in any way, the run stops before writing a file. Single-page operations check `id = <page> AND (ancestor = <r1> OR ...)` and require exactly one hit.
4. **Read-only against Confluence.** Pulling never calls a create, update or comment operation. (Amended by ADR-0005: pushing writes, under its own rules.)
5. **No space-wide or text-search pulls.** Pages are only ever found through a root's descendant tree. Unscoped queries like `space = X` or `text ~ "..."` are never used to choose pages.
6. **Out-of-scope links stay links.** A link from an in-scope page to an out-of-scope page is kept as an absolute Confluence URL and is not followed.
7. **Exclusions.** `exclude:` lists pages under a root that are never pulled or pushed, with everything under them.
8. **Changing scope is a reviewed change.** Adding a root means editing `confluence.yaml` in a pull request, reviewed like code. The config reader rejects unknown keys, so a typo cannot silently widen scope.

## Consequences

- Each run makes one extra CQL query. That is cheap.
- Pages moved out of a root stop syncing. Their files become orphans, which pull reports instead of deleting.
- Rolling out a new project goes in stages: one page, then one root, then all roots.
