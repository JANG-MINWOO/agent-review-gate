Codex adapter: `review-gate init --codex` copies SKILL.md to `.codex/review-gate.md`. Codex hook support differs by
version — if your `codex` has `hooks.json` (check `codex --help`), add the same guard-tests (PreToolUse) and on-stop (Stop) entries as plugin/hooks.json, with `npx --no-install review-gate …` as the command
(PreToolUse → `guard-tests`, Stop → `on-stop`); otherwise rely on the skill text and CI.
