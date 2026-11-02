# Changelog

## Unreleased

First version, extracted from the Confluence sync scripts of the project it was built for.

- `confluence pull`, `push`, `check` and `replace`, with output identical to the original scripts.
- `confluence.yaml` replaces `scope.yml`, and adds `out`, `message`, `main.wording` and `templates`.
- `init`, `login`, `logout` and `whoami`; credentials are saved per user, with environment variables for CI.
- Page file names avoid names Windows reserves (`con`, `nul`, ...).
- An inline image with no attachment gets a placeholder instead of stopping the pull.
