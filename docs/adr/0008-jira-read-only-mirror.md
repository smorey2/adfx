---
title: "ADR-0008: Jira as a read-only mirror"
status: Accepted
date: 2026-11-02
---

# ADR-0008: Jira as a read-only mirror

## Context

Teams want the work in flight next to the code and docs: what is in the sprint, what each issue says, what blocks what. Agents read that context far better from files than through ad-hoc API calls. Jira's editing model (fields, workflows, transitions, permissions) is very different from a page, so two-way sync is a separate, much larger problem.

## Decision

1. **Read-only.** `jira pull` only makes GET requests. Nothing writes to Jira.
2. **`jira.yaml` names the scope**, like `confluence.yaml` (ADR-0002, ADR-0006):
   - `boards:` board IDs. The starting point is a board's **active sprint(s)**, read through the board, so the board's own filter decides which issues appear. Boards without sprints (kanban) contribute everything not done.
   - `projects:` optional project keys, each with optional JQL. The JQL is always wrapped as `project = "<KEY>" AND (<jql>)`, so it can narrow a project but never reach beyond it.
   - `include:` which sections issue pages carry: `description`, `comments`, `subtasks`, `links` (all by default).
3. **Files.** One page per issue at `<out>/<PROJECT>/<KEY>.adoc`, and one page per board at `<out>/<PROJECT>/board.adoc` listing each active sprint by board column. Issue pages hold a metadata table (type, status, priority, people, sprint, parent, labels, dates) and the chosen sections. Descriptions and comments are converted from ADF with the same converter as Confluence (ADR-0005 §2), with their headings nested under the page's sections and local IDs dropped. Links to issues in the mirror become `xref:`s; others stay URLs.
4. **Generated, never edited.** Each file has `:jira-key:` or `:jira-board:` and a `:generated:` note. A pull rewrites a file only when its text changes.
5. **Issues that leave scope are deleted.** When a sprint closes or an issue leaves the board, its file is deleted on the next pull; git history keeps it. Only files carrying `:jira-key:` or `:jira-board:` are ever deleted.

## Consequences

- The mirror always matches the board, and agents never read stale issues.
- Pull requests that touch the Jira mirror are large right after a sprint rolls over; that is expected.
- Images in descriptions link to the Jira attachment (it needs a login to view); they are not downloaded.
- Writing to Jira, if ever wanted, needs its own ADR.
