'use strict';
// `review-gate audit` — deterministic test-health inventory of a whole repository (any size). No model involved.
// Produces the facts the /review-gate:audit skill turns into docs/test-audit.md: runner, test↔source mapping, untested modules ranked by
// size, weak tests (no assertions / skipped / snapshot-only / tautological), CI and coverage presence. Judgement (which modules are core,
// what to write first) is the skill's job — this file only measures.
const fs = require('node:fs'), path = require('node:path');
const { run, git, repoRoot, isTestPath, isRunnerFile } = require('./git');

const SRC_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|rb|php|cs|swift)$/;
const IGNORE = /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|\.nuxt|vendor|target|__pycache__|\.venv|venv|\.review-gate|public|static|assets|migrations|\.cache)\//;
const ASSERT_RE = /\b(assert(?:\.\w+)?|assert\w+|expect|should)\s*\(|\bassert\s+(?![=(\s])\S/g;
const TEST_DEF_RE = /^\s*(?:async\s+)?def\s+test_\w+|^\s*(?:it|test|describe)\s*\(|^\s*(?:it|test)\.each|@Test\b|^\s*func\s+Test\w+|#\[test\]/gm;
const SKIP_RE = /\.skip\s*\(|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|skipif|xfail)|\bpytest\.skip\(|\.todo\(|\.fixme\(|t\.Skip\(/g;
const SNAPSHOT_RE = /toMatchSnapshot|toMatchInlineSnapshot|assert_snapshot|snapshot\(/g;
const TAUTOLOGY_RE = /expect\(\s*true\s*\)\.toBe\(\s*true\s*\)|\bassert\s+True\b|assertTrue\(\s*True\s*\)|expect\(\s*1\s*\)\.toBe\(\s*1\s*\)/g;
const EXPORT_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)|^\s*module\.exports\s*=|^\s*exports\.(\w+)\s*=|^def\s+(\w+)|^class\s+(\w+)|^func\s+([A-Z]\w*)|^pub\s+fn\s+(\w+)/gm;
const count = (re, s) => (s.match(re) || []).length;

function detectRunner(repo) {
  const has = f => fs.existsSync(path.join(repo, f));
  let pj = null; try { pj = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); } catch {}
  const deps = pj ? Object.assign({}, pj.dependencies, pj.devDependencies) : {};
  const out = { language: null, runner: null, testCmd: null, coverageCmd: null, ci: [], notes: [] };
  if (pj) {
    out.language = deps.typescript || has('tsconfig.json') ? 'typescript' : 'javascript';
    out.runner = deps.vitest ? 'vitest' : deps.jest ? 'jest' : deps.mocha ? 'mocha' : (pj.scripts && /node --test/.test(pj.scripts.test || '')) ? 'node:test' : null;
    out.testCmd = pj.scripts && pj.scripts.test ? 'npm test --silent' : null;
    if (pj.scripts && pj.scripts.test && /no test specified/.test(pj.scripts.test)) { out.testCmd = null; out.notes.push('package.json "test" script is the npm placeholder'); }
    if (out.runner === 'vitest') out.coverageCmd = 'npx vitest run --coverage'; else if (out.runner === 'jest') out.coverageCmd = 'npx jest --coverage';
    if (deps['@playwright/test']) out.notes.push('playwright present (e2e)');
  } else if (['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].some(has) || fs.existsSync(path.join(repo, 'requirements.txt'))) {
    out.language = 'python'; out.runner = 'pytest'; out.testCmd = 'pytest -q'; out.coverageCmd = 'pytest -q --cov';
  } else if (has('go.mod')) { out.language = 'go'; out.runner = 'go test'; out.testCmd = 'go test ./...'; out.coverageCmd = 'go test ./... -cover'; }
  else if (has('Cargo.toml')) { out.language = 'rust'; out.runner = 'cargo test'; out.testCmd = 'cargo test'; }
  const wf = path.join(repo, '.github', 'workflows');
  if (fs.existsSync(wf)) for (const f of fs.readdirSync(wf)) { const t = fs.readFileSync(path.join(wf, f), 'utf8'); out.ci.push({ file: f, runs_tests: /(npm|pnpm|yarn)\s+(run\s+)?test|vitest|jest|pytest|go test|cargo test/.test(t) }); }
  return out;
}

function listFiles(repo) {
  const tracked = git(['ls-files', '-z'], repo).out.split('\0').filter(Boolean);
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard'], repo).out.split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked])].filter(p => !IGNORE.test(p + '/') && !IGNORE.test(p));
}
const stem = p => path.basename(p).replace(/\.(test|spec)\./, '.').replace(/^test_/, '').replace(/_test(\.[a-z]+)$/, '$1').replace(/\.[a-z]+$/, '');

function audit(repoDir, opts = {}) {
  const repo = repoRoot(repoDir || '.');
  const runner = detectRunner(repo);
  const files = listFiles(repo).filter(p => SRC_EXT.test(p));
  const looksLikeTest = p => { if (/\.(test|spec)\.[a-z]+$|(^|\/)__tests__\/|(^|\/)test_[^/]*\.py$|_test\.(py|go)$/.test(p)) return true; let s = ''; try { s = fs.readFileSync(path.join(repo, p), 'utf8'); } catch {} return count(TEST_DEF_RE, s) > 0 || count(ASSERT_RE, s) > 0; };
  // a file under test/ or tests/ counts as a test only if it contains test cases or assertions — app routes like src/app/test/... are source
  const tests = files.filter(p => isTestPath(p) && looksLikeTest(p)), helpers = files.filter(p => isTestPath(p) && !looksLikeTest(p) && /(^|\/)(e2e|tests?|__tests__)\/.*(support|helper|fixture|setup|util)/i.test(p));
  const sources = files.filter(p => !tests.includes(p) && !helpers.includes(p) && !isRunnerFile(p) && !/\.(d\.ts|config\.[a-z]+|stories\.[a-z]+)$/.test(p) && !/(^|\/)(vitest|jest)\.setup\.[a-z]+$/.test(p));
  // test → referenced source modules (import/require paths resolved loosely by basename)
  const testInfo = tests.map(t => {
    let s = ''; try { s = fs.readFileSync(path.join(repo, t), 'utf8'); } catch {}
    const refs = new Set();
    for (const m of s.matchAll(/(?:from\s+|require\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) { const r = m[1]; if (r.startsWith('.') || r.startsWith('@/') || r.startsWith('~/') || r.startsWith('src/')) refs.add(path.basename(r).replace(/\.[a-z]+$/, '')); }
    for (const m of s.matchAll(/^\s*from\s+([\w.]+)\s+import|^\s*import\s+([\w.]+)/gm)) refs.add(((m[1] || m[2]) || '').split('.').pop());
    const n = count(TEST_DEF_RE, s), a = count(ASSERT_RE, s), sk = count(SKIP_RE, s), snap = count(SNAPSHOT_RE, s), taut = count(TAUTOLOGY_RE, s);
    const flags = [];
    if (n && !a && !snap) flags.push('no assertions'); if (sk) flags.push(`${sk} skipped/todo`); if (snap && a <= snap) flags.push('snapshot-only'); if (taut) flags.push(`${taut} tautological`); if (!n) flags.push('no test cases found');
    return { file: t, tests: n, asserts: a, refs: [...refs], flags, lines: s.split('\n').length };
  });
  const refIndex = new Map(); for (const ti of testInfo) for (const r of ti.refs) { if (!refIndex.has(r)) refIndex.set(r, []); refIndex.get(r).push(ti.file); }
  const srcInfo = sources.map(p => {
    let s = ''; try { s = fs.readFileSync(path.join(repo, p), 'utf8'); } catch {}
    const st = stem(p); const byName = tests.filter(t => stem(t) === st); const byRef = refIndex.get(st) || [];
    const covered = [...new Set([...byName, ...byRef])];
    const exports = count(EXPORT_RE, s); const lines = s.split('\n').length;
    return { file: p, lines, exports, tests: covered, tested: covered.length > 0 };
  });
  const untested = srcInfo.filter(x => !x.tested).sort((a, b) => b.lines * (1 + b.exports) - a.lines * (1 + a.exports));
  const byDir = {}; for (const x of srcInfo) { const d = path.dirname(x.file).split('/').slice(0, 2).join('/'); byDir[d] = byDir[d] || { files: 0, tested: 0, lines: 0 }; byDir[d].files++; byDir[d].lines += x.lines; if (x.tested) byDir[d].tested++; }
  let testRun = null;
  if (opts.runTests && runner.testCmd) { const t0 = Date.now(); const r = run(runner.testCmd, [], { cwd: repo, shell: true, timeout: 900000 }); testRun = { cmd: runner.testCmd, exit: r.code, seconds: (Date.now() - t0) / 1000, tail: (r.out + r.err).slice(-1200) }; }
  const weak = testInfo.filter(t => t.flags.length);
  return {
    repo: path.basename(repo), runner, totals: { source_files: sources.length, source_lines: srcInfo.reduce((a, x) => a + x.lines, 0), test_files: tests.length, test_cases: testInfo.reduce((a, x) => a + x.tests, 0), assertions: testInfo.reduce((a, x) => a + x.asserts, 0), untested_files: untested.length, untested_lines: untested.reduce((a, x) => a + x.lines, 0), weak_test_files: weak.length },
    by_dir: byDir, untested: untested.slice(0, opts.top || 60), weak_tests: weak, test_files: testInfo.map(t => ({ file: t.file, tests: t.tests, asserts: t.asserts, flags: t.flags })), test_run: testRun,
    ci: runner.ci, notes: runner.notes.concat(helpers.length ? [`test helpers (not counted as tests): ${helpers.join(', ')}`] : []),
  };
}
function format(a) {
  const L = [];
  L.push(`# test audit — ${a.repo}`, '', `runner: ${a.runner.runner || 'none'} (${a.runner.language || '?'}) · test command: ${a.runner.testCmd || 'NONE'} · coverage: ${a.runner.coverageCmd || 'n/a'} · CI: ${a.ci.length ? a.ci.map(c => `${c.file}${c.runs_tests ? ' (runs tests)' : ' (no tests)'}`).join(', ') : 'none'}`);
  const t = a.totals; L.push(`source files ${t.source_files} (${t.source_lines.toLocaleString()} lines) · test files ${t.test_files} · test cases ${t.test_cases} · assertions ${t.assertions} · untested source files ${t.untested_files} (${t.untested_lines.toLocaleString()} lines) · weak test files ${t.weak_test_files}`);
  if (a.test_run) L.push(`test run: exit ${a.test_run.exit} in ${a.test_run.seconds}s`);
  L.push('', '## by directory (files tested/total · lines)'); for (const [d, v] of Object.entries(a.by_dir).sort((x, y) => y[1].lines - x[1].lines)) L.push(`- ${d}: ${v.tested}/${v.files} · ${v.lines.toLocaleString()} lines`);
  L.push('', `## untested source files (top ${a.untested.length}, by size × exports)`); for (const u of a.untested) L.push(`- ${u.file} · ${u.lines} lines · ${u.exports} exports`);
  L.push('', `## weak tests (${a.weak_tests.length})`); for (const w of a.weak_tests) L.push(`- ${w.file}: ${w.flags.join(', ')} (${w.tests} tests / ${w.asserts} asserts)`);
  if (a.notes.length) L.push('', '## notes', ...a.notes.map(n => '- ' + n));
  return L.join('\n');
}
module.exports = { audit, format, detectRunner };
