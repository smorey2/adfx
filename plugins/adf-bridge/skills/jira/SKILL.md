---
description: Pull the project's Jira issues into the repo with adf-bridge, read-only. Use it to refresh the issue mirror (a board's active sprint, one file per issue) before reading issues as context.
argument-hint: "pull"
---

Refresh this project's read-only Jira mirror with adf-bridge. How it works: https://github.com/smorey2/adf-bridge (ADR-0008).

Arguments: $ARGUMENTS

## Running adf-bridge

- Run `npx adf-bridge <command>` from the project. If `npx adf-bridge --version` fails, tell the user to add it with `npm i -D github:smorey2/adf-bridge#v0.1.0` (or the release they use), and stop.
- If there is no `jira.yaml`, ask for the Jira board URL, then run `npx adf-bridge init --board <board URL>`.
- Run `npx adf-bridge whoami`. If it says "not signed in", ask the user to run `npx adf-bridge login` in their own terminal. Never ask for the API token in chat, never put it on a command line, and never print it.

## pull

1. Run `npx adf-bridge jira pull --dry-run`.
2. Summarise: issues in scope, files new or updated, and files that would be deleted because their issues left the sprint or board.
3. Ask before running it without `--dry-run`, then report what changed and that it needs committing.

## Rules

- Jira is read-only. Never create, edit, transition or comment on issues, with adf-bridge or any other tool, unless the user asks you to do it in Jira directly.
- The mirrored files are generated: never edit them. To change an issue, change it in Jira and pull again.
- Read the files freely as context: each issue's page has its status, people, description, subtasks, links and comments, and `board.adoc` shows the active sprint by column.
