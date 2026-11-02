---
title: "ADR-0003: Confluence-to-Markdown format and layout"
status: "Superseded by ADR-0005"
date: 2026-10-12
---

# ADR-0003: Confluence-to-Markdown format and layout

Kept for history. The first version of this sync, in the project adf-bridge was extracted from, exported pages as Markdown through an AI connector. ADR-0005 replaced it with AsciiDoc and a script-based engine. The layout rules below carried over.

## Context

Pulled pages need a predictable location, provenance metadata and a clear owner, so re-pulls are safe and diffs mean something.

## Decision

### Ownership
- Confluence was the source of truth and sync was one-way, Confluence to repo. (ADR-0005 adds write-back.)

### Layout (carried into ADR-0005)
- Pages live under `<mirror>/<SPACE-KEY>/`, mirroring the Confluence tree below the scope root:
  - a page with no children: `<slug>.adoc`;
  - a page with children: `<slug>/index.adoc`, with the children inside `<slug>/`;
  - containers (folders, and pages with an empty body such as many roots) produce a directory only, never a file.
- `<slug>` is the title lower-cased, with runs of other characters collapsed to `-` and trimmed. When siblings share a slug, `-<pageId>` is appended.

### Front matter and body
- Each file had YAML front matter (title, source URL, page ID, space, last-modified time, scope root) and a Markdown body from the connector's export, with light normalisation. Unconvertible macros became visible HTML comments, never silently dropped.

### Re-import
- A page was skipped when its last-modified time matched; otherwise the file was overwritten. Git history was the changelog.

## Consequences

- The export dropped expand titles, images, panel types, merged cells and status colours, and garbled nested tables. Those limits led to ADR-0005.
