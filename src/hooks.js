'use strict';
// Hook-side commands: TDD phase file + the PreToolUse guard that locks test files during the implement phase.
// Claude Code passes hook input as JSON on stdin: {tool_name, tool_input:{file_path|command}, cwd, ...}. Exit 2 = block (stderr goes to the model).
const fs = require('node:fs'), path = require('node:path');
const { repoRoot, isTestPath, isRunnerFile } = require('./git');

const phaseFile = repo => path.join(repo, '.review-gate', 'phase');
function getPhase(repo) { try { return fs.readFileSync(phaseFile(repo), 'utf8').trim() || 'test'; } catch { return 'test'; } }
function setPhase(repo, v) { fs.mkdirSync(path.dirname(phaseFile(repo)), { recursive: true }); fs.writeFileSync(phaseFile(repo), v + '\n'); }

const SHELL_WRITE = /\b(sed\s+-i|perl\s+-p?i|tee\b|>\s*\S|>>\s*\S|\bcp\s|\bmv\s|\brm\s|python[0-9.]*\s+-c|node\s+-e|truncate\b|install\s)/;
const TEST_HINT = /(test_[^\s]*\.py|_test\.[a-z]+|\.test\.[a-z]+|\.spec\.[a-z]+|\/tests?\/|__tests__|\/e2e\/|conftest\.py|pytest\.ini|vitest\.(config|workspace)|jest\.config|playwright\.config|tox\.ini)/;

function guardTests(hookJson, repoOverride) {
  if (process.env.REVIEW_GATE_ROLE === 'reviewer') return { code: 0 };   // the reviewer process is read-only by construction; never lock it out
  let hook; try { hook = JSON.parse(hookJson); } catch { return { code: 0 }; }
  let repo; try { repo = repoRoot(repoOverride ? path.resolve(hook.cwd || '.', repoOverride) : (hook.cwd || '.')); } catch { return { code: 0 }; }
  if (getPhase(repo) !== 'implement') return { code: 0 };
  const ti = hook.tool_input || {}, tool = hook.tool_name || '';
  if (tool === 'Bash') {
    const cmd = ti.command || '';
    if (SHELL_WRITE.test(cmd) && TEST_HINT.test(cmd)) return { code: 2, msg: 'review-gate: implement phase — shell writes to test files are blocked. If the spec must change, run `review-gate phase test`, change the test, and get that reviewed.' };
    return { code: 0 };
  }
  const target = ti.file_path || ti.path || ti.notebook_path || '';
  if (!target) return { code: 0 };
  const rel = path.relative(repo, path.resolve(hook.cwd || repo, target));
  if (rel.startsWith('..')) return { code: 0 };   // outside the target repo (e.g. the context repo's own files) — not ours to lock
  if (isTestPath(rel) || isRunnerFile(rel)) return { code: 2, msg: `review-gate: implement phase — ${rel} is a test/runner file and is locked. If the spec must change, run \`review-gate phase test\`, change the test, and get that reviewed.` };
  return { code: 0 };
}
module.exports = { getPhase, setPhase, guardTests };
