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
  // --target <subdir>: the git repo to review lives below the directory Claude Code runs in (e.g. context-repo/ai-board-game).
  // Config + ledger go into the target repo; hooks and the /review command go into the cwd project (that is where Claude Code reads
  // .claude/settings.json), with `--repo <target>` baked into every command so the gates act on the right repository.
  const cwd = path.resolve(o.cwd || '.'); const target = o.target ? path.resolve(cwd, o.target) : null;
  const repo = repoRoot(target || o.repo || '.'); const dir = path.join(repo, '.review-gate'); fs.mkdirSync(dir, { recursive: true });
  const rel = target ? path.relative(cwd, repo) : ''; const R = rel ? ` --repo ${JSON.stringify(rel)}` : '';
  const home = target ? cwd : repo;   // where hooks/commands are written
  const cfg = Object.assign({ reviewer: 'auto', author: 'claude', testCmd: detectTestCmd(repo), onStop: 'gate', block: false, maxDiffChars: 120000, model: null, codexSandbox: process.platform === 'darwin' ? 'workspace-write' : 'read-only' }, readConfig(repo), o.set || {});   // macOS seatbelt: let the Codex reviewer run the tests (writes stay inside the repo and are undone afterwards); Linux read-only
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  const gi = path.join(dir, '.gitignore'); if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'runs/\nphase\nstop-strikes.json\n');
  const done = ['.review-gate/config.json'];
  if (!o.noClaude) {
    const sdir = path.join(home, '.claude'); fs.mkdirSync(sdir, { recursive: true }); const sp = path.join(sdir, 'settings.json');
    let settings = {}; try { settings = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch {}
    // npx must find the package: when the target holds node_modules, run npx from there (--prefix) so the cwd project needs no package.json
    const NPX = rel ? `npx --no-install --prefix ${JSON.stringify(rel)} review-gate` : CMD;
    const ours = {
      PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: `${NPX} guard-tests${R}`, timeout: 10 }] }],
      Stop: cfg.onStop === 'off' ? [] : [{ hooks: [{ type: 'command', command: `${NPX} on-stop${R}`, timeout: cfg.onStop === 'review' ? 1800 : 600 }] }],
    };
    fs.writeFileSync(sp, JSON.stringify(mergeHooks(settings, ours), null, 2) + '\n'); done.push(path.relative(cwd, sp) + ' (hooks merged' + (rel ? `, targeting ${rel}` : '') + ')');
    // slash commands: /review (natural language), /review-gate:audit, /review-gate:backfill — `__RG__` becomes the right invocation for this layout
    const RG = `${NPX}${R}`; const srcCmds = path.join(__dirname, '..', 'adapters', 'claude-plugin', 'commands'); const cdir = path.join(sdir, 'commands');
    const copyCmd = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, fs.readFileSync(from, 'utf8').split('__RG__').join(RG)); done.push(path.relative(cwd, to)); };
    copyCmd(path.join(srcCmds, 'review.md'), path.join(cdir, 'review.md'));
    for (const f of fs.readdirSync(path.join(srcCmds, 'review-gate'))) copyCmd(path.join(srcCmds, 'review-gate', f), path.join(cdir, 'review-gate', f));
    // session rules: CLAUDE.md snippet between markers (idempotent) in the cwd project
    const snippet = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'claude-plugin', 'CLAUDE-snippet.md'), 'utf8').split('__RG__').join(RG);
    const cm = path.join(home, 'CLAUDE.md'); let cur = ''; try { cur = fs.readFileSync(cm, 'utf8'); } catch {}
    const re = /<!-- review-gate:start -->[\s\S]*?<!-- review-gate:end -->\n?/;
    const next = re.test(cur) ? cur.replace(re, snippet) : (cur ? cur.replace(/\s*$/, '\n\n') : '') + snippet;
    fs.writeFileSync(cm, next); done.push(path.relative(cwd, cm) + ' (review-gate section)');
  }
  if (o.codex) {
    const cdir = path.join(repo, '.codex'); fs.mkdirSync(cdir, { recursive: true });
    fs.writeFileSync(path.join(cdir, 'review-gate.md'), fs.readFileSync(path.join(__dirname, '..', 'adapters', 'codex', 'SKILL.md'), 'utf8')); done.push('.codex/review-gate.md (skill; see adapters/codex/README.md for hooks)');
  }
  if (o.ci) {
    const wdir = path.join(repo, '.github', 'workflows'); fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'review-gate.yml'), fs.readFileSync(path.join(__dirname, '..', 'adapters', 'ci', 'review-gate.yml'), 'utf8')); done.push('.github/workflows/review-gate.yml');
  }
  return { repo, cfg, done, home };
}
module.exports = { init, readConfig, detectTestCmd, mergeHooks };
