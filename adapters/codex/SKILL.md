# review-gate (Codex)

Before you report a task as finished, run an independent review:

    npx --no-install review-gate review --worktree --author codex

`--author codex` makes `--reviewer auto` pick Claude when it is installed, otherwise a fresh Codex session.
Act on `fact` findings (verify, then fix or refute with evidence); `taste` findings are optional. A `fail`/`unsure`
verdict, a test-integrity hit, or a red→green failure means the task is not done.

TDD phases: `npx review-gate phase test` while writing/changing tests (the spec), `npx review-gate phase implement` while
implementing. In the implement phase test files are locked by the hook (Claude Code) — for Codex, treat it as a rule.
