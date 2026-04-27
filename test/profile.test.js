'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  deepMerge,
  validateProfile,
  applyJsonPatch,
  evaluatePatch,
  suggestPatchFromEvent
} = require('../src/profile');
const { initWorkspace, loadProfiles, statePath } = require('../src/state');

test('deepMerge appends overlay arrays for rules and memory', () => {
  const merged = deepMerge(
    { rules: ['base'], memory: { lessons: ['old'] } },
    { rules: ['overlay'], memory: { lessons: ['new'] } }
  );
  assert.deepEqual(merged.rules, ['base', 'overlay']);
  assert.deepEqual(merged.memory.lessons, ['old', 'new']);
});

test('applyJsonPatch supports add replace remove', () => {
  const doc = { rules: ['a'], growth: { max_patch_ops: 3 } };
  const next = applyJsonPatch(doc, [
    { op: 'add', path: '/rules/-', value: 'b' },
    { op: 'replace', path: '/growth/max_patch_ops', value: 4 },
    { op: 'remove', path: '/rules/0' }
  ]);
  assert.deepEqual(next, { rules: ['b'], growth: { max_patch_ops: 4 } });
});

test('applyJsonPatch creates missing array parents for add', () => {
  const next = applyJsonPatch({}, [
    { op: 'add', path: '/memory/lessons/-', value: 'learned' }
  ]);
  assert.deepEqual(next, { memory: { lessons: ['learned'] } });
});

test('loadProfiles backfills new default tool policies for old base profiles', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sicli-profile-'));
  await initWorkspace(root);
  const basePath = statePath(root, 'base.profile.json');
  const base = JSON.parse(await fs.readFile(basePath, 'utf8'));
  delete base.tool_policy.write_file;
  await fs.writeFile(basePath, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  const { active } = await loadProfiles(root);
  assert.equal(active.tool_policy.write_file, 'allow');
});

test('growth none forbids mutation', () => {
  const profile = validProfile({ level: 'none', auto_apply: false });
  const result = evaluatePatch(profile, [{ op: 'add', path: '/rules/-', value: 'x' }], { manual: true });
  assert.equal(result.allowed, false);
});

test('medium auto applies safe rules when enabled', () => {
  const profile = validProfile({ level: 'medium', auto_apply: true });
  const result = evaluatePatch(profile, [{ op: 'add', path: '/rules/-', value: 'x' }]);
  assert.equal(result.allowed, true);
  assert.equal(result.auto, true);
});

test('growth gate protects self-escalation', () => {
  const profile = validProfile({ level: 'very_high', auto_apply: true });
  const result = evaluatePatch(profile, [{ op: 'replace', path: '/growth/level', value: 'very_high' }]);
  assert.equal(result.allowed, false);
});

test('suggestPatchFromEvent detects edit-before-read failure', () => {
  const suggestion = suggestPatchFromEvent({ message: 'edited file without reading context first' });
  assert.equal(suggestion.patch.length, 2);
  assert.equal(suggestion.patch[0].path, '/rules/-');
});

function validProfile(growth) {
  const profile = {
    id: 'test',
    version: 1,
    style: { language: 'auto', verbosity: 'low', format: 'concise' },
    rules: [],
    tool_policy: {},
    memory: { user_preferences: [], project_facts: [], lessons: [] },
    growth: { requires_eval: true, max_patch_ops: 3, rollback: true, ...growth },
    harness: {
      max_tool_turns: 8,
      max_tool_turns_autonomous: 50,
      max_history_messages: 20,
      compact_tool_results: true,
      compact_limit: 12000,
      context_strategy: 'full',
      autonomous_mode: false,
      failure_recovery: { retry_on_tool_error: false, max_retries: 0, switch_tool_after_2_failures: false },
      safety_review: { enabled: false }
    }
  };
  validateProfile(profile);
  return profile;
}
