'use strict';
// red → green verifier: base + ONLY the test changes must fail; head must pass. Runs in a throwaway worktree
// (dependency dirs are symlinked in). "not-red" means the changed tests already pass on the old code — they do not pin the new behavior.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { git, run, changedFiles, isTestPath, diffText } = require('./git');

function copyUntracked(repo, wt, paths) {
  for (const p of paths) {
    if (git(['ls-files', '--error-unmatch', p], repo).code !== 0 && fs.existsSync(path.join(repo, p))) {
      fs.mkdirSync(path.dirname(path.join(wt, p)), { recursive: true }); fs.copyFileSync(path.join(repo, p), path.join(wt, p));
    }
  }
}
function redGreen(repo, base, head, testCmd, opts = {}) {
  const linkDirs = opts.linkDirs || ['node_modules', '.venv', 'venv'], timeout = (opts.timeoutSec || 1800) * 1000;
  const files = changedFiles(repo, base, head), testFiles = files.filter(f => isTestPath(f.path)).map(f => f.path);
  if (!testFiles.length) return { verdict: 'no-tests', note: 'no test files changed — refactor or untested change; red→green not applicable', red: null, green: null };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gate-rg-')), wt = path.join(tmp, 'wt');
  const out = { verdict: null, test_files: testFiles };
  try {
    const add = git(['worktree', 'add', '--detach', wt, base], repo);
    if (add.code !== 0) return { verdict: 'error', note: 'worktree add failed: ' + add.err.slice(-300) };
    for (const d of linkDirs) { const src = path.join(repo, d); if (fs.existsSync(src) && !fs.existsSync(path.join(wt, d))) fs.symlinkSync(src, path.join(wt, d), 'dir'); }
    const patch = diffText(repo, base, head, testFiles);
    if (head === 'WORKTREE') copyUntracked(repo, wt, testFiles);
    if (patch.trim()) { const ap = git(['apply', '--3way', '-'], wt, patch); if (ap.code !== 0) return Object.assign(out, { verdict: 'error', note: 'could not apply the test-only patch onto base: ' + ap.err.slice(-300) }); }
    let t0 = Date.now(); const r1 = run(testCmd, [], { cwd: wt, shell: true, timeout });
    out.red = r1.code !== 0; out.red_seconds = (Date.now() - t0) / 1000; out.red_tail = (r1.out + r1.err).slice(-1500);
    git(['checkout', '--detach', '-q', head === 'WORKTREE' ? 'HEAD' : head], wt);
    if (head === 'WORKTREE') { const full = diffText(repo, base, 'WORKTREE'); if (full.trim()) git(['apply', '--3way', '-'], wt, full); copyUntracked(repo, wt, files.map(f => f.path)); }
    t0 = Date.now(); const r2 = run(testCmd, [], { cwd: wt, shell: true, timeout });
    out.green = r2.code === 0; out.green_seconds = (Date.now() - t0) / 1000; out.green_tail = (r2.out + r2.err).slice(-1500);
    out.verdict = out.red && out.green ? 'ok' : !out.red ? 'not-red' : 'not-green';
    out.note = { ok: 'the changed tests fail before the implementation and pass after it', 'not-red': 'the changed tests already pass on the base code — they do not pin the new behavior', 'not-green': 'tests fail on the head — the change is not done' }[out.verdict];
    return out;
  } finally { git(['worktree', 'remove', '--force', wt], repo); fs.rmSync(tmp, { recursive: true, force: true }); }
}
module.exports = { redGreen };
