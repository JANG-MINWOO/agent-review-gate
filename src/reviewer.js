'use strict';
// Reviewer = a fresh CLI process (claude -p / codex exec) that only sees the review packet, never the author's session.
// --reviewer auto: the OTHER CLI if installed, else a fresh session of the same CLI (not everyone pays for both).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { run, git, diffStat, diffText, changedFiles, isTestPath } = require('./git');

const LIB = path.join(__dirname, '..', 'lib');
const RUBRIC = path.join(LIB, 'rubric.md'), SCHEMA = path.join(LIB, 'verdict.schema.json');
const which = cmd => run(process.platform === 'win32' ? 'where' : 'which', [cmd]).code === 0;
function detectClis() { return { claude: which('claude'), codex: which('codex') }; }
function pickReviewer(mode, author) {
  const have = detectClis();
  if (mode === 'claude' || mode === 'codex') { if (!have[mode]) throw new Error(`${mode} CLI not installed`); return mode; }
  if (mode === 'same') { if (!have[author]) throw new Error(`${author} CLI not installed`); return author; }
  const other = author === 'claude' ? 'codex' : 'claude';
  if (have[other]) return other;
  if (have[author]) return author;
  throw new Error('no reviewer CLI found (claude or codex)');
}

function buildPacket(repo, base, head, intent, checks, maxChars, maxTurns) {
  const stat = diffStat(repo, base, head), files = changedFiles(repo, base, head), diff = diffText(repo, base, head);
  const testFiles = files.filter(f => isTestPath(f.path)).map(f => f.path);
  if (!intent) {
    const log = git(['log', '--no-merges', '--format=- %s%n%b', `${base}..${head === 'WORKTREE' ? 'HEAD' : head}`], repo).out.trim();
    intent = log || '(no intent given — infer it from the diff and say so under "checked")';
  }
  const parts = ['# Review packet', '', `Repository: ${repo} (your working directory). Read-only except running its tests.`, (maxTurns ? `(You have a budget of about ${maxTurns} tool calls. Open what you need, run the relevant tests if you can, then stop and answer — the final message must be the JSON verdict.)` : ''), '', '## Intent of the change', intent.trim(), '', '## Changed files', stat.trim() || '(empty)', '',
    '## Changed test files', testFiles.map(p => '- ' + p).join('\n') || '- none (no test changes — note that in your verdict)', ''];
  if (checks && Object.keys(checks).length) parts.push('## Deterministic checks already run', '```json', JSON.stringify(checks, null, 1), '```', '');
  if (diff.length > maxChars) parts.push('## Diff', `(diff is ${diff.length.toLocaleString()} chars — truncated to ${maxChars.toLocaleString()}. Open the remaining files with your read tools; the file list above is complete.)`, '```diff', diff.slice(0, maxChars), '```');
  else parts.push('## Diff', '```diff', diff, '```');
  return { packet: parts.join('\n'), meta: { files: files.length, test_files: testFiles.length, diff_chars: diff.length } };
}

function extractJson(text) {
  let t = (text || '').trim();
  const m = t.match(/```json\s*([\s\S]*?)```/); if (m) t = m[1];
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('no JSON object in reviewer output');
  return JSON.parse(t.slice(s, e + 1));
}

// The reviewer process gets none of the author's project context: `--setting-sources user` loads the user's own settings (auth env,
// proxy, model defaults) but no project settings, hooks, commands or CLAUDE.md (verified 2026-09-18: with `project` the reviewer read
// the repo's review-gate rules, tried to run the review itself and hit the Stop gate; `user` and "" both leave CLAUDE.md out).
// REVIEW_GATE_ROLE=reviewer makes our own hooks stand down if a user-level settings file wires them.
const reviewerEnv = () => Object.assign({}, process.env, { REVIEW_GATE_ROLE: 'reviewer' });
function runClaude(repo, packet, o) {
  const args = ['-p', '--output-format', 'json', '--strict-mcp-config', '--setting-sources', 'user', '--no-session-persistence',
    '--system-prompt', fs.readFileSync(RUBRIC, 'utf8'), '--max-turns', String(o.maxTurns || 25), '--allowedTools', o.allowedTools, ...(o.model ? ['--model', o.model] : []), ...(o.extra || [])];
  const p = run('claude', args, { cwd: repo, input: packet, timeout: (o.timeoutSec || 1800) * 1000, env: reviewerEnv() });
  let text = p.out, meta = {};
  try { const j = JSON.parse(p.out); text = j.result || ''; meta = { cost_usd: j.total_cost_usd, duration_ms: j.duration_ms, turns: j.num_turns, model: j.model || o.model, is_error: j.is_error, subtype: j.subtype, terminal_reason: j.terminal_reason }; } catch { meta = { model: o.model }; }
  return { text, meta, raw: p.out + '\n--- stderr ---\n' + p.err.slice(-3000), code: p.code };
}
// Deterministic pre-flight: `codex sandbox -- true` runs a no-op under the same sandbox codex exec would use. On Linux hosts without
// user namespaces it fails with "bwrap: ... Operation not permitted" — and codex's JSON stream never reports the failed spawns, the model
// just writes "unsure". Probing first costs ~1s and no model call.
function codexSandboxError(sandbox) {
  if (sandbox === 'danger-full-access') return null;
  const p = run('codex', ['sandbox', '--', 'true'], { timeout: 30000 });
  if (p.code === 0) return null;
  // Only a recognisable sandbox failure counts. An unknown subcommand (older codex), a usage error or a platform quirk must not
  // silently demote the Codex reviewer — in that case we proceed and rely on the post-hoc signature check.
  const msg = (p.err || p.out).trim().split('\n').filter(Boolean).pop() || '';
  return /bwrap|bubblewrap|landlock|seatbelt|sandbox-exec|sandbox/i.test(msg) && !/unrecognized|unexpected argument|usage:/i.test(msg) ? msg : null;
}
function runCodex(repo, packet, o) {
  const sb = codexSandboxError(o.sandbox || 'read-only');
  if (sb) return { text: '', meta: { env_fail: sb, model: o.model }, raw: 'sandbox pre-flight failed: ' + sb, code: -1 };
  const outf = path.join(os.tmpdir(), `review-gate-out-${process.pid}-${Date.now()}.json`);
  const prompt = fs.readFileSync(RUBRIC, 'utf8') + '\n\n' + packet;
  const args = ['exec', '--json', '--skip-git-repo-check', '--output-schema', SCHEMA, '-s', o.sandbox || 'read-only', '-o', outf, '-C', repo, ...(o.model ? ['-m', o.model] : []), ...(o.extra || []), '-'];
  const p = run('codex', args, { cwd: repo, input: prompt, timeout: (o.timeoutSec || 1800) * 1000, env: reviewerEnv() });
  let text = fs.existsSync(outf) ? fs.readFileSync(outf, 'utf8') : ''; try { fs.unlinkSync(outf); } catch {}
  let usage = {};
  for (const line of p.out.split('\n')) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'turn.completed' && ev.usage) usage = ev.usage;
    if (!text && ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message') text = ev.item.text || text;
  }
  return { text, meta: { usage, model: o.model }, raw: p.out.slice(-6000) + '\n--- stderr ---\n' + p.err.slice(-3000), code: p.code };
}
// A reviewer that could not work is not a verdict. Signatures seen so far: Codex's Linux sandbox (bubblewrap) refused on hosts without
// user namespaces — the model then answers "unsure" because every command failed (2026-09-18).
const ENV_FAIL = /bwrap:.*Operation not permitted|sandbox (could not|couldn't|failed to|cannot|can't) (start|be (created|initiali[sz]ed)|initiali[sz]e)|failed to (start|create|set up) (the )?sandbox|Landlock.*(unsupported|not supported)/i;
function environmentFailure(r, verdict) {
  if (r.meta && r.meta.env_fail) return r.meta.env_fail;
  const text = (r.raw || '') + ' ' + JSON.stringify(verdict || {});
  const m = text.match(ENV_FAIL); return m ? m[0] : null;
}
module.exports = { detectClis, pickReviewer, buildPacket, extractJson, runClaude, runCodex, environmentFailure, codexSandboxError, RUBRIC, SCHEMA };
