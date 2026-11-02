---
title: "ADR-0005: Confluence sync as AsciiDoc with round-trip write-back"
status: Accepted
date: 2026-10-12
supersedes: ADR-0003, ADR-0004
amends: ADR-0002 (decision 4)
---

# ADR-0005: Confluence sync as AsciiDoc with round-trip write-back

## Context

The first version (ADR-0003) exported Markdown through an AI connector. It showed these limits:

- **Lossy export.** Markdown export drops expand titles, images, panel types, merged cells and status colours, and garbles nested tables.
- **No downloads or versions.** The connector could not download attachments and returned no version numbers.
- **Agent conversion is neither repeatable nor cheap.** Each agent handled edge cases slightly differently, and a full pull of about 70 pages cost over a million tokens.

We also want to **edit in the repo and write back to Confluence without losing fidelity**. Pages hold data that text formats do not show, and a write-back that loses it damages live pages:

- block IDs, which inline comments are attached to;
- Page Properties macro IDs, which feed Page Properties Report pages;
- layouts, panel types, status colours and macro settings;
- mention account IDs and media identifiers.

Only Confluence's own structure (ADF, the Atlassian Document Format) is lossless. A readable format can only round-trip if it carries identifiers, and if write-back patches the live page instead of replacing it.

Markdown cannot carry that data without HTML comments throughout the text. AsciiDoc attribute lists (`[adf=…]`) can, and AsciiDoc ignores attributes it does not recognise. AsciiDoc also has native nested tables, collapsible blocks with titles, callouts and merged cells. Some git hosts (Bitbucket Cloud) do not render AsciiDoc; GitHub and GitLab do.

## Decision

### 1. Format: AsciiDoc
- Files are `.adoc`, laid out as in ADR-0003: `<mirror>/<SPACE>/…`, slugs, `index.adoc` for pages with children, containers are a directory only.
- **The header is AsciiDoc document attributes:**

```asciidoc
= ENG: Release Process
:confluence-id: 123456789
:confluence-space: DOCS
:confluence-version: 7
:confluence-source: https://example.atlassian.net/wiki/spaces/DOCS/pages/123456789
:scope-root: 123000000
:confluence-heading-offset: 1
:confluence-sync-hash: <sha256 of the body as last pulled or published>
:toc: macro
```

- `:confluence-heading-offset:` is present only when it is not zero. Headings are shifted so the page's highest Confluence level becomes `==`, which avoids out-of-sequence warnings (most pages start at h2). Push shifts them back.
- **Block identity:** every top-level block carries `[adf=<first 8 chars of localId>]` (the full ID if two share a prefix). Top-level means direct children of the page, of layout columns, and of bodied macros, panels and expands. Blocks without a `localId` are matched by position.

### 2. ADF → AsciiDoc mapping

| ADF | AsciiDoc |
|---|---|
| heading level *n* | `=` × (*n* − offset + 1) section, id set to the Confluence anchor (`[#Goals_Purpose]`) so links resolve; `[discrete]` inside blocks |
| strong / em / code / strike / underline | `**x**` / `__x__` / ` ``x`` ` / `[.line-through]##x##` / `[.underline]##x##` (unconstrained forms, so they work mid-word) |
| text with AsciiDoc-significant characters | the token is wrapped in a passthrough, e.g. `++Order_Summary__c++`; lines that would read as block syntax are prefixed with `{empty}` |
| link; link to an in-scope page | `link:url[text]`; `xref:relative.adoc[text]` |
| bullet / ordered list | `*` / `.` nested by depth |
| table | `\|===` with `cols`, header option, `n+\|` colspan, `.n+\|` rowspan |
| nested table | `a\|` cell containing a `!===` table |
| panel | callout block; the exact type is kept, e.g. `[NOTE,panel=info]` |
| expand | `.Title` + `[%collapsible]` example block |
| code block / blockquote / rule | `[source,lang]` `----` / `____` / `'''` |
| status | `[.status-<color>]##TEXT##` |
| mention | `[.mention]##@Name##` (account ID recovered from the live page) |
| media | `image::_attachments/<pageId>/<file>[alt,width]` |
| hard break | ` +` |
| TOC macro | `toc::[adf=…]` at the macro's position, with `:toc: macro` in the header |
| Page Properties, Excerpt | open block `[confluence=details\|excerpt,adf=…]` with the content inside |
| layout section / column | content in order between comment markers: `// confluence:layout-section adf=…`, `// confluence:layout-column adf=… width=50`, `// confluence:layout-end` (comments do not render and cannot conflict with block nesting) |
| cell background colours | not shown; recovered from the live page on push (counted in the report) |
| any other macro or extension | **read-only placeholder** carrying `adf=`; push refuses edits to it |

### 3. Engine: scripts, not agents
- adf-bridge (TypeScript, zero runtime dependencies) uses the Confluence REST API with each person's own API token (ADR-0006). Tokens are never committed.
- **`confluence pull`:**
  1. Resolve scope (ADR-0002: the descendant tree, cross-checked against CQL).
  2. Fetch each page's ADF and version.
  3. Write `.adoc` files, and download displayed images into `_attachments/<pageId>/`, one file per image even if the page uses it several times.
  4. Print a report.
- **`confluence push`:** see §4.
- Agents may edit `.adoc` files, run pulls, and run push dry runs. An agent runs `push --apply` only through the `/confluence push` command, after it has shown the dry run and the user has confirmed that run in chat. It adds `--accept-loss` only when the user accepted the listed losses. Agents never write to Confluence through other tools.

### 4. Write-back (`confluence push`)
1. **Confluence remains the system of record.** Repo edits are proposals: reviewed, then pushed.
2. **Patch the page; never regenerate it.**
   - Fetch the live ADF.
   - Regenerate AsciiDoc from it, and compare that with the edited file block by block, using `adf=`.
   - Unchanged blocks are copied byte for byte from the live page.
   - Changed blocks are rebuilt, recovering nested data (cell IDs, widths, colours, mention IDs, media IDs) from the live block by position and text.
   - Anything that cannot be recovered is listed as **will be lost** and needs `--accept-loss`.
3. **Optimistic concurrency.** Push is refused unless the live version equals `:confluence-version:`. After a successful push the file is re-pulled at the new version.
4. **Scope on write.** Only pages that pass the ADR-0002 scope check. No moves or deletes. New images are not uploaded yet.
5. **Dry run by default.** It prints an AsciiDoc diff of each changed block and the exact ADF changes. Writing needs `--apply`, run by a person, or by an agent after the person confirms (§3).
6. **Fidelity gate, per block.** A live block may only be rebuilt if ADF → AsciiDoc → ADF reproduces it exactly (canonical JSON). The check runs on every block a push would rebuild; unchanged blocks are copied, so they never need it. A block that fails is pull-only, and push refuses edits to it until the converter handles it. `confluence check` runs the gate over whole pages.
7. **How blocks are matched.**
   - Each block read from the file is paired with a live block: first by `adf=` id, then by a longest common subsequence of (type, text), then by position between those pairs. The same pairing applies inside blocks: rows, cells, list items, inline nodes.
   - A paired node takes what AsciiDoc carries from the file and everything else from the live node. Hidden marks (expand widths, image borders) and inline comments are carried over; a comment survives as long as the text it is anchored to is unchanged.
   - New nodes get no local IDs (Confluence assigns them); new table cells take the widths in `cols`.
   - Refused, so they have to be made in Confluence: adding macros, editing a macro placeholder, editing or adding a nested table (its stored HTML copy cannot be kept in step), images not already on the page, and mentions of people not already on the page.
   - Title changes in the `= Title` line are pushed.

### 5. Pull/push conflict rules
- If the body hash differs from `:confluence-sync-hash:`, the file has local edits not yet pushed. Line endings are normalised first, so a Windows checkout is not an edit.
- Pull never overwrites a file with local edits. If Confluence has also changed, it reports a conflict. Resolve it by pulling into a temporary folder and merging by hand.

### 6. Images (replaces ADR-0004)
- Only images displayed on in-scope pages are downloaded, into `<page-dir>/_attachments/<pageId>/<filename>`, and committed as regular git files.
- A displayed image whose file is not attached to its own page (for example, pasted from another page) keeps a placeholder and is listed in the report. The tool never guesses.

### 7. Exclusions
- `exclude:` in `confluence.yaml` lists pages under a root that are neither pulled nor pushed (ADR-0002 decision 7).

### 8. Targeted text replacement (`confluence replace`)
- Replaces exact table-cell values on in-scope pages, for example real example data with fake data. It is a narrow write path that does not use the AsciiDoc converter.
- A text node is changed only when its whole trimmed text equals a mapped value, and only inside table cells, including nested tables. Link targets on that text (for example `mailto:`) are updated with it.
- Marks, including inline-comment annotations, are kept. The rest of the page is sent back unchanged.
- §4 rules still apply: scope check, dry run by default, `--apply`, version + 1, and a 409 response if the page changed in the meantime.
- Map files that contain real values stay out of the repo. Confluence keeps earlier versions in page history; removing old values entirely needs a space admin to delete those versions.

## Consequences

- One converter in each direction to maintain. The round-trip gate is the test suite.
- Inline comments survive edits anywhere except the text they are anchored to. Editing that text detaches the comment; the dry run lists it under "will be lost", and pushing needs `--accept-loss`.
- Re-syncs are deterministic and cost no tokens.
- ADR-0002 decision 4 (read-only) applies to pull and to agents outside `/confluence push`. Only push and replace write, and only under §4 and §8.
- In the project this tool was built for, all 1,819 top-level blocks on 65 live pages passed the gate, and simulated single-word edits on 191 random text lines and table cells each changed exactly one text node.
