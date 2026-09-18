'use strict';
// `review-gate mcp` — the same gates as MCP tools over stdio, for agents that speak MCP but are not Claude Code (Cursor, Codex with
// mcp_servers, custom harnesses). Zero dependencies: newline-delimited JSON-RPC 2.0, the subset of MCP a tool server needs
// (initialize, ping, tools/list, tools/call). MCP cannot *enforce* anything — hooks do that — it is the door other agents call through.
const path = require('node:path');
const { repoRoot, resolveRange } = require('./git');
const { readConfig } = require('./init');

const PROTOCOL = '2025-06-18';
const TOOLS = [
  { name: 'review', description: 'Independent review of a change by a fresh CLI session (claude -p or codex exec). Returns the verdict (pass/fail/unsure), fact/taste findings with evidence, and the deterministic check results. Defaults: uncommitted working tree vs merge-base of main.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'repository path (default: cwd)' }, base: { type: 'string' }, head: { type: 'string', description: 'commit/branch, or omit with worktree=true' }, worktree: { type: 'boolean', description: 'review uncommitted work (default true when head is omitted)' }, intent: { type: 'string', description: 'what the change is supposed to do (text)' }, reviewer: { type: 'string', enum: ['auto', 'claude', 'codex', 'same'] }, model: { type: 'string' }, test_cmd: { type: 'string', description: 'also run red→green with this command' } } } },
  { name: 'lint_tests', description: 'Deterministic test-integrity lint of a diff: skipped/only/deleted tests, tautological asserts, narrowed runner config, test-only branches in production code. Levels: clean / soft / hard.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, worktree: { type: 'boolean' } } } },
  { name: 'red_green', description: 'Verify that the tests in a change fail on the base code (red) and pass on the new code (green), in a throwaway worktree.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, worktree: { type: 'boolean' }, test_cmd: { type: 'string', description: 'test command (default: .review-gate/config.json testCmd)' } } } },
  { name: 'audit', description: 'Whole-repository test-health inventory: runner, test↔source map, untested modules ranked by size×exports, weak tests, CI/coverage presence. Feed it to a session that writes docs/test-audit.md.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, run_tests: { type: 'boolean' }, top: { type: 'number' } } } },
  { name: 'pin_check', description: 'Does a test really pin its target module? Blanks the target, runs the test (must fail), restores it, runs again (must pass). Verdict: pinned / not-pinned / broken.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, test: { type: 'string' }, target: { type: 'string' }, cmd: { type: 'string', description: 'runner override with {file} placeholder' } }, required: ['test', 'target'] } },
  { name: 'phase', description: 'Read or set the TDD phase: "test" (tests editable) or "implement" (test files locked by the hook).',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, set: { type: 'string', enum: ['test', 'implement'] } } } },
];

function callTool(name, a = {}) {
  const repo = repoRoot(a.repo || '.'); const cfg = readConfig(repo);
  const range = () => { let [base, head] = resolveRange(repo, a.base, a.head); if (a.worktree || (!a.head && a.worktree !== false)) head = 'WORKTREE'; return [base, head]; };
  if (name === 'review') {
    const { review } = require('./review'); const [base, head] = range();
    const res = review({ repo, base, head: head === 'WORKTREE' ? undefined : head, worktree: head === 'WORKTREE', reviewer: a.reviewer || cfg.reviewer || 'auto', author: cfg.author || 'claude', model: a.model || cfg.model || undefined, intentText: a.intent || null, testCmd: a.test_cmd || undefined, maxDiffChars: cfg.maxDiffChars || 120000, maxTurns: cfg.maxTurns || 40, sandbox: cfg.codexSandbox || 'read-only', allowedTools: 'Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git grep:*),Bash(git status:*),Bash(npm test:*),Bash(npx vitest run:*),Bash(npx jest:*),Bash(pytest:*),Bash(go test:*),Bash(cargo test:*)' });
    if (res.error) return { ok: false, error: res.error, tail: res.tail };
    if (res.skipped) return { ok: true, skipped: res.skipped };
    return { ok: true, verdict: res.verdict.verdict, summary: res.verdict.summary, findings: res.verdict.findings, good: res.verdict.good, checked: res.verdict.checked, checks: res.rec.checks, reviewer: res.rec.reviewer, fallback_from: res.rec.fallback_from, blocking: res.blocking, run_dir: res.runDir };
  }
  if (name === 'lint_tests') { const { lintTests } = require('./lint'); const [base, head] = range(); return lintTests(repo, base, head); }
  if (name === 'red_green') { const { redGreen } = require('./redgreen'); const [base, head] = range(); const tc = a.test_cmd || cfg.testCmd; if (!tc) return { ok: false, error: 'test_cmd required (or testCmd in .review-gate/config.json)' }; return redGreen(repo, base, head, tc); }
  if (name === 'audit') { const { audit } = require('./audit'); return audit(repo, { runTests: !!a.run_tests, top: a.top || 60 }); }
  if (name === 'pin_check') { const { pinCheck } = require('./pincheck'); return pinCheck(repo, a.test, a.target, { cmd: a.cmd }); }
  if (name === 'phase') { const { getPhase, setPhase } = require('./hooks'); if (a.set) setPhase(repo, a.set); return { phase: getPhase(repo) }; }
  throw new Error('unknown tool: ' + name);
}

function serve(input = process.stdin, output = process.stdout) {
  const send = m => output.write(JSON.stringify(m) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const handle = msg => {
    const { id, method, params } = msg;
    if (method === 'initialize') return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'review-gate', version: require('../package.json').version }, instructions: 'Tools: review (independent fresh-session review), lint_tests, red_green, audit, pin_check, phase. Run review before declaring a change done; act on fact findings.' });
    if (method && method.startsWith('notifications/')) return;
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params && params.name, args = (params && params.arguments) || {};
      try { const r = callTool(name, args); const text = typeof r === 'string' ? r : JSON.stringify(r, null, 1); return reply(id, { content: [{ type: 'text', text }], structuredContent: typeof r === 'object' ? r : { result: r }, isError: !!(r && r.ok === false) }); }
      catch (e) { return reply(id, { content: [{ type: 'text', text: 'review-gate: ' + e.message }], isError: true }); }
    }
    if (id !== undefined) fail(id, -32601, 'method not found: ' + method);
  };
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {   // one message per line; never `return` out of this loop — a chunk can carry several messages
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); continue; }
      handle(msg);
    }
  });
  input.on('end', () => process.exit(0));
}
module.exports = { serve, callTool, TOOLS };
