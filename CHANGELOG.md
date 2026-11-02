# Changelog

## Unreleased

First version, extracted from the Confluence sync scripts of the project it was built for.

- `confluence pull`, `push`, `check` and `replace`, with output identical to the original scripts.
- `confluence.yaml` replaces `scope.yml`, and adds `out`, `message`, `main.wording` and `templates`.
- `init`, `login`, `logout` and `whoami`; credentials are saved per user, with environment variables for CI.
- `confluence new` writes a draft from a project template; its first push creates the page (ADR-0007).
- `confluence info` shows the scope, wording rules and templates.
- Claude Code plugin with `/adfx:confluence pull | push | new | check` and `/adfx:jira pull`.
- `jira pull`: a read-only mirror of a board's active sprint, one file per issue plus a board page, from `jira.yaml` (ADR-0008); `init --board` writes `jira.yaml`.
- Page file names avoid names Windows reserves (`con`, `nul`, ...).
- An inline image with no attachment gets a placeholder instead of stopping the pull.
