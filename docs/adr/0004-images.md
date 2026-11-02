---
title: "ADR-0004: Confluence images"
status: "Superseded by ADR-0005"
date: 2026-10-12
---

# ADR-0004: Confluence images

Kept for history; ADR-0005 §6 is the current rule.

## Context

Many operational pages depend on screenshots, and the Markdown export of ADR-0003 dropped images without a trace. The AI connector could list attachments but not download them.

## Decision

1. Every displayed image became a link at its original position, so no image was silently lost.
2. A script run with the user's own API token downloaded only the images displayed on in-scope pages, into `<page-dir>/_attachments/<pageId>/<filename>`.
3. Attachments a page does not display were not pulled.
4. Images were committed as regular git files, without Git LFS.

## Consequences

- Images live permanently in git history. If large binaries ever appear, this needs revisiting.
