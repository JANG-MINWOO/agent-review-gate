# agent-review-gate

Independent code review by a **fresh CLI session** (`claude -p` or `codex exec`) plus the deterministic TDD gates that no
off-the-shelf tool ships: a **test-integrity diff lint**, a **red→green verifier**, and a **test-file lock** during implementation.
Zero dependencies. Works from a hook, from the command line, and in CI.

Why a fresh CLI process and not an API call: the reviewer must not inherit the author session's context and rationalisations.
Why not "always the other model": not everyone pays for both. `--reviewer auto` uses the *other* CLI when it is installed,
otherwise a fresh session of the same CLI. Which of the two catches more is something you measure, not assume — the ledger
records every finding so you can count later which ones were real.

## Install

```
npm i -D agent-review-gate
npx review-gate init            # .review-gate/config.json + Claude Code hooks merged into .claude/settings.json + /review command
npx review-gate init --codex    # also drop the Codex skill file
npx review-gate init --ci       # also write .github/workflows/review-gate.yml (deterministic gates block; model review opt-in)
npx review-gate probe --ask     # which reviewer CLIs are installed and answering
```

`init` is idempotent — run it again after `npm update agent-review-gate`.

## What it does

| Where | What | Blocks? |
|---|---|---|
| **PreToolUse hook** (Claude Code) | `guard-tests`: while `phase == implement`, edits to test files / runner config — including `sed -i`, `tee`, `>` in Bash — are refused with a message that says how to change the spec properly | yes |
| **Stop hook** | `on-stop`: test-integrity lint on the working tree; reminds the agent to run `/review` when tests changed. `onStop: "review"` runs the full reviewer instead | only if `block: true` |
| **`/review`** (slash command) | runs `review --worktree`, then the agent must verify each `fact` finding and fix or refute it with evidence | — |
| **CLI** `review-gate review` | packet (diff + intent + changed tests + deterministic check results) → fresh reviewer session → JSON verdict → ledger | with `--block` |
| **CI** | `lint-tests` and `red-green` block a PR; `review` is opt-in with credentials | yes |

### The reviewer's contract (`lib/rubric.md`)

Verdict first (`pass` / `fail` / `unsure`). Every finding is `fact` (verifiable: file, line, claim, evidence) or `taste`
(labelled, never blocks). "No issue" is a legitimate answer. The reviewer has read-only tools to open files and search
for duplicates. Output is one JSON object (`lib/verdict.schema.json`; passed to `codex exec --output-schema`).

### Deterministic gates

- `lint-tests` — added `skip/only/xit/xfail/todo`, deleted test files, fewer tests or assertions, tautological asserts
  (`expect(true).toBe(true)`), suppressions, `try` wrapping, runner config that narrows the run, and production code branching on
  `NODE_ENV === 'test'`-style signals. `hard` → exit 2, `soft` → exit 1.
- `red-green --test-cmd "npm test"` — in a throwaway worktree: base + *only* the test changes must **fail**, head must **pass**.
  `not-red` means the new tests already pass on the old code (they pin nothing). `no-tests` = refactor/untested change.
- `phase test|implement` — the two TDD phases. In `test` the spec (tests) is open; in `implement` it is locked by the hook.

## Usage

```
npx review-gate review                       # HEAD vs merge-base with origin/main, reviewer auto
npx review-gate review --worktree            # uncommitted work
npx review-gate review --base main --head feature --reviewer codex --model gpt-6-astra --intent task.md --test-cmd "npm test" --block
npx review-gate lint-tests --worktree
npx review-gate red-green --test-cmd "pytest -q"
```

Config (`.review-gate/config.json`, written by `init`): `reviewer`, `author`, `model`, `testCmd`, `onStop` (`checks` | `review` | `off`),
`block`, `maxDiffChars`, `codexSandbox`, `redGreenOnReview`. Environment overrides: `REVIEW_GATE_REVIEWER`, `REVIEW_GATE_AUTHOR`,
`REVIEW_GATE_MODEL`, `REVIEW_GATE_CODEX_SANDBOX`, `REVIEW_GATE_OUT`.

Ledger: `.review-gate/reviews.jsonl` (append-only, commit it). Audit trail per run in `.review-gate/runs/` (gitignored).
`--out DIR` keeps both outside the reviewed repo (pilots, CI artifacts).

## Notes

- Claude reviewer runs with `--strict-mcp-config --setting-sources project --no-session-persistence` and a read-only tool allowlist.
  Codex reviewer runs with `-s read-only` by default; some Linux hosts cannot create the bubblewrap sandbox — set
  `codexSandbox: "danger-full-access"` there (the tool resets the working tree after the run).
- Large diffs are truncated at `maxDiffChars` in the packet; the file list is always complete and the reviewer can open files.
  Review unit ≠ PR unit: for big PRs run `review` per commit range rather than splitting the PR.
- What this does **not** do: prove the combination raises code quality. Each part has evidence behind it (test hacking
  signatures, red→green as a pinning check, independent-context review); the package exists so you can measure it on your own repo.

## Development

```
npm test        # node:test on a fixture repository (lint, red→green, guard)
```

MIT.
