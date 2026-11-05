---
description: Pull the project's Jira issues into the repo with adfx, read-only. Use it to refresh the issue mirror (a board's active sprint, one file per issue) before reading issues as context.
argument-hint: "pull"
---

Refresh this project's read-only Jira mirror with adfx. How it works: https://github.com/smorey2/adfx (ADR-0008).

Arguments: $ARGUMENTS

## Running adfx

- In this skill, `adfx` means `npx --no-install adfx`, run from the project. `--no-install` makes sure the copy pinned in the project runs, never a download. If `npx --no-install adfx --version` fails, tell the user to add it with `npm i -D adfx2`, and stop.
- If there is no `jira.yaml`, ask for the Jira board URL, then run `adfx init --board <board URL>`.
- Run `adfx whoami`. If it says "not signed in", ask the user to run `npx --no-install adfx login` in their own terminal. Never ask for the API token in chat, never put it on a command line, and never print it.

## pull

1. Run `adfx jira pull --dry-run`.
2. Summarise: issues in scope, files new or updated, and files that would be deleted because their issues left the sprint or board.
3. Ask before running it without `--dry-run`, then report what changed and that it needs committing.

## Rules

- Jira is read-only. Never create, edit, transition or comment on issues, with adfx or any other tool, unless the user asks you to do it in Jira directly.
- The mirrored files are generated: never edit them. To change an issue, change it in Jira and pull again.
- Read the files freely as context: each issue's page has its status, people, description, subtasks, links and comments, and `board.adoc` shows the active sprint by column.
