'use strict';
// `review-gate env-check --test T` — does test T depend on the *absence* of environment variables? A test that assumes VERCEL or
// EXPO_PUBLIC_API_URL is unset passes on one machine and fails on the next (observed 2026-09-18: two backfilled tests, caught only
// because a reviewer ran them with the variables exported). Deterministic: collect the env names the code reads (`process.env.X`,
// `os.environ["X"]`, `os.Getenv("X")`), run the test with all of them set to a sentinel — if it fails, bisect to the culprits.
const fs = require('node:fs'), path = require('node:path');
const { run, repoRoot } = require('./git');
const { singleTestCmd } = require('./pincheck');

const ENV_RE = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])|os\.environ(?:\.get)?\(?['"\[]+([A-Z_][A-Z0-9_]*)|os\.Getenv\(['"]([A-Z_][A-Z0-9_]*)/g;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|vendor|target|\.review-gate)\//;
const SRC_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|py|go)$/;
const IGNORE_VARS = new Set(['NODE_ENV', 'CI', 'PATH', 'HOME', 'TZ', 'DEBUG', 'VITEST', 'JEST_WORKER_ID', 'PYTEST_CURRENT_TEST', 'TEST', 'NODE_OPTIONS']);

function envNames(dir) {
  const names = new Set();
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (SKIP_DIR.test(p + '/')) continue; if (e.isDirectory()) walk(p); else if (SRC_EXT.test(e.name)) { let s = ''; try { s = fs.readFileSync(p, 'utf8'); } catch { continue; } for (const m of s.matchAll(ENV_RE)) { const n = m[1] || m[2] || m[3] || m[4]; if (n && !IGNORE_VARS.has(n)) names.add(n); } } } })(dir);
  return [...names].sort();
}
function envCheck(dir, testFile, opts = {}) {
  const repo = repoRoot(dir || '.'); const cwd = path.resolve(dir || '.');
  const testAbs = [path.resolve(cwd, testFile), path.join(repo, testFile)].find(a => fs.existsSync(a)); if (!testAbs) return { verdict: 'error', note: `test not found: ${testFile}` };
  let ws = path.dirname(testAbs); while (ws !== repo && !fs.existsSync(path.join(ws, 'package.json')) && !fs.existsSync(path.join(ws, 'pyproject.toml')) && !fs.existsSync(path.join(ws, 'go.mod'))) ws = path.dirname(ws);
  const cmd = singleTestCmd(ws, path.relative(ws, testAbs), opts.cmd); if (!cmd) return { verdict: 'error', note: 'no runner detected — pass --cmd "<runner> {file}"' };
  const names = (opts.vars && opts.vars.length ? opts.vars : envNames(ws)).filter(n => process.env[n] === undefined);   // already-set vars are the machine's business
  const timeout = (opts.timeoutSec || 600) * 1000; const sentinel = opts.value || 'review-gate-env-probe';
  const exec = vars => { const env = Object.assign({}, process.env); for (const v of vars) env[v] = sentinel; const r = run(cmd, [], { cwd: ws, shell: true, timeout, env }); return r.code === 0; };
  const out = { test: testFile, cmd, workspace: path.relative(repo, ws) || '.', candidates: names.length };
  if (!exec([])) return Object.assign(out, { verdict: 'broken', note: 'the test does not pass in the current environment — fix that first' });
  if (!names.length) return Object.assign(out, { verdict: 'clean', culprits: [], note: 'no environment variables are read by this workspace' });
  if (exec(names)) return Object.assign(out, { verdict: 'clean', culprits: [], note: `passes with all ${names.length} environment variables set — no dependence on their absence` });
  // bisect to the smallest set that breaks it (usually one or two names)
  const culprits = [];
  const bisect = vars => { if (vars.length === 1) { culprits.push(vars[0]); return; } const mid = vars.length >> 1, a = vars.slice(0, mid), b = vars.slice(mid); if (!exec(a)) bisect(a); if (!exec(b)) bisect(b); };
  bisect(names);
  if (!culprits.length) culprits.push('(combination of several)');
  return Object.assign(out, { verdict: 'env-dependent', culprits, note: `fails when ${culprits.join(', ')} is set — the test assumes the variable is absent; stub it inside the test (vi.stubEnv / monkeypatch.delenv) instead of relying on the shell` });
}
module.exports = { envCheck, envNames };
