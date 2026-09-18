#!/usr/bin/env node
'use strict';
// review-gate CLI — independent code review by a fresh CLI session (claude -p / codex exec) + deterministic TDD gates.
//   review-gate init [--target SUBDIR] [--codex] [--ci] [--no-claude]   wire hooks/config (--target: the git repo lives below the cwd project)
//   review-gate review [--base R] [--head R|--worktree] [--reviewer auto|claude|codex|same] [--author claude|codex]
//                      [--model M] [--intent FILE] [--test-cmd CMD] [--block] [--json] [--label L] [--no-lint] [--out DIR]
//   review-gate lint-tests [--base R] [--head R|--worktree] [--json]
//   review-gate red-green --test-cmd CMD [--base R] [--head R|--worktree] [--json]
//   review-gate audit [--json] [--run-tests] [--top N]    test-health inventory of the whole repo (feeds /review-gate:audit)
//   review-gate pin-check --test T --target S [--cmd C]   does test T fail when module S is blanked? (rejects hollow tests)
//   review-gate probe [--ask] [--model M]                 which reviewer CLIs exist (and answer)
//   review-gate phase [test|implement]                    TDD phase (implement = test files locked by the hook)
//   review-gate guard-tests | on-stop                     hook entry points (read hook JSON on stdin)
//   review-gate mcp                                       MCP server over stdio (tools: review, lint_tests, red_green, audit, pin_check, phase)
const fs = require('node:fs'), path = require('node:path');
const { parseArgs } = require('node:util');
const { repoRoot, resolveRange } = require('../src/git');
const { readConfig } = require('../src/init');

const [cmd, ...rest] = process.argv.slice(2);
const spec = {
  repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, worktree: { type: 'boolean' }, reviewer: { type: 'string' }, author: { type: 'string' },
  model: { type: 'string' }, intent: { type: 'string' }, 'test-cmd': { type: 'string' }, block: { type: 'boolean' }, json: { type: 'boolean' }, label: { type: 'string' },
  'no-lint': { type: 'boolean' }, 'max-diff-chars': { type: 'string' }, 'max-turns': { type: 'string' }, sandbox: { type: 'string' }, 'allowed-tools': { type: 'string' },
  out: { type: 'string' }, target: { type: 'string' }, 'run-tests': { type: 'boolean' }, top: { type: 'string' }, test: { type: 'string' }, target: { type: 'string' }, cmd: { type: 'string' }, ask: { type: 'boolean' }, codex: { type: 'boolean' }, ci: { type: 'boolean' }, 'no-claude': { type: 'boolean' }, set: { type: 'string', multiple: true },
};
let args; try { args = parseArgs({ args: rest, options: spec, allowPositionals: true }); } catch (e) { console.error('review-gate: ' + e.message); process.exit(64); }
const v = args.values, pos = args.positionals;
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
// What the reviewer may run: read-only git, plus the project's own test command and the usual runners (2026-09-18 pilot: a reviewer
// that cannot execute tests reads assertions and guesses; the Codex reviewer, which could run them, was the one that caught spec gaps).
function reviewerTools(testCmd) {
  const t = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git grep:*)', 'Bash(git status:*)', 'Bash(git ls-files:*)',
    'Bash(npm test:*)', 'Bash(npx vitest run:*)', 'Bash(npx jest:*)', 'Bash(node --test:*)', 'Bash(pytest:*)', 'Bash(python -m pytest:*)', 'Bash(go test:*)', 'Bash(cargo test:*)',
    'Bash(npx tsc --noEmit:*)', 'Bash(npm run lint:*)', 'Bash(npm run typecheck:*)', 'Bash(npx eslint:*)', 'Bash(go vet:*)', 'Bash(cargo check:*)'];   // read-only verification the pilot reviewer asked for and could not run
  if (testCmd) { const head = testCmd.trim().split(/\s+/).slice(0, 2).join(' '); if (head && !t.includes(`Bash(${head}:*)`)) t.push(`Bash(${head}:*)`); }
  return t.join(',');
}
function opts() {
  const repo = repoRoot(v.repo || '.'); const c = readConfig(repo);
  return {
    repo, base: v.base, head: v.head, worktree: !!v.worktree, reviewer: v.reviewer || process.env.REVIEW_GATE_REVIEWER || c.reviewer || 'auto', author: v.author || process.env.REVIEW_GATE_AUTHOR || c.author || 'claude',
    model: v.model || process.env.REVIEW_GATE_MODEL || c.model || undefined, intent: v.intent, testCmd: v['test-cmd'] || (cmd === 'review' && c.redGreenOnReview ? c.testCmd : undefined) || undefined,
    block: !!v.block || !!c.block, noLint: !!v['no-lint'], maxDiffChars: Number(v['max-diff-chars'] || c.maxDiffChars || 120000), maxTurns: Number(v['max-turns'] || c.maxTurns || 40),
    sandbox: v.sandbox || process.env.REVIEW_GATE_CODEX_SANDBOX || c.codexSandbox || 'read-only', allowedTools: v['allowed-tools'] || reviewerTools(c.testCmd),
    label: v.label || '', out: v.out || process.env.REVIEW_GATE_OUT || undefined, cfg: c,
  };
}
(function main() {
  try {
    if (cmd === 'review') {
      const { review, format } = require('../src/review'); const o = opts(); if (v['test-cmd'] === undefined && v.worktree === undefined && !v.head && !v.base && o.cfg.defaultWorktree) o.worktree = true;
      const res = review(o); console.error(format(res)); if (v.json && res.rec) console.log(JSON.stringify(res.rec)); process.exit(res.code);
    }
    if (cmd === 'lint-tests') {
      const { lintTests } = require('../src/lint'); const o = opts(); let [base, head] = resolveRange(o.repo, o.base, o.head); if (o.worktree) head = 'WORKTREE';
      const r = lintTests(o.repo, base, head);
      if (v.json) console.log(JSON.stringify(r, null, 1)); else { console.log(`test-integrity: ${r.level.toUpperCase()} — ${r.tests_changed} test file(s) changed`); for (const f of r.findings) console.log(`  [${f.level}] ${f.file}: ${f.msg}`); }
      process.exit(r.level === 'hard' ? 2 : r.level === 'soft' ? 1 : 0);
    }
    if (cmd === 'red-green') {
      const { redGreen } = require('../src/redgreen'); const o = opts(); const tc = o.testCmd || o.cfg.testCmd; if (!tc) { console.error('red-green: --test-cmd required (or testCmd in .review-gate/config.json)'); process.exit(64); }
      let [base, head] = resolveRange(o.repo, o.base, o.head); if (o.worktree) head = 'WORKTREE';
      const r = redGreen(o.repo, base, head, tc);
      if (v.json) console.log(JSON.stringify(r, null, 1)); else console.log(`red→green: ${r.verdict} — ${r.note || ''}` + (r.red != null ? ` (red ${r.red_seconds}s, green ${r.green_seconds}s)` : ''));
      process.exit(['ok', 'no-tests'].includes(r.verdict) ? 0 : 2);
    }
    if (cmd === 'probe') {
      const { detectClis, pickReviewer, codexSandboxError } = require('../src/reviewer'); const { run } = require('../src/git'); const have = detectClis(); const author = v.author || 'claude';
      let pick = null; try { pick = pickReviewer('auto', author); } catch {}
      const sb = have.codex ? codexSandboxError(v.sandbox || 'read-only') : null;
      console.log(JSON.stringify({ installed: have, author, auto_pick: pick, codex_sandbox: have.codex ? (sb ? { ok: false, error: sb, fix: 'set "codexSandbox": "danger-full-access" in .review-gate/config.json, or rely on auto fallback to claude' } : { ok: true }) : null }, null, 1));
      if (v.ask) for (const name of Object.keys(have).filter(k => have[k])) {
        const t0 = Date.now();
        const p = name === 'claude' ? run('claude', ['-p', 'reply with the single word ok', '--strict-mcp-config', '--setting-sources', 'user', '--no-session-persistence', '--tools', '', '--max-turns', '1', '--output-format', 'json', ...(v.model ? ['--model', v.model] : [])], { timeout: 120000 })
          : run('codex', ['exec', '--skip-git-repo-check', '-s', 'read-only', ...(v.model ? ['-m', v.model] : []), 'reply with the single word ok'], { timeout: 180000 });
        console.log(`  ${name}: rc=${p.code} ${((Date.now() - t0) / 1000).toFixed(1)}s ${/\bok\b/i.test(p.out + p.err) ? 'answered' : 'no answer'}`);
      }
      process.exit(0);
    }
    if (cmd === 'phase') { const { getPhase, setPhase } = require('../src/hooks'); const repo = repoRoot(v.repo || '.'); if (pos[0]) { if (!['test', 'implement'].includes(pos[0])) { console.error('phase: test | implement'); process.exit(64); } setPhase(repo, pos[0]); console.log('phase = ' + pos[0]); } else console.log(getPhase(repo)); process.exit(0); }
    if (cmd === 'guard-tests') { const { guardTests } = require('../src/hooks'); const r = guardTests(readStdin(), v.repo); if (r.msg) console.error(r.msg); process.exit(r.code); }
    if (cmd === 'on-stop') {   // Stop hook: cheap deterministic checks on the working tree; full review only if config.onStop === 'review'
      const hookIn = readStdin(); let hook = {}; try { hook = JSON.parse(hookIn); } catch {}
      if (process.env.REVIEW_GATE_ROLE === 'reviewer') process.exit(0);   // a reviewer process is never gated
      const o = opts(); const c = o.cfg; if (c.onStop === 'off') process.exit(0);
      // Loop guard: Claude Code sets stop_hook_active once a Stop hook has blocked in this cycle. Block up to 3 times per session so a
      // session that genuinely cannot review (permissions, no CLI) is not trapped — but one ignored message does not end the gate either.
      const strikesFile = path.join(o.repo, '.review-gate', 'stop-strikes.json'); let strikes = {}; try { strikes = JSON.parse(fs.readFileSync(strikesFile, 'utf8')); } catch {}
      const sid = hook.session_id || 'na'; const strike = () => { strikes[sid] = (strikes[sid] || 0) + 1; try { fs.writeFileSync(strikesFile, JSON.stringify(strikes)); } catch {} };
      if (hook.stop_hook_active && (strikes[sid] || 0) >= 3) process.exit(0);
      const { lintTests } = require('../src/lint'); const { worktreeDiffHash } = require('../src/git'); let [base] = resolveRange(o.repo, o.base, 'HEAD');
      const lt = lintTests(o.repo, base, 'WORKTREE'); const msgs = [];
      if (lt.findings.length) msgs.push('review-gate test-integrity: ' + lt.findings.map(x => `${x.level} ${x.file}: ${x.msg}`).join('; '));
      // unreviewed code changes? compare the working-tree fingerprint with the last worktree review in the ledger
      const wt = worktreeDiffHash(o.repo, base); let reviewed = false;
      if (wt.hash) { try { const lines = fs.readFileSync(path.join(o.out || path.join(o.repo, '.review-gate'), 'reviews.jsonl'), 'utf8').trim().split('\n'); reviewed = lines.some(l => { try { return JSON.parse(l).diff_hash === wt.hash; } catch { return false; } }); } catch {} }
      const rg = `${process.env.REVIEW_GATE_CMD || (process.env.CLAUDE_PLUGIN_ROOT ? 'review-gate' : 'npx --no-install review-gate')}${o.repo !== repoRoot('.') ? ' --repo ' + JSON.stringify(path.relative(process.cwd(), o.repo)) : ''}`;
      if (c.onStop === 'review' && wt.hash && !reviewed) { const { review, format } = require('../src/review'); const res = review(Object.assign({}, o, { worktree: true })); msgs.push(format(res)); if (res.blocking && c.block) { console.error(msgs.join('\n')); process.exit(2); } }
      else if (c.onStop === 'gate' && wt.hash && !reviewed) { strike(); msgs.push(`review-gate: ${wt.files} code file(s) changed since the last review — not done yet. Run \`${rg} review --worktree\`, act on the findings, then finish.` + ((strikes[sid] || 0) >= 3 ? ' (third block — the next stop will be allowed; say plainly that the change is unreviewed)' : '')); console.error(msgs.join('\n')); process.exit(2); }
      else if (wt.hash && !reviewed) msgs.push(`review-gate: ${wt.files} code file(s) changed and not yet reviewed — run \`${rg} review --worktree\` before you finish.`);
      if (reviewed || !wt.hash) { if (strikes[sid]) { delete strikes[sid]; try { fs.writeFileSync(strikesFile, JSON.stringify(strikes)); } catch {} } }
      if (msgs.length) console.error(msgs.join('\n'));
      process.exit(lt.level === 'hard' && c.block ? 2 : 0);
    }
    if (cmd === 'mcp') { require('../src/mcp').serve(); return; }   // MCP stdio server: claude mcp add review-gate -- npx review-gate mcp
    if (cmd === 'pin-check') {
      const { pinCheck } = require('../src/pincheck'); const repo = repoRoot(v.repo || '.');
      if (!v.test || !v.target) { console.error('pin-check: --test <file> --target <file> required'); process.exit(64); }
      const r = pinCheck(repo, v.test, v.target, { cmd: v.cmd });
      if (v.json) console.log(JSON.stringify(r, null, 1)); else console.log(`pin-check: ${r.verdict} — ${r.note || ''}` + (r.blanked_fails != null ? ` (blanked: ${r.blanked_fails ? 'fails' : 'PASSES'} ${r.blanked_seconds}s · restored: ${r.restored_passes ? 'passes' : 'FAILS'} ${r.restored_seconds}s)` : ''));
      process.exit(r.verdict === 'pinned' ? 0 : 2);
    }
    if (cmd === 'audit') {
      const { audit, format } = require('../src/audit'); const repo = repoRoot(v.repo || '.'); const a = audit(repo, { runTests: !!v['run-tests'], top: Number(v.top || 60) });
      if (v.json) console.log(JSON.stringify(a, null, 1)); else console.log(format(a)); process.exit(0);
    }
    if (cmd === 'init') { const { init } = require('../src/init'); const set = {}; for (const kv of v.set || []) { const [k, ...r] = kv.split('='); set[k] = r.join('=') === 'true' ? true : r.join('=') === 'false' ? false : r.join('='); } const r = init({ repo: v.repo, target: v.target, cwd: '.', codex: !!v.codex, ci: !!v.ci, noClaude: !!v['no-claude'], set }); console.log('review-gate initialised in ' + r.repo + '\n  ' + r.done.join('\n  ') + `\n  test command: ${r.cfg.testCmd || '(none detected — set testCmd in .review-gate/config.json)'} · reviewer: ${r.cfg.reviewer} · on stop: ${r.cfg.onStop}`); process.exit(0); }
    console.error(fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); process.exit(cmd ? 64 : 0);
  } catch (e) { console.error('review-gate: ' + (e && e.message || e)); process.exit(1); }
})();
