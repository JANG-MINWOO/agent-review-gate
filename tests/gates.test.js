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

test('worktree: untracked new files appear in the diff/stat/packet; fingerprint is identical untracked → staged → committed', () => {
  const { diffText, diffStat, worktreeDiffHash } = require('../src/git'); const { buildPacket } = require('../src/reviewer');
  const repo = fixture(); git(['checkout', '-q', '-b', 'work', 'main'], repo);
  write(repo, 'tests/mul.test.js', "const assert = require('node:assert'); const test = (n, f) => f(); const { mul } = require('../src/add');\ntest('multiplies', () => { assert.strictEqual(mul(2, 3), 6); });\n");
  write(repo, 'node_modules/dep/index.js', 'module.exports = 1;\n');   // never part of a review
  const d = diffText(repo, 'main', 'WORKTREE'); assert.match(d, /\+\+\+ b\/tests\/mul\.test\.js/); assert.match(d, /\+test\('multiplies'/); assert.doesNotMatch(d, /node_modules/);
  assert.match(diffStat(repo, 'main', 'WORKTREE'), /tests\/mul\.test\.js \| 2 \+  \(new, untracked\)/);
  const pk = buildPacket(repo, 'main', 'WORKTREE', 'add mul', {}, 100000, 10); assert.strictEqual(pk.meta.files, 1); assert.match(pk.packet, /\+test\('multiplies'/);
  const h1 = worktreeDiffHash(repo, 'main').hash; git(['add', '-A'], repo); const h2 = worktreeDiffHash(repo, 'main').hash;
  commitAll(repo, 'mul test'); const h3 = worktreeDiffHash(repo, 'main').hash;
  assert.ok(h1); assert.strictEqual(h1, h2, 'git add must not change the fingerprint'); assert.strictEqual(h2, h3, 'commit must not change the fingerprint');
  write(repo, 'tests/mul.test.js', "// edited\n"); assert.notStrictEqual(worktreeDiffHash(repo, 'main').hash, h3, 'content change must change the fingerprint');
});

test('reviewer role: the guard stands down for REVIEW_GATE_ROLE=reviewer; environment failure is detected from the reviewer output', () => {
  const { environmentFailure } = require('../src/reviewer');
  const repo = fixture(); setPhase(repo, 'implement');
  const hook = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'tests/add.test.js') }, cwd: repo });
  assert.strictEqual(guardTests(hook).code, 2);
  process.env.REVIEW_GATE_ROLE = 'reviewer'; try { assert.strictEqual(guardTests(hook).code, 0); } finally { delete process.env.REVIEW_GATE_ROLE; }
  assert.ok(environmentFailure({ raw: '' }, { verdict: 'unsure', summary: 'inspection failed because the sandbox could not start (bwrap: Operation not permitted)', findings: [] }));
  assert.strictEqual(environmentFailure({ raw: 'ran 12 commands fine' }, { verdict: 'pass', summary: 'all good', findings: [] }), null);
});

test('mcp: initialize / tools/list / tools/call over newline-delimited JSON-RPC, several messages in one chunk', async () => {
  const { serve, TOOLS } = require('../src/mcp'); const { PassThrough } = require('node:stream');
  const repo = fixture(); write(repo, 'src/add.js', "'use strict';\nmodule.exports = { add: (a, b) => a + b, mul: (a, b) => a * b };\n");
  const inp = new PassThrough(), out = new PassThrough(); let text = ''; out.on('data', c => { text += c; });
  serve(inp, out);
  const msgs = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lint_tests', arguments: { repo, worktree: true } } }, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'phase', arguments: { repo, set: 'implement' } } }, { jsonrpc: '2.0', id: 5, method: 'nope' }];
  inp.write(msgs.map(m => JSON.stringify(m)).join('\n') + '\n');
  await new Promise(r => setTimeout(r, 200));
  const replies = text.trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(replies.length, 5, 'one reply per request (none for the notification)');
  assert.strictEqual(replies[0].result.serverInfo.name, 'review-gate');
  assert.deepStrictEqual(replies[1].result.tools.map(t => t.name), TOOLS.map(t => t.name));
  assert.strictEqual(replies[2].result.structuredContent.level, 'clean');
  assert.strictEqual(replies[3].result.structuredContent.phase, 'implement');
  assert.strictEqual(replies[4].error.code, -32601);
});

test('env-check: a test that assumes a variable is absent is env-dependent (culprit bisected); an indifferent test is clean', () => {
  const { envCheck } = require('../src/envcheck');
  const repo = fixture();
  write(repo, 'src/cfg.js', "module.exports = { url: () => process.env.APP_URL || 'https://prod', mode: () => process.env.APP_MODE || 'x', other: () => process.env.UNUSED_FLAG };\n");
  write(repo, 'tests/cfg.test.js', "const assert = require('node:assert'); const test = (n, f) => f(); const { url } = require('../src/cfg');\ntest('prod url', () => { assert.strictEqual(url(), 'https://prod'); });\n");
  write(repo, 'tests/run.js', "require('./add.test.js');\n");   // keep the suite runner out of it; we run single files
  const bad = envCheck(repo, 'tests/cfg.test.js', { cmd: 'node {file}' });
  assert.strictEqual(bad.verdict, 'env-dependent', JSON.stringify(bad)); assert.deepStrictEqual(bad.culprits, ['APP_URL']);
  const good = envCheck(repo, 'tests/add.test.js', { cmd: 'node {file}' });
  assert.strictEqual(good.verdict, 'clean', JSON.stringify(good));
});

test('protectTree: a writable reviewer\'s edits are undone, the author\'s uncommitted work is kept', () => {
  const { protectTree } = require('../src/git');
  const repo = fixture();
  write(repo, 'src/add.js', "'use strict';\nmodule.exports = { add: (a, b) => a + b, mul: (a, b) => a * b };\n");   // author: modified tracked file
  write(repo, 'src/new.js', 'module.exports = 1;\n');                                                             // author: untracked file
  const restore = protectTree(repo);
  // "reviewer" misbehaves: edits the author's files, edits a clean file, creates a file, deletes the author's new file
  write(repo, 'src/add.js', 'BROKEN\n'); write(repo, 'tests/add.test.js', 'BROKEN\n'); write(repo, 'notes.md', 'reviewer note\n'); fs.unlinkSync(path.join(repo, 'src/new.js'));
  const undone = restore().sort();
  assert.deepStrictEqual(undone, ['notes.md', 'src/add.js', 'src/new.js', 'tests/add.test.js']);
  assert.match(fs.readFileSync(path.join(repo, 'src/add.js'), 'utf8'), /mul: \(a, b\) => a \* b/, 'author edit kept');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'src/new.js'), 'utf8'), 'module.exports = 1;\n', 'author untracked file restored');
  assert.match(fs.readFileSync(path.join(repo, 'tests/add.test.js'), 'utf8'), /adds/, 'clean tracked file back to HEAD');
  assert.ok(!fs.existsSync(path.join(repo, 'notes.md')), 'reviewer-created file removed');
  assert.deepStrictEqual(restore(), [], 'idempotent');
});
