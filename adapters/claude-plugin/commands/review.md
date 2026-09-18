---
description: Independent review of the current change by a fresh CLI session (review-gate)
---
Run `npx --no-install review-gate review --worktree` (falls back to `npx review-gate` if not installed locally) and wait for it to finish.

Then act on the result:
- For each `fact` finding: verify it yourself against the code. If it is right, fix it and say what changed. If it is wrong, say why in one sentence with evidence — do not fix things that are not broken.
- `taste` findings: apply only if trivial and clearly better; otherwise leave them and say so.
- If the verdict is `fail` or `unsure`, do not report the task as done until the fact findings are resolved or refuted.
- If test-integrity or red→green reported a problem, that comes first: a weakened or non-pinning test is not a passing test.
Report in this order: verdict, what you fixed, what you refuted (with evidence), what remains.
