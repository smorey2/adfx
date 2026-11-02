---
title: "ADR-0001: Record architecture decisions"
status: Accepted
date: 2026-10-12
---

# ADR-0001: Record architecture decisions

## Context

How adf-bridge works, and why, needs a stable source that contributors, users and AI agents can cite.

## Decision

- Architecture decisions are recorded as Markdown files in `docs/adr/`, named `NNNN-kebab-title.md`.
- Each ADR has YAML front matter (`title`, `status`, `date`) and the sections **Context**, **Decision**, **Consequences**.
- Status is one of `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, `Deprecated`.
- Accepted ADRs are not rewritten. To change a decision, add a new ADR and mark the old one superseded.
- Agent prompts and slash commands that automate this work cite the ADRs they implement, so the ADR is the spec and the prompt is the executor.

## Consequences

- Rules that differ per project (scope roots, wording, page templates) belong in the project's config files, not in these ADRs.
- Prompts stay short; the reasoning lives here.
