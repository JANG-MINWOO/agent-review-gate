---
name: review
description: Independent review by a fresh CLI session — of the current work, a branch, or a PR. Say what to review in plain words. Use when the user asks to review something — the current work, a branch, a PR — in plain words.
---
Review request: "$ARGUMENTS"

Work out what to review — never ask the user for flags or file names:
- No arguments → the uncommitted working tree: `review-gate review --worktree`.
- A branch name → `review-gate review --base <merge-base with main/master> --head <branch>` (resolve the exact branch with `git branch --list`; if the user's spelling matches nothing, show the closest branch names and ask).
- "PR N" → `gh pr view N --json baseRefName,headRefName,body` if `gh` is available; base = baseRefName, head = headRefName, intent = the PR body. Without `gh`, ask for the branch.
- A description of the intent (what the change is supposed to do) → write it to a temp file and pass `--intent <file>`; otherwise the intent comes from commit messages automatically.
If a test command is configured, add `--test-cmd "<cmd>"` so red→green runs too.

Then act on the result:
- Each `fact` finding: verify it against the code yourself. Right → fix it and say what changed. Wrong → say why in one sentence with evidence. Do not fix what is not broken.
- `taste` findings: apply only if trivial and clearly better; otherwise leave them and say so.
- test-integrity or red→green problems come first — a weakened or non-pinning test is not a passing test.
- After fixing fact findings, run the review again **once** — two rounds at most. Stop when it passes, when the remaining findings are ones you refuted with evidence, or after the second round regardless (list what remains). An `unsure` that only says the reviewer could not run something is not a reason for another round: run it yourself and report the result.
Report: verdict, what you fixed, what you refuted (with evidence), what remains. The ledger is `.review-gate/reviews.jsonl`.
