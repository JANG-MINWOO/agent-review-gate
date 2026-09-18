'use strict';
// `review-gate pin-check --test T --target S` — does test T actually pin module S? Blank S (keep a backup), run T alone: it must FAIL.
// Restore S, run T again: it must PASS. A characterization test that survives its target being emptied is not testing that target.
// In-place with a backup + restore in `finally` (the test needs the real tree: node_modules, config, fixtures).
const fs = require('node:fs'), path = require('node:path');
const { run, repoRoot } = require('./git');
const { detectRunner } = require('./audit');

function singleTestCmd(repo, testFile, override) {
  if (override) return override.replace('{file}', JSON.stringify(testFile));
  const r = detectRunner(repo).runner;
  if (r === 'vitest') return `npx vitest run ${JSON.stringify(testFile)} --reporter=dot`;
  if (r === 'jest') return `npx jest ${JSON.stringify(testFile)}`;
  if (r === 'mocha') return `npx mocha ${JSON.stringify(testFile)}`;
  if (r === 'node:test') return `node --test ${JSON.stringify(testFile)}`;
  if (r === 'pytest') return `pytest -q ${JSON.stringify(testFile)}`;
  if (r === 'go test') return `go test ${JSON.stringify('./' + path.dirname(testFile))}`;
  return null;
}
function stubFor(target) {
  if (/\.py$/.test(target)) return '# review-gate pin-check stub\n';
  if (/\.go$/.test(target)) return null;   // go: package must compile — not supported in-place
  if (/\.(cjs)$/.test(target)) return 'module.exports = {};\n';
  return 'export {};\n';   // ts/tsx/js/jsx/mjs — ESM stub; CJS consumers get an empty object via interop
}
function pinCheck(repoDir, testFile, target, opts = {}) {
  const repo = repoRoot(repoDir || '.'); const tAbs = path.join(repo, target), testAbs = path.join(repo, testFile);
  if (!fs.existsSync(tAbs)) return { verdict: 'error', note: `target not found: ${target}` };
  if (!fs.existsSync(testAbs)) return { verdict: 'error', note: `test not found: ${testFile}` };
  const cmd = singleTestCmd(repo, testFile, opts.cmd); if (!cmd) return { verdict: 'error', note: 'no runner detected — pass --cmd "<runner> {file}"' };
  const stub = stubFor(target); if (stub == null) return { verdict: 'error', note: 'pin-check does not support this file type in place' };
  const original = fs.readFileSync(tAbs); const bak = tAbs + '.review-gate.bak'; fs.writeFileSync(bak, original);
  const timeout = (opts.timeoutSec || 600) * 1000; const out = { test: testFile, target, cmd };
  const restore = () => { try { fs.writeFileSync(tAbs, original); fs.unlinkSync(bak); } catch {} };
  process.on('SIGINT', () => { restore(); process.exit(130); });
  try {
    fs.writeFileSync(tAbs, stub);
    let t0 = Date.now(); const r1 = run(cmd, [], { cwd: repo, shell: true, timeout }); out.blanked_fails = r1.code !== 0; out.blanked_seconds = (Date.now() - t0) / 1000; out.blanked_tail = (r1.out + r1.err).slice(-800);
    restore();
    t0 = Date.now(); const r2 = run(cmd, [], { cwd: repo, shell: true, timeout }); out.restored_passes = r2.code === 0; out.restored_seconds = (Date.now() - t0) / 1000; out.restored_tail = (r2.out + r2.err).slice(-800);
    out.verdict = out.blanked_fails && out.restored_passes ? 'pinned' : !out.restored_passes ? 'broken' : 'not-pinned';
    out.note = { pinned: 'the test fails when the target is blanked and passes when restored — it pins the target', 'not-pinned': 'the test still passes with the target blanked — it does not exercise that module (assert on its real outputs)', broken: 'the test does not pass on the current code — fix that first' }[out.verdict];
    return out;
  } finally { restore(); }
}
module.exports = { pinCheck, singleTestCmd };
