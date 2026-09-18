---
description: Audit the whole project's test health and write docs/test-audit.md (run this first after installing review-gate)
argument-hint: [optional focus, e.g. "server only" or "skip e2e"]
---
You are auditing this repository's tests so that later work can rely on them. Do the measuring with the tool, the judging yourself.

1. Run `__RG__ audit --json --run-tests` and read the JSON (runner, test command, per-directory tested/total, untested source files ranked by size × exports, weak tests, CI presence, whether the test suite currently passes). If `--run-tests` takes too long or fails to start, rerun without it and say so.
2. Open the biggest untested modules and the entry points (routes, stores, services, server handlers, CLI scripts). Decide what is **core** (money, state, persistence, auth, game rules, anything the user would notice breaking) versus peripheral (styling, one-off scripts, generated code). Do not guess from file names alone — read the exports.
3. Write `docs/test-audit.md` (create `docs/` if needed) with exactly these sections:
   - **Current state** — runner, test command, suite passes?, counts (files/cases/assertions), CI runs tests?, coverage tooling present?
   - **Gaps, ranked by risk** — a table: module · why it matters · what exists today · what is missing (unit / integration / e2e) · effort (S/M/L). Core first.
   - **Weak tests** — tests with no assertions, skipped, snapshot-only, tautological: file, problem, fix.
   - **Must create or update before feature work** — the short list (≤ 10) that `/review-gate:backfill` will execute, in order.
   - **Infrastructure to add** — missing test command, CI job, coverage config, fixtures/factories, test DB or mocks that many tests will need. One line each with the exact change.
   - **Not worth testing** — what you deliberately leave out and why (keep this honest and short).
4. Print a 10-line summary in chat: pass/fail state, the top 5 gaps, and the first three things to do. Do not start writing tests in this command — that is `/review-gate:backfill`.
$ARGUMENTS
