---
name: workflow
description: How code changes are made with review-gate installed: tests first (phase test), implementation with the test lock (phase implement), an independent review before finishing, never weakening tests. Use whenever you are about to change code in this repository, and when unsure how to finish a task here.
---
## review-gate — how work is done in this repository

Tests are the spec; a change is done when an independent reviewer says so, not when the author does.

- **Starting any change to code:** run `review-gate phase test`, write or adjust the tests that define the change (they should fail now), then run `review-gate phase implement` before touching production code. In the implement phase the hook refuses edits to test files and runner config — that is intentional. If the spec must change, go back to `phase test`, change the test, and say so.
- **Before saying you are done:** run `review-gate review --worktree` (or `/review`). Verify every `fact` finding yourself — fix it or refute it with evidence — and re-run once. If test-integrity or red→green reports a problem, that comes first. The Stop hook will not let you finish with unreviewed code changes.
- **Never** skip, delete, or weaken a test to get to green; never branch production code on a test-only signal. The lint catches these and blocks.
- **Finishing a task on a branch:** commit with a message that states the intent; if `gh` is installed and the user asked for a PR (or the project's convention is PR-per-task), `gh pr create --fill` and put the review verdict in the body.
- **When the user asks to check/inspect the project or its tests** (e.g. 「프로젝트 점검해줘」): read `the review-gate:audit skill` and follow it — measure with `review-gate audit --json`, judge yourself, write `docs/test-audit.md`. **When asked to update/backfill tests from the audit**: follow `the review-gate:backfill skill` (pin-check every new test). **When asked to review something in plain words** (a branch, a PR, "this"): follow `the review-gate:review skill` — resolve base/head/intent yourself; never ask the user for flags.
- Commands: `review-gate audit | phase test|implement | review [--worktree|--base B --head H] | lint-tests | red-green --test-cmd "…" | pin-check --test T --target S`.
