'use strict';
// Test-integrity diff lint — the 13 "test hacking" signatures (skip/only/xfail added, tests deleted, test/assert counts down,
// runner narrowed, production code branching on a test-only signal, tautological asserts, suppressions, try-wrapping).
// Deterministic: no model involved. Output feeds the review packet and can block in CI (level: hard | soft | clean).
const { changedFiles, isTestPath, isRunnerFile, fileAt, addedLines } = require('./git');

const HARD = [
  [/\.skip\s*\(/g, 'skip() added'], [/\.only\s*\(/g, 'only() added (narrows the run)'], [/\bx(it|describe|test)\s*\(/g, 'xit/xdescribe/xtest added'],
  [/@pytest\.mark\.(skip|skipif|xfail)/g, 'pytest skip/xfail marker added'], [/\bpytest\.skip\s*\(/g, 'pytest.skip() added'], [/unittest\.skip/g, 'unittest.skip added'],
  [/\b(test|it)\.(todo|fixme)\s*\(/g, 'todo/fixme test added'],
  [/expect\(\s*true\s*\)\.toBe\(\s*true\s*\)|\bassert\s+True\b|assertTrue\(\s*True\s*\)/g, 'tautological assertion'],
];
const SOFT = [
  [/#\s*noqa|eslint-disable|@ts-ignore|@ts-expect-error/g, 'lint/type suppression added in a test'],
  [/^\s*try\s*[:{]\s*$/gm, 'try block added in a test (can swallow the failure)'],
];
const ASSERT_RE = /\b(assert(?:\.\w+)?|assert\w+|expect|should)\s*\(|\bassert\s+(?![=(\s])\S/g;   // assert(x) · assert.equal(x) · assertEqual(x) · expect(x) · python `assert x` (not `const assert = …`)
const TEST_DEF_RE = /^\s*(?:async\s+)?def\s+test_\w+|^\s*(?:it|test|describe)\s*\(|^\s*(?:it|test)\.each|@Test\b/gm;
const TESTENV_RE = /process\.env\.(NODE_ENV|VITEST|JEST_WORKER_ID)\s*={2,3}\s*['"]test['"]|os\.(getenv|environ)[^\n]{0,40}\b(TEST|PYTEST_CURRENT_TEST)\b|__TEST__|\bisTest\b|\bIS_TEST\b/;
const RUNNER_NARROW_RE = /testPathIgnorePatterns|testIgnore|collect_ignore|--ignore\b|\bnorecursedirs\b|\bpassWithNoTests\b|\bbail\b|--testPathPattern|\s-t\s/g;
const count = (re, s) => (s.match(re) || []).length;

function lintTests(repo, base, head) {
  const findings = [];
  const files = changedFiles(repo, base, head);
  for (const { status, path: p } of files) {
    if (isTestPath(p)) {
      if (status === 'D') { findings.push({ level: 'hard', file: p, msg: 'test file deleted' }); continue; }
      if (status === 'R') findings.push({ level: 'soft', file: p, msg: 'test file renamed/moved' });
      const before = fileAt(repo, base, p) || '', after = fileAt(repo, head, p) || '';
      const added = status === 'A' && head === 'WORKTREE' ? after : addedLines(repo, base, head, p);
      for (const [re, msg] of HARD) { const n = count(re, added); if (n) findings.push({ level: 'hard', file: p, msg: `${msg} ×${n}` }); }
      for (const [re, msg] of SOFT) { const n = count(re, added); if (n) findings.push({ level: 'soft', file: p, msg: `${msg} ×${n}` }); }
      if (status !== 'A') {
        const nb = count(TEST_DEF_RE, before), na = count(TEST_DEF_RE, after), ab = count(ASSERT_RE, before), aa = count(ASSERT_RE, after);
        if (na < nb) findings.push({ level: 'soft', file: p, msg: `test count ${nb} → ${na}` });
        if (aa < ab) findings.push({ level: 'soft', file: p, msg: `assertion count ${ab} → ${aa}` });
      }
    } else if (isRunnerFile(p)) {
      const added = addedLines(repo, base, head, p);
      const hits = [...new Set(added.match(RUNNER_NARROW_RE) || [])];
      if (hits.length) findings.push({ level: 'hard', file: p, msg: 'test runner config changed in a way that can narrow the run (' + hits.join(', ') + ')' });
    } else {
      const added = status === 'A' && head === 'WORKTREE' ? (fileAt(repo, head, p) || '') : addedLines(repo, base, head, p);
      if (TESTENV_RE.test(added)) findings.push({ level: 'hard', file: p, msg: 'production code branches on a test-only environment signal' });
    }
  }
  const testFiles = files.filter(f => isTestPath(f.path)).map(f => f.path);
  const level = findings.some(f => f.level === 'hard') ? 'hard' : findings.length ? 'soft' : 'clean';
  return { level, tests_changed: testFiles.length, test_files: testFiles, findings };
}
module.exports = { lintTests };
