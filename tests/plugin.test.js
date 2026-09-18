'use strict';
// plugin/ is generated from adapters/claude-plugin/ — this test fails when someone edits the sources and forgets `node scripts/build-plugin.js`.
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { build } = require('../scripts/build-plugin');

test('plugin/ is in sync with adapters/claude-plugin/ and the manifests point at it', () => {
  const root = path.join(__dirname, '..'); const before = snapshot(path.join(root, 'plugin'));
  build(); const after = snapshot(path.join(root, 'plugin'));
  assert.deepStrictEqual(after, before, 'plugin/ is stale — run: node scripts/build-plugin.js');
  for (const f of Object.keys(after)) assert.ok(!after[f].includes('__RG__'), f + ' still contains __RG__');
  const pj = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(root, pj.skills)), 'plugin.json skills path'); assert.ok(fs.existsSync(path.join(root, pj.hooks)), 'plugin.json hooks path');
  const mp = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.strictEqual(mp.plugins[0].name, pj.name); assert.strictEqual(mp.plugins[0].version, pj.version);
  assert.strictEqual(pj.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, 'plugin.json and package.json versions differ');
  const hooks = JSON.parse(fs.readFileSync(path.join(root, pj.hooks), 'utf8')).hooks;
  for (const ev of ['SessionStart', 'PreToolUse', 'Stop']) assert.ok(hooks[ev] && hooks[ev].length, ev + ' hook missing');
  assert.ok(fs.statSync(path.join(root, 'bin', 'review-gate')).mode & 0o111, 'bin/review-gate must be executable');
});
function snapshot(dir) { const out = {}; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } })(dir); return out; }
