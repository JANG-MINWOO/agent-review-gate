Codex adapter: `review-gate init --codex` copies SKILL.md to `.codex/review-gate.md`. Codex hook support differs by
version — if your `codex` has `hooks.json` (check `codex --help`), add the same two entries as adapters/claude-plugin/hooks/hooks.json
(PreToolUse → `guard-tests`, Stop → `on-stop`); otherwise rely on the skill text and CI.
