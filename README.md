# agent-review-gate

**Independent code review by a fresh CLI session (`claude -p` / `codex exec`) plus the deterministic TDD gates that no
off-the-shelf tool ships: a test-integrity diff lint, a red→green verifier, and a test-file lock during implementation.**
Zero dependencies. Runs from a hook, from the command line, and in CI. Works with the CLI subscription you already have.

```
npm i -D agent-review-gate && npx review-gate init
```

[한국어 요약은 아래](#한국어-요약)

---

## The problem this exists for

Coding agents write most of the code now, and the volume outruns review. Two failure modes show up in every measurement
we could find and in our own comparison runs:

1. **The author cannot review itself.** A model that just wrote a change rationalises it. Asking the same session "is this
   correct?" returns "yes" with a confident paragraph. Reviews only mean something when the reviewer has *no stake and no
   memory* of the work — a different context, ideally a different model.
2. **"Passing tests" stops meaning "correct".** Agents optimise for green. The ways they get there without doing the work
   are boringly consistent: a `.skip` here, a deleted assertion there, a test that would have passed before the change was
   made, production code that checks `NODE_ENV === 'test'`. Reading the transcript to catch this does not scale; the
   transcript is exactly what you were trying not to read.

Existing tools mostly add another prompt: "review this carefully". They are useful, but a prompt is not a gate. The gate
has to be something that *fires every time* and *cannot be argued with* — the same reason a `PreToolUse` hook that blocks
`rm -rf` beats a line in `CLAUDE.md` that says "never run rm -rf".

## What we built, and where the effort went

Three things, in order of how much they mattered:

**1. Reviewer isolation that costs nothing extra.** The reviewer is a *fresh CLI process* (`claude -p` or `codex exec`),
not an API call. It receives a *review packet* — diff, stated intent, which tests changed, results of the deterministic
checks — and read-only tools to open files and search the repo. It never sees the author's conversation. Because it is
the CLI you already pay for, there are no API keys to manage and no second vendor. `--reviewer auto` picks the *other*
CLI when both are installed (different model, different blind spots) and falls back to a fresh session of the same CLI
when only one is (no memory, no rationalisation). Which of the two catches more is something you measure on your repo
(see Evidence) — the ledger exists so that you can.

**2. Deterministic gates for the TDD loop.** These are the parts we could not find anywhere as a reusable tool:
- `lint-tests` — a diff lint for the *test-hacking signatures*: added `skip`/`only`/`xit`/`xfail`/`todo`, deleted test
  files, fewer tests or assertions than before, tautological assertions (`expect(true).toBe(true)`), suppressions added
  inside tests, `try` wrapping a test body, runner config that narrows the run (`testPathIgnorePatterns`, `--bail`,
  `passWithNoTests`…), and production code that branches on a test-only signal. `hard` findings exit 2 and block.
- `red-green` — the check that a test actually *pins* the change: in a throwaway worktree, base + **only the test
  changes** must fail; head must pass. `not-red` (the new tests already pass on the old code) is the single most common
  way "TDD" silently becomes "tests written after the fact".
- `pin-check --test T --target S` — blanks module S and runs test T: it must fail; restored, it must pass. The acceptance rule for
  backfilled characterisation tests (a test that survives its target being emptied tests nothing).
- `phase test | implement` + `guard-tests` hook — the spec (tests) is open in the test phase and **locked** in the implement
  phase. The hook blocks the editing tools *and* the usual shell bypasses (`sed -i`, `tee`, `>` into a test path). Changing
  the spec is allowed — it just has to be a visible, reviewed act (`phase test`), not a side effect of getting to green.

**3. A reviewer contract that produces signal, not noise.** The rubric (`lib/rubric.md`) demands the verdict first
(`pass` / `fail` / `unsure`), labels every finding **fact** (file, line, claim, evidence — reproducible) or **taste**
(never blocks), allows *"no issue"* as a legitimate answer, and asks for up to three things done well. The verdict is one
JSON object (`lib/verdict.schema.json`, also handed to `codex exec --output-schema`). Every review is appended to a ledger
so you can later count which findings turned out to be real — the number that decides whether a reviewer earns its cost.

Everything else — the `init` that wires hooks into `.claude/settings.json`, the `/review` command, the Codex skill, the CI
workflow, the Claude Code plugin manifest — is packaging around those three.

## Using it without memorising anything

You talk to your agent; the package supplies the rules and the tools. `init` installs three slash commands and a short
rules section into the project's `CLAUDE.md`, so plain requests work:

| You say | What happens |
|---|---|
| 「프로젝트 점검해줘」 / `/review-gate:audit` | `review-gate audit` measures the whole repo (runner, test↔source map, untested modules by size, weak tests, CI); the agent judges what is core and writes `docs/test-audit.md`: current state, gaps ranked by risk, must-do list, infrastructure to add, what not to test |
| 「점검 토대로 테스트 업데이트해줘」 / `/review-gate:backfill` | the agent writes the missing tests one module at a time; every new test must pass **and** fail when its target module is blanked (`pin-check`) — hollow tests are rejected |
| 「~해줘」 (normal feature work) | the agent switches `phase test` → writes/adjusts tests → `phase implement` (tests locked) → implements → runs the independent review → fixes or refutes findings → red→green → commits (and opens a PR with `gh` when asked) |
| 「feature/x 브랜치 리뷰해줘」 / 「PR 12 리뷰해줘」 / `/review` | the agent resolves base/head/intent itself (branch list, `gh pr view`, your words) and runs the review — no flags to type |

Two enforcement points make the rules real: the PreToolUse hook refuses test edits in the implement phase, and the Stop
hook (`onStop: "gate"`, the default) refuses to let the session finish while there are code changes newer than the last
review — the agent is told the exact command to run. `onStop: "checks"` downgrades that to a reminder; `"review"` runs the
review inline; `"off"` disables it.

## How it works

```
                 ┌──────────────── your agent session (Claude Code / Codex) ────────────────┐
  phase test  →  │ write/change tests (spec)                                                 │
  phase impl  →  │ implement — PreToolUse hook `guard-tests` refuses edits to test files      │
  stop        →  │ Stop hook `on-stop`: lint-tests on the working tree, "run /review"          │
                 └───────────────────────────────┬──────────────────────────────────────────┘
                                                 │ /review  or  npx review-gate review
                                                 ▼
   review packet = diff + intent + changed tests + { lint-tests, red-green } results
                                                 │
                 ┌───────────────────────────────▼──────────────────────────────────────────┐
                 │ FRESH PROCESS: claude -p (read-only tools) | codex exec --output-schema   │
                 │ rubric: verdict first · fact/taste · evidence · "no issue" is an answer   │
                 └───────────────────────────────┬──────────────────────────────────────────┘
                                                 ▼
   verdict JSON → .review-gate/reviews.jsonl (ledger) + runs/<ts>-<sha>/{packet.md, raw.txt, verdict.json}
   exit 0 (pass/unsure) · exit 2 (fail / hard lint / not-red|not-green) when --block or config.block
```

**The reviewer process is sealed off from the author's project context.** It is started with `--setting-sources user` (your own
user settings — auth, proxy, model defaults — but no project settings, hooks, slash commands or CLAUDE.md; verified: with `project`
sources the reviewer read the repository's own review-gate rules, tried to "run the review before finishing" and hit the Stop gate
itself) and with `REVIEW_GATE_ROLE=reviewer`, which makes the guard and Stop hooks stand down if a user-level settings file wires them. It may run the project's test command (and the usual runners) but nothing else
that writes. Untracked files are part of a worktree review — a backfill of brand-new test files reaches the reviewer as creation
diffs, not as an empty packet. A reviewer whose environment failed (Codex's Linux sandbox refusing to start, for example) is
recorded as an error, never as a verdict; in `auto` mode the other CLI is tried once, otherwise the fix is printed.

**The Stop gate's fingerprint is content-based**: `git add` or a commit of already-reviewed files does not look like a new change
(it did in the first version — a session staged its reviewed tests and was sent to a third, identical review). The gate blocks at
most three times per session, then lets the session stop while saying the change is unreviewed. Fingerprints written by the first
version do not match the new format, so the first stop after upgrading may ask for one more review of work that was already reviewed.

CI runs the deterministic gates on every PR (`adapters/ci/review-gate.yml`); the model review in CI is opt-in once you
have credentials there. **Review unit ≠ PR unit**: for a large PR, run `review` per commit range instead of splitting the
PR into forty CI runs.

## Install and use

Two install routes, same code:

**A. Claude Code plugin (no npm, one command).** Inside Claude Code:

```
/plugin marketplace add JANG-MINWOO/agent-review-gate
/plugin install review-gate@agent-review-gate        # pick "project" scope to enable it for this repository only
```

then restart the session. The plugin ships four skills — `/review-gate:audit`, `/review-gate:backfill`, `/review-gate:review`,
`/review-gate:workflow` (the session rules) — and three hooks (SessionStart puts `review-gate` on the session's PATH, PreToolUse
locks tests in the implement phase, Stop gates unreviewed changes). Plain-language requests work the same way as with route B:
「프로젝트 점검해줘」, 「점검 토대로 테스트 업데이트해줘」, 「feature/x 브랜치 리뷰해줘」. Measured 2026-09-18 on a fresh clone with no
`node_modules/agent-review-gate`: `review-gate probe` answered from the session shell, and the implement-phase lock refused an Edit of
a test file with the expected message. Always-on context cost ≈ 350 tokens (`claude plugin details review-gate@agent-review-gate`).
Use route B instead if you need the nested layout (`--target`), Codex hooks, or CI.

**C. MCP server (for agents that are not Claude Code — Cursor, Codex `mcp_servers`, your own harness):**

```
claude mcp add review-gate -- npx --no-install review-gate mcp      # or any MCP client: command "npx", args ["review-gate","mcp"]
```

Tools: `review`, `lint_tests`, `red_green`, `audit`, `pin_check`, `phase` — the same code, newline-delimited JSON-RPC over stdio, no
dependencies. MCP cannot enforce anything (hooks do that); it is the door another agent calls through. Verified 2026-09-18: Claude Code
connected with `--mcp-config` and got `clean` back from `lint_tests`.

**B. npm package (also CI, Codex, nested layouts):**

```
npm i -D agent-review-gate
npx review-gate init              # .review-gate/config.json · hooks merged into .claude/settings.json · .claude/commands/review.md
npx review-gate init --codex      # + Codex skill file
npx review-gate init --ci         # + .github/workflows/review-gate.yml
npx review-gate probe --ask       # which reviewer CLIs are installed and answering

npx review-gate review                       # HEAD vs merge-base(origin/main), reviewer auto
npx review-gate review --worktree            # uncommitted work
npx review-gate review --base main --head feat --reviewer codex --model gpt-6-astra --intent task.md --test-cmd "npm test" --block
npx review-gate lint-tests --worktree
npx review-gate red-green --test-cmd "pytest -q"
npx review-gate phase implement              # lock tests; `phase test` to unlock
npx review-gate audit [--json] [--run-tests] # whole-repo test-health inventory
npx review-gate pin-check --test tests/x.test.ts --target src/x.ts
```

`init` is idempotent — run it again after `npm update agent-review-gate`. **Restart Claude Code after `init`** — hooks and slash commands are read at session start (`/hooks` should list the two review-gate entries).

**Nested layout (context repo above the code repo).** If you run Claude Code from a parent directory that holds your
notes/wiki and the code lives in a subfolder that is its own git repo (`my-context/my-app`), install the package in the
code repo and run `init` from the parent with `--target`:

```
cd my-context/my-app && npm i -D agent-review-gate
cd .. && npx --prefix my-app review-gate init --target my-app
```

Config, ledger and phase go into `my-app/.review-gate/` (the repo that is reviewed); the hooks and the `/review` command go
into `my-context/.claude/` (the project Claude Code actually reads), with `--repo my-app` baked into every command. The
test lock then applies to `my-app`'s tests and leaves the context repo's own files alone. Running Claude Code inside
`my-app` directly? Run a plain `npx review-gate init` there as well — both can coexist. Config lives in `.review-gate/config.json`
(`reviewer`, `author`, `model`, `testCmd`, `onStop`: `checks` | `review` | `off`, `block`, `maxDiffChars`, `codexSandbox`,
`redGreenOnReview`); environment overrides `REVIEW_GATE_REVIEWER|AUTHOR|MODEL|CODEX_SANDBOX|OUT`. `--out DIR` keeps the
ledger and run artefacts outside the reviewed repo (pilots, CI artefacts).

Claude Code plugin form: `adapters/claude-plugin/` carries the manifest, `/review` command and hook file for marketplace
installation. MCP form (the same three operations exposed as tools for any MCP-capable agent) is planned; hooks and CLI
are the parts that *enforce*, MCP is a door for agents to *ask*.

## How this differs from what already exists

We surveyed the landscape before writing a line (Claude Code's built-in `/code-review`, the managed Claude Code Review,
Codex `/review`, GitHub Copilot review, Cursor Bugbot, CodeRabbit/Greptile-class products, the `superpowers` and
`mattpocock/skills` review skills, `pr-review-toolkit`, `claude-security`, TDD Guard / Probity, pre-commit-style linters).
Short version of what we found and what this does differently:

| | Most review tools / skills | agent-review-gate |
|---|---|---|
| Who reviews | the same session, or a vendor's hosted agent | a **fresh CLI process** with only the packet; other model if you have it, same model / new session if not |
| Cost & keys | API keys or a per-seat product | the CLI subscription you already use; zero dependencies |
| Enforcement | a prompt ("review carefully"); the official tools state they *do not block merges* | hooks block test edits in the implement phase; `lint-tests`/`red-green` exit non-zero in CI |
| Test hacking | not checked (TDD Guard's default rules even allow deleting tests) | 13 diff signatures + red→green pinning check, deterministic |
| Output | prose; often a list of nits to look thorough | verdict first, fact vs taste, evidence per finding, "no issue" allowed, ≤3 "good" |
| Learning | thumbs-up/down inside a product | an append-only ledger you own, so hit rates can be computed per reviewer/model |
| Vendor scope | one tool's ecosystem | Claude Code and Codex today; MCP planned |

Things others do that we deliberately did **not** replicate: multi-pass voting (Cursor Bugbot's 8 passes; `claude-security`'s
3-voter FALSE_POSITIVE default) — good ideas for a security-only scan, too expensive as a default gate; hosted PR bots — they
solve distribution, not isolation; LLM-judged write blocking (TDD Guard/Probity) — 3–30 s per write and bypassable by shell,
so our lock is a plain path rule plus shell-bypass patterns.

## Evidence (what is and is not shown)

- Each part rests on published evidence: test-hacking signatures (TDFlow's table of 13), independent-context review
  beating self-review, "silence is better than noise" (GitHub's own numbers: the agent says nothing in 29% of reviews),
  hooks over prompts for anything that must fire every time.
- **First pilot (2026-09-18, 10 agent-written branches × 2 reviewers, 2 clean controls; answer key = independent cross-reviews; findings judged by hand):**
  21 fact findings, **0 wrong** — the fact/evidence contract held; both reviewers stayed silent on the clean controls. The other-model reviewer
  found defects in 5/5 branches written by the first model but passed 4/5 branches written by its own model with zero findings (the answer key
  had defects in all four) — the "same model, same blind spots" hypothesis showed up in the sample, which is why `auto` prefers the other CLI.
  The first-model reviewer found 8 answer-key defects but said "pass" 9 times out of 10, twice with a medium-severity finding in hand — so the
  tool now forces `fail` whenever a medium/high fact finding is present. Small sample; measure on your own repo.
- **Not shown:** that the combination raises code quality on your repo. There is no controlled experiment for the whole
  pipeline, ours included. The first thing we measured says why the ledger matters: on the same branch, one reviewer
  (a small model) returned `pass` with no findings in 138 s; the other (a frontier model) returned `fail` with two
  fact-level findings against the task spec in 66 s. Whether those two findings were right is what the pilot checks —
  against a defect list produced independently. Run `review` with both CLIs for a week on your own repo before
  believing either.
- **Backfill dry run (2026-09-18, real Next.js game repo, one plain-language request):** the session wrote an in-memory Upstash-Redis
  fake plus 64 characterization tests for the two untested server stores, every test file passed pin-check (fails when its target is
  blanked, passes when restored), and the fresh reviewer returned `pass` with three low-severity fact notes that were all correct
  (a dead code path being pinned, a tautological assertion against a shared object, a wrong error message hidden by a loose matcher).
  The same run exposed three tool defects, since fixed: an empty packet for untracked files, a sandbox failure recorded as a verdict,
  and a spurious third review after `git add`.
- Known gaps: large diffs are truncated at `maxDiffChars` in the packet (the file list stays complete and the reviewer
  can open files); `red-green` needs a test command and a checkout-able base; Codex's read-only sandbox does not work on
  some Linux hosts (the tool detects the failure, falls back to the other CLI in `auto` mode, and otherwise tells you to set
  `codexSandbox: "danger-full-access"`; the tree is reset after such a run); the lint is
  regex-based and language-agnostic — it will miss exotic runners and can be extended in `src/lint.js`.

## Development

```
npm test                       # node:test on a fixture repository — lint signatures, red→green, guard, worktree packets/fingerprint, plugin sync
node scripts/build-plugin.js   # regenerate plugin/ (skills + hooks) after editing adapters/claude-plugin/ — the test suite fails if it is stale
claude plugin validate .       # marketplace + plugin manifests
```

Layout: `bin/` CLI (+ `bin/review-gate` shell entry used by the plugin), `src/` the gates, `lib/` rubric + verdict schema,
`adapters/claude-plugin/` the single source of the slash commands and the CLAUDE.md snippet (npm route), `plugin/` the generated
Claude Code plugin form, `.claude-plugin/` manifests (this repository is its own marketplace), `adapters/codex`, `adapters/ci`.

MIT.

---

## 한국어 요약

**무엇:** 코딩 에이전트가 만든 변경을, 작업 세션과 무관한 **새 CLI 세션**(`claude -p` 또는 `codex exec`)이 리뷰하게 하고,
TDD를 실제로 지켰는지를 **기계로** 검사하는 도구. npm 패키지 하나, 의존성 0.

**왜 만들었나:** ① 작성한 세션은 자기 코드를 합리화한다 — 리뷰어는 기억도 이해관계도 없어야 한다. ② 「테스트 통과」가
「맞다」와 같은 말이 아니게 됐다 — 에이전트는 스킵·assert 삭제·구현 뒤에 쓴 테스트·테스트 전용 분기로 초록불을 만든다.
기존 도구는 대부분 「신중히 리뷰해」라는 프롬프트를 하나 더 얹는데, 프롬프트는 게이트가 아니다.

**힘을 준 곳:** ① 돈 안 드는 리뷰어 격리 — 이미 쓰는 CLI를 새 프로세스로 띄워 리뷰 꾸러미만 준다. 둘 다 있으면 반대편
모델, 하나면 같은 모델 새 세션(`--reviewer auto`). ② 결정적 게이트 — 테스트 무결성 diff 린트 13징후, red→green
검증(테스트만 얹은 base는 실패·head는 통과), 구현 단계 테스트 파일 잠금 훅(sed/tee 우회까지). ③ 잡음 없는 판정 계약 —
판정 먼저, 사실/취향 구분, 근거, 「문제 없음」 허용, 원장에 쌓아 적중률을 센다.

**기존 것과 다른 점:** 같은 세션·호스팅 봇이 아니라 새 프로세스 / API 키가 아니라 기존 구독 / 프롬프트가 아니라 훅·CI
차단 / 테스트 해킹 검사(기성 도구 없음) / 판정 형식 / 내가 소유한 원장. 다중 투표·호스팅 PR 봇·LLM 판정 쓰기 차단은
일부러 안 넣었다(비용·격리 무관·우회).

**증명된 것과 안 된 것:** 부품마다 근거는 있지만 조합이 품질을 올린다는 통제 실험은 없다. 첫 실측에서 같은 브랜치를
두고 작은 모델은 「통과·지적 0」, 최전선 모델은 「문제·사실 2건」 — 그래서 원장이 필요하다. 자기 저장소에서 두 CLI로 일주일
돌려 보고 믿을 것.
