'use strict';
// `review-gate review` — builds the packet, runs the deterministic checks, runs the reviewer, appends the ledger.
// Ledger: <repo>/.review-gate/reviews.jsonl (append-only; commit it — it is how you later count which findings were real).
// Runs:   <repo>/.review-gate/runs/<ts>-<sha>/{packet.md,raw.txt,verdict.json} (gitignored audit trail).
const fs = require('node:fs'), path = require('node:path');
const { repoRoot, resolveRange, headSha, git, worktreeDiffHash } = require('./git');
const { lintTests } = require('./lint');
const { redGreen } = require('./redgreen');
const { pickReviewer, buildPacket, extractJson, runClaude, runCodex, environmentFailure, detectClis } = require('./reviewer');

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
function review(o) {
  const repo = repoRoot(o.repo || '.');
  let [base, head] = resolveRange(repo, o.base, o.head);
  if (o.worktree && head === 'HEAD') head = 'WORKTREE';
  const reviewer = pickReviewer(o.reviewer || 'auto', o.author || 'claude');
  const checks = {};
  if (!o.noLint) checks.test_integrity = lintTests(repo, base, head);
  if (o.testCmd) { const rg = redGreen(repo, base, head, o.testCmd); checks.red_green = Object.fromEntries(Object.entries(rg).filter(([k]) => !k.endsWith('_tail'))); }
  const intent = o.intent ? fs.readFileSync(o.intent, 'utf8') : (o.intentText || null);
  const { packet, meta: pmeta } = buildPacket(repo, base, head, intent, checks, o.maxDiffChars || 120000, o.maxTurns || 40);
  if (pmeta.files === 0) return { skipped: 'empty diff', code: 0 };
  const home = o.out ? path.resolve(o.out) : path.join(repo, '.review-gate');   // --out: keep ledger+runs outside the reviewed repo (pilots, CI artifacts)
  const runDir = path.join(home, 'runs', `${stamp()}-${headSha(repo, head)}`); fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'packet.md'), packet);
  const t0 = Date.now();
  const r = reviewer === 'claude' ? runClaude(repo, packet, o) : runCodex(repo, packet, o);
  const duration = (Date.now() - t0) / 1000;
  fs.writeFileSync(path.join(runDir, 'raw.txt'), r.raw);
  if (reviewer === 'codex' && (o.sandbox || 'read-only') !== 'read-only') git(['checkout', '--', '.'], repo);   // the reviewer must not leave edits behind
  let verdict;
  if (r.meta && r.meta.env_fail) verdict = { verdict: 'unsure', summary: r.meta.env_fail, findings: [] };   // pre-flight failed: handled below as an environment failure
  else try { verdict = extractJson(r.text); } catch (e) {
    const why = r.meta && (r.meta.subtype === 'error_max_turns' || r.meta.terminal_reason === 'max_turns') ? `the reviewer used up its turn budget (${o.maxTurns || 40}) exploring and never answered — raise --max-turns or narrow the diff` : `no parsable verdict (rc=${r.code}): ${e.message}`;
    return { error: `reviewer (${reviewer}): ${why}`, tail: (r.text || '').slice(-800), code: 1, runDir };
  }
  // The reviewer's environment failed (sandbox refused, tools unusable): that is not a review. In auto mode fall back to the other CLI once;
  // otherwise report the cause with the fix. Nothing with a diff fingerprint is written, so the Stop gate still sees the change as unreviewed.
  const envFail = (verdict.verdict !== 'fail' && verdict.findings && verdict.findings.length === 0) ? environmentFailure(r, verdict) : null;
  if (envFail) {
    const other = reviewer === 'claude' ? 'codex' : 'claude';
    fs.appendFileSync(path.join(home, 'reviews.jsonl'), JSON.stringify({ ts: new Date().toISOString(), repo: path.basename(repo), reviewer, error: 'environment failure', signature: envFail, run_dir: path.relative(home, runDir), diff_hash: null }) + '\n');
    if ((o.reviewer || 'auto') === 'auto' && !o._fellBack && detectClis()[other]) return review(Object.assign({}, o, { reviewer: other, _fellBack: reviewer, _fellBackWhy: envFail }));
    const fix = reviewer === 'codex' ? 'Codex could not start its sandbox here — set "codexSandbox": "danger-full-access" in .review-gate/config.json (Linux hosts without user namespaces), or use --reviewer claude.' : 'check that the claude CLI is logged in and can run in this directory.';
    return { error: `reviewer (${reviewer}) could not work: ${envFail}. ${fix}`, tail: (verdict.summary || '').slice(-600), code: 1, runDir };
  }
  verdict.findings = verdict.findings || []; verdict.good = verdict.good || []; verdict.checked = verdict.checked || [];
  if (!['pass', 'fail', 'unsure'].includes(verdict.verdict)) verdict.verdict = 'unsure';
  // Verdict calibration (pilot 2026-09-18, 10 branches × 2 reviewers): one reviewer wrote medium-severity fact findings and still said "pass"
  // in 2 of 10 runs. A medium/high fact finding IS the verdict — the reviewer's summary word does not get to soften it.
  const seriousFact = verdict.findings.some(f => f.kind === 'fact' && ['medium', 'high'].includes(f.severity));
  if (seriousFact && verdict.verdict === 'pass') { verdict.reviewer_verdict = 'pass'; verdict.verdict = 'fail'; verdict.summary = '[calibrated: pass → fail because of a medium/high fact finding] ' + (verdict.summary || ''); }
  const rec = {
    ts: new Date().toISOString(), repo: path.basename(repo), base, head, head_sha: headSha(repo, head), reviewer, author: o.author || 'claude', mode: o.reviewer || 'auto',
    meta: r.meta, duration_s: duration, packet: pmeta, checks, verdict: verdict.verdict, summary: verdict.summary || '', ...(o._fellBack ? { fallback_from: o._fellBack, fallback_reason: o._fellBackWhy } : {}),
    n_fact: verdict.findings.filter(f => f.kind === 'fact').length, n_taste: verdict.findings.filter(f => f.kind === 'taste').length,
    findings: verdict.findings, good: verdict.good, checked: verdict.checked, run_dir: path.relative(home, runDir), label: o.label || '',
    diff_hash: head === 'WORKTREE' ? worktreeDiffHash(repo, base).hash : null,
  };
  const led = home; fs.mkdirSync(led, { recursive: true });
  const gi = path.join(led, '.gitignore'); if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'runs/\nphase\nstop-strikes.json\n');
  fs.appendFileSync(path.join(led, 'reviews.jsonl'), JSON.stringify(rec) + '\n');
  fs.writeFileSync(path.join(runDir, 'verdict.json'), JSON.stringify(verdict, null, 1));
  const blocking = verdict.verdict === 'fail' || (checks.test_integrity && checks.test_integrity.level === 'hard') || (checks.red_green && ['not-red', 'not-green'].includes(checks.red_green.verdict));
  return { rec, verdict, blocking, code: o.block && blocking ? 2 : 0, runDir };
}
function format(res) {
  if (res.skipped) return `review-gate: nothing to review (${res.skipped})`;
  if (res.error) return `review-gate: ${res.error}\n${res.tail || ''}`;
  const { rec, verdict } = res; const mark = { pass: '✅', fail: '❌', unsure: '❓' }[verdict.verdict];
  const lines = [`${mark} review-gate [${rec.reviewer}${rec.meta && rec.meta.model ? ' ' + rec.meta.model : ''}${rec.fallback_from ? `, fell back from ${rec.fallback_from}: ${rec.fallback_reason}` : ''}] ${verdict.verdict.toUpperCase()} — ${verdict.summary} (${rec.duration_s.toFixed(0)}s, ${rec.n_fact} fact / ${rec.n_taste} taste)`];
  for (const f of verdict.findings) lines.push(`  [${f.severity || '?'}/${f.kind || '?'}] ${f.file || ''}:${f.line || ''} — ${f.claim || ''}` + (f.evidence ? `\n      evidence: ${f.evidence}` : '') + (f.suggestion ? `\n      → ${f.suggestion}` : ''));
  for (const g of verdict.good.slice(0, 3)) lines.push(`  👍 ${g}`);
  const ti = rec.checks.test_integrity; if (ti && ti.findings.length) lines.push('  test-integrity: ' + ti.findings.map(x => `${x.level} ${x.file}: ${x.msg}`).join('; '));
  const rg = rec.checks.red_green; if (rg) lines.push(`  red→green: ${rg.verdict} — ${rg.note || ''}`);
  return lines.join('\n');
}
module.exports = { review, format };
