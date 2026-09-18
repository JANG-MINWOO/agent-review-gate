'use strict';
// `review-gate init` — wires the tool into a project: .review-gate/config.json, Claude Code hooks (merged into
// .claude/settings.json), optional Codex hooks and GitHub Actions workflow. Idempotent: run it again after `npm update`.
const fs = require('node:fs'), path = require('node:path');
const { repoRoot } = require('./git');

const CMD = 'npx --no-install review-gate';
function detectTestCmd(repo) {
  try { const pj = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); if (pj.scripts && pj.scripts.test) return 'npm test --silent'; } catch {}
  for (const f of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']) if (fs.existsSync(path.join(repo, f))) return 'pytest -q';
  if (fs.existsSync(path.join(repo, 'go.mod'))) return 'go test ./...';
  if (fs.existsSync(path.join(repo, 'Cargo.toml'))) return 'cargo test';
  return null;
}
function readConfig(repo) { try { return JSON.parse(fs.readFileSync(path.join(repo, '.review-gate', 'config.json'), 'utf8')); } catch { return {}; } }
function mergeHooks(settings, ours) {
  settings.hooks = settings.hooks || {};
  for (const [event, entries] of Object.entries(ours)) {
    const cur = settings.hooks[event] || [];
    const kept = cur.filter(e => !(e.hooks || []).some(h => (h.command || '').includes('review-gate')));   // drop our previous entries, keep everything else
    settings.hooks[event] = [...kept, ...entries];
  }
  return settings;
}
function init(o) {
  const repo = repoRoot(o.repo || '.'); const dir = path.join(repo, '.review-gate'); fs.mkdirSync(dir, { recursive: true });
  const cfg = Object.assign({ reviewer: 'auto', author: 'claude', testCmd: detectTestCmd(repo), onStop: 'checks', block: false, maxDiffChars: 120000, model: null, codexSandbox: 'read-only' }, readConfig(repo), o.set || {});
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  const gi = path.join(dir, '.gitignore'); if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'runs/\nphase\n');
  const done = ['.review-gate/config.json'];
  if (!o.noClaude) {
    const sdir = path.join(repo, '.claude'); fs.mkdirSync(sdir, { recursive: true }); const sp = path.join(sdir, 'settings.json');
    let settings = {}; try { settings = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch {}
    const ours = {
      PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: `${CMD} guard-tests`, timeout: 10 }] }],
      Stop: cfg.onStop === 'off' ? [] : [{ hooks: [{ type: 'command', command: `${CMD} on-stop`, timeout: cfg.onStop === 'review' ? 1800 : 600 }] }],
    };
    fs.writeFileSync(sp, JSON.stringify(mergeHooks(settings, ours), null, 2) + '\n'); done.push('.claude/settings.json (hooks merged)');
    const cdir = path.join(sdir, 'commands'); fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'review.md'), fs.readFileSync(path.join(__dirname, '..', 'adapters', 'claude-plugin', 'commands', 'review.md'), 'utf8')); done.push('.claude/commands/review.md');
  }
  if (o.codex) {
    const cdir = path.join(repo, '.codex'); fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'review-gate.md'), fs.readFileSync(path.join(__dirname, '..', 'adapters', 'codex', 'SKILL.md'), 'utf8')); done.push('.codex/review-gate.md (skill; see adapters/codex/README.md for hooks)');
  }
  if (o.ci) {
    const wdir = path.join(repo, '.github', 'workflows'); fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'review-gate.yml'), fs.readFileSync(path.join(__dirname, '..', 'adapters', 'ci', 'review-gate.yml'), 'utf8')); done.push('.github/workflows/review-gate.yml');
  }
  return { repo, cfg, done };
}
module.exports = { init, readConfig, detectTestCmd, mergeHooks };
