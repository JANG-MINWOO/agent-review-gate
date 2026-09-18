'use strict';
// Deterministic gates on a throwaway fixture repository (node:test, no deps). Each scenario is a branch off `base`.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { lintTests } = require('../src/lint'); const { redGreen } = require('../src/redgreen'); const { guardTests, setPhase } = require('../src/hooks');

const sh = (cmd, args, cwd, input) => { const p = spawnSync(cmd, args, { cwd, input, encoding: 'utf8' }); if (p.status !== 0) throw new Error(cmd + ' ' + args.join(' ') + '\n' + p.stderr); return p.stdout; };
const git = (args, cwd) => sh('git', args, cwd);
const write = (repo, rel, content) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), content); };
const commitAll = (repo, msg) => { git(['add', '-A'], repo); git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg], repo); };

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-fixture-')); git(['init', '-q', '-b', 'main'], repo);
  write(repo, 'src/add.js', "'use strict';\nmodule.exports = { add: (a, b) => a + b };\n");
  write(repo, 'tests/add.test.js', "const assert = require('node:assert'); const test = (n, f) => f(); const { add } = require('../src/add');\ntest('adds', () => { assert.strictEqual(add(1, 2), 3); });\n");
  write(repo, 'package.json', '{"name":"fx","scripts":{"test":"node tests/run.js"}}\n');
  write(repo, 'tests/run.js', "const fs = require('fs'), path = require('path');\nfor (const f of fs.readdirSync(__dirname)) if (f.endsWith('.test.js')) require(path.join(__dirname, f));\n");
  commitAll(repo, 'base'); return repo;
}
const TEST_CMD = 'node tests/run.js';   // plain runner (node --test refuses to nest inside the outer test process)
function branch(repo, name, mutate, msg = name) { git(['checkout', '-q', '-b', name, 'main'], repo); mutate(); commitAll(repo, msg); git(['checkout', '-q', 'main'], repo); return name; }

test('lint: clean change with a new pinning test → clean; red→green ok', () => {
  const repo = fixture();
  const b = branch(repo, 'good', () => {
    write(repo, 'src/add.js', "'use strict';\nmodule.exports = { add: (a, b) => a + b, mul: (a, b) => a * b };\n");
    write(repo, 'tests/add.test.js', "const assert = require('node:assert'); const test = (n, f) => f(); const { add, mul } = require('../src/add');\ntest('adds', () => { assert.strictEqual(add(1, 2), 3); });\ntest('multiplies', () => { assert.strictEqual(mul(2, 3), 6); });\n");
  });
  const lt = lintTests(repo, 'main', b); assert.strictEqual(lt.level, 'clean'); assert.strictEqual(lt.tests_changed, 1);
  const rg = redGreen(repo, 'main', b, TEST_CMD); assert.strictEqual(rg.verdict, 'ok', JSON.stringify(rg));
});

test('lint: skip()/only()/tautology/deleted test/test-env branch → hard', () => {
  const repo = fixture();
  const b = branch(repo, 'bad', () => {
    write(repo, 'tests/add.test.js', "const test = require('node:test'); const assert = require('node:assert'); const { add } = require('../src/add');\ntest.skip('adds', () => { assert.strictEqual(add(1, 2), 3); });\ntest('always', () => { expect(true).toBe(true); });\n");
    write(repo, 'src/add.js', "'use strict';\nconst add = (a, b) => process.env.NODE_ENV === 'test' ? 3 : a + b;\nmodule.exports = { add };\n");
  });
  const lt = lintTests(repo, 'main', b); assert.strictEqual(lt.level, 'hard');
  const msgs = lt.findings.map(f => f.msg).join(' | ');
  assert.match(msgs, /skip\(\) added/); assert.match(msgs, /tautological/); assert.match(msgs, /test-only environment/);
  const repo2 = fixture(); const b2 = branch(repo2, 'del', () => fs.rmSync(path.join(repo2, 'tests/add.test.js')));
  assert.strictEqual(lintTests(repo2, 'main', b2).findings[0].msg, 'test file deleted');
});

test('lint: fewer tests/asserts → soft; runner narrowed → hard', () => {
  const repo = fixture();
  const b = branch(repo, 'fewer', () => write(repo, 'tests/add.test.js', "const test = require('node:test'); const assert = require('node:assert');\ntest('noop', () => {});\n"));
  const lt = lintTests(repo, 'main', b); assert.strictEqual(lt.level, 'soft'); assert.match(lt.findings.map(f => f.msg).join('|'), /assertion count 1 → 0/);
  const b2 = branch(repo, 'narrow', () => write(repo, 'package.json', '{"name":"fx","scripts":{"test":"node --test tests/ --testPathPattern add"}}\n'));
  assert.strictEqual(lintTests(repo, 'main', b2).level, 'hard');
});

test('red→green: test that already passes on base → not-red; broken implementation → not-green; no test change → no-tests', () => {
  const repo = fixture();
  const notRed = branch(repo, 'notred', () => write(repo, 'tests/add.test.js', "const assert = require('node:assert'); const test = (n, f) => f(); const { add } = require('../src/add');\ntest('adds', () => { assert.strictEqual(add(1, 2), 3); });\ntest('adds zero', () => { assert.strictEqual(add(0, 0), 0); });\n"));
  assert.strictEqual(redGreen(repo, 'main', notRed, TEST_CMD).verdict, 'not-red');
  const notGreen = branch(repo, 'notgreen', () => {
    write(repo, 'tests/add.test.js', "const assert = require('node:assert'); const test = (n, f) => f(); const { add, mul } = require('../src/add');\ntest('multiplies', () => { assert.strictEqual(mul(2, 3), 6); });\n");
    write(repo, 'src/add.js', "'use strict';\nmodule.exports = { add: (a, b) => a + b, mul: (a, b) => a + b };\n");
  });
  assert.strictEqual(redGreen(repo, 'main', notGreen, TEST_CMD).verdict, 'not-green');
  const refactor = branch(repo, 'refactor', () => write(repo, 'src/add.js', "'use strict';\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n"));
  assert.strictEqual(redGreen(repo, 'main', refactor, TEST_CMD).verdict, 'no-tests');
  assert.strictEqual(sh('git', ['worktree', 'list'], repo).trim().split('\n').length, 1, 'worktrees cleaned up');
});

test('guard: implement phase blocks test edits (Edit tool and shell writes), test phase allows', () => {
  const repo = fixture();
  const hook = (tool, input) => JSON.stringify({ tool_name: tool, tool_input: input, cwd: repo });
  assert.strictEqual(guardTests(hook('Edit', { file_path: path.join(repo, 'tests/add.test.js') })).code, 0, 'test phase: allowed');
  setPhase(repo, 'implement');
  assert.strictEqual(guardTests(hook('Edit', { file_path: path.join(repo, 'tests/add.test.js') })).code, 2);
  assert.strictEqual(guardTests(hook('Write', { file_path: path.join(repo, 'package.json') })).code, 2, 'runner file locked');
  assert.strictEqual(guardTests(hook('Edit', { file_path: path.join(repo, 'src/add.js') })).code, 0, 'production file allowed');
  assert.strictEqual(guardTests(hook('Bash', { command: "sed -i 's/adds/x/' tests/add.test.js" })).code, 2);
  assert.strictEqual(guardTests(hook('Bash', { command: 'node --test tests/' })).code, 0, 'running tests is fine');
});
