'use strict';
// git helpers — every command is a subprocess; no library dependency.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const TEST_GLOBS = [/(^|\/)test_[^/]*\.py$/, /_test\.[a-z]+$/, /(^|\/)tests?\//, /(^|\/)__tests__\//, /\.test\.[a-z]+$/, /\.spec\.[a-z]+$/, /(^|\/)e2e\//, /(^|\/)conftest\.py$/];
const RUNNER_FILES = [/^pytest\.ini$/, /^pyproject\.toml$/, /^setup\.cfg$/, /^tox\.ini$/, /^jest\.config\./, /^vitest\.(config|workspace)\./, /^playwright\.config\./, /^package\.json$/, /^\.mocharc/, /^karma\.conf\./];

function run(cmd, args, opts = {}) {
  const p = spawnSync(cmd, args, { cwd: opts.cwd, input: opts.input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: opts.timeout, shell: opts.shell || false, env: opts.env });
  return { code: p.status == null ? -1 : p.status, out: p.stdout || '', err: p.stderr || '', signal: p.signal };
}
function git(args, cwd, input) { return run('git', args, { cwd, input }); }
function repoRoot(dir = '.') {
  const r = git(['rev-parse', '--show-toplevel'], dir);
  if (r.code !== 0) throw new Error('not a git repository: ' + dir);
  return r.out.trim();
}
function isTestPath(p) { return TEST_GLOBS.some(re => re.test(p)); }
function isRunnerFile(p) { const b = path.basename(p); return RUNNER_FILES.some(re => re.test(b)); }
function refArgs(base, head) { return head === 'WORKTREE' ? [base] : [base, head]; }
function resolveRange(repo, base, head) {
  if (!base) {
    for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
      if (git(['rev-parse', '--verify', '-q', cand], repo).code === 0) {
        const mb = git(['merge-base', cand, 'HEAD'], repo).out.trim();
        if (mb) { base = mb; break; }
      }
    }
    if (!base) throw new Error('cannot determine base — pass --base');
  }
  return [base, head || 'HEAD'];
}
function diffText(repo, base, head, paths) {
  const args = ['diff', '--no-color', '--no-ext-diff', ...refArgs(base, head)];
  if (paths && paths.length) args.push('--', ...paths);
  return git(args, repo).out;
}
function diffStat(repo, base, head) { return git(['diff', '--stat=120', ...refArgs(base, head)], repo).out; }
function changedFiles(repo, base, head) {
  const rows = [];
  for (const l of git(['diff', '--name-status', ...refArgs(base, head)], repo).out.split('\n')) {
    const parts = l.split('\t');
    if (parts.length >= 2) rows.push({ status: parts[0][0], path: parts[parts.length - 1] });
  }
  if (head === 'WORKTREE') {   // untracked files count as added (dependency/vendor/artefact dirs never do)
    for (const l of git(['ls-files', '--others', '--exclude-standard'], repo).out.split('\n')) if (l.trim()) rows.push({ status: 'A', path: l.trim() });
  }
  const SKIP = /(^|\/)(node_modules|\.review-gate|\.git|dist|build|coverage|\.next|vendor|target)\//;
  return rows.filter(r => !SKIP.test(r.path));
}
function headSha(repo, head) { return git(['rev-parse', '--short=12', head === 'WORKTREE' ? 'HEAD' : head], repo).out.trim(); }
function fileAt(repo, ref, p) {
  if (ref === 'WORKTREE') { try { return fs.readFileSync(path.join(repo, p), 'utf8'); } catch { return null; } }
  const r = git(['show', `${ref}:${p}`], repo);
  return r.code === 0 ? r.out : null;
}
function addedLines(repo, base, head, p) {
  return diffText(repo, base, head, [p]).split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n');
}
module.exports = { run, git, repoRoot, isTestPath, isRunnerFile, resolveRange, diffText, diffStat, changedFiles, headSha, fileAt, addedLines };
