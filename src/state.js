'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { deepMerge, validateProfile, applyJsonPatch } = require('./profile');

const STATE_DIR = '.selfimprove';
const BASE_PROFILE = 'base.profile.json';
const OVERLAY_PROFILE = 'overlay.profile.json';
const EVENTS_LOG = 'events.jsonl';
const PATCHES_LOG = 'patches.jsonl';
const TRACES_LOG = 'traces.jsonl';
const OPTIMIZER_STATE = 'optimizer.json';

function statePath(root, file = '') {
  return path.join(root, STATE_DIR, file);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback = undefined) {
  if (!(await exists(file))) return fallback;
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function initWorkspace(root = process.cwd()) {
  const dir = statePath(root);
  await fs.mkdir(dir, { recursive: true });
  const defaultProfilePath = path.resolve(__dirname, '..', 'profiles', 'default.profile.json');
  const basePath = statePath(root, BASE_PROFILE);
  const overlayPath = statePath(root, OVERLAY_PROFILE);
  if (!(await exists(basePath))) {
    const base = await readJson(defaultProfilePath);
    validateProfile(base, 'default profile');
    await writeJson(basePath, base);
  }
  if (!(await exists(overlayPath))) {
    await writeJson(overlayPath, {
      style: {},
      rules: [],
      tool_policy: {},
      memory: {
        user_preferences: [],
        project_facts: [],
        lessons: []
      },
      growth: {}
    });
  }
  for (const file of [EVENTS_LOG, PATCHES_LOG, TRACES_LOG]) {
    const target = statePath(root, file);
    if (!(await exists(target))) await fs.writeFile(target, '', 'utf8');
  }
  return dir;
}

function applyDefaults(value, defaults) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const next = { ...value };
    for (const [key, defaultValue] of Object.entries(defaults)) {
      if (next[key] === undefined) next[key] = defaultValue;
      else next[key] = applyDefaults(next[key], defaultValue);
    }
    return next;
  }
  return value === undefined ? defaults : value;
}

async function loadProfiles(root = process.cwd()) {
  await initWorkspace(root);
  const defaultProfilePath = path.resolve(__dirname, '..', 'profiles', 'default.profile.json');
  const defaults = await readJson(defaultProfilePath);
  const baseRaw = await readJson(statePath(root, BASE_PROFILE));
  const overlay = await readJson(statePath(root, OVERLAY_PROFILE), {});
  const base = applyDefaults(baseRaw, defaults);
  validateProfile(base, 'base profile');
  const active = deepMerge(base, overlay);
  validateProfile(active, 'active profile');
  return { base, overlay, active };
}

async function saveOverlay(root, overlay) {
  const target = statePath(root, OVERLAY_PROFILE);
  if (await exists(target)) {
    const bak2 = target + '.bak.2';
    const bak1 = target + '.bak.1';
    const bak0 = target + '.bak.0';
    try { await fs.unlink(bak2); } catch {}
    try { await fs.rename(bak1, bak2); } catch {}
    try { await fs.rename(bak0, bak1); } catch {}
    try { await fs.copyFile(target, bak0); } catch {}
  }
  await writeJson(target, overlay);
}

async function appendJsonLine(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

async function appendEvent(root, event) {
  const record = {
    ts: new Date().toISOString(),
    ...event
  };
  await appendJsonLine(statePath(root, EVENTS_LOG), record);
  return record;
}

async function appendTrace(root, trace) {
  const record = {
    ts: new Date().toISOString(),
    ...trace
  };
  await appendJsonLine(statePath(root, TRACES_LOG), record);
  return record;
}

async function appendPatchAudit(root, audit) {
  const record = {
    ts: new Date().toISOString(),
    ...audit
  };
  await appendJsonLine(statePath(root, PATCHES_LOG), record);
  return record;
}

async function rollbackToBackup(root) {
  const bakPath = statePath(root, OVERLAY_PROFILE + '.bak');
  const curPath = statePath(root, OVERLAY_PROFILE);
  if (await exists(bakPath)) {
    await fs.copyFile(bakPath, curPath);
    return { reverted: true, source: 'backup' };
  }
  return { reverted: false, reason: 'no backup found' };
}

async function rollbackToBackupFromNumber(root, n = 0) {
  const bakPath = statePath(root, OVERLAY_PROFILE + '.bak.' + n);
  const curPath = statePath(root, OVERLAY_PROFILE);
  if (await exists(bakPath)) {
    await fs.copyFile(bakPath, curPath);
    return { reverted: true, source: 'backup.' + n };
  }
  return { reverted: false, reason: 'no backup found at .bak.' + n };
}

async function recordFailedPatch(root, patch, reason) {
  const optimizer = await readOptimizerState(root);
  const failed_patches = [...(optimizer.failed_patches || []), {
    patch,
    reason,
    failed_at: new Date().toISOString()
  }];
  await writeOptimizerState(root, { ...optimizer, failed_patches });
  return { recorded: true };
}

async function applyPatchToOverlay(root, patch) {
  const { base, overlay } = await loadProfiles(root);
  const nextOverlay = applyJsonPatch(overlay, patch);
  const active = deepMerge(base, nextOverlay);
  validateProfile(active, 'active profile after patch');
  const tmpPath = statePath(root, OVERLAY_PROFILE + '.tmp');
  await writeJson(tmpPath, nextOverlay);
  await fs.rename(tmpPath, statePath(root, OVERLAY_PROFILE));
  return { overlay: nextOverlay, active };
}

async function setGrowthLevel(root, level, options = {}) {
  const { overlay } = await loadProfiles(root);
  const growth = { level };
  if (typeof options.auto_apply === 'boolean') growth.auto_apply = options.auto_apply;
  const nextOverlay = deepMerge(overlay, { growth });
  await saveOverlay(root, nextOverlay);
  return loadProfiles(root);
}

async function countJsonLines(file) {
  if (!(await exists(file))) return 0;
  const raw = await fs.readFile(file, 'utf8');
  return raw.split(/\r?\n/).filter(Boolean).length;
}

async function readAllJsonLines(file, { limit = 10000 } = {}) {
  if (!(await exists(file))) return [];
  const raw = await fs.readFile(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= limit) return lines.map(line => JSON.parse(line));
  return lines.slice(-limit).map(line => JSON.parse(line));
}

async function readRecentJsonLines(file, limit = 20) {
  return (await readAllJsonLines(file, { limit })).slice(-limit);
}

async function readOptimizerState(root = process.cwd()) {
  return readJson(statePath(root, OPTIMIZER_STATE), { last_trace_count: 0, last_run_at: null });
}

async function writeOptimizerState(root, state) {
  await writeJson(statePath(root, OPTIMIZER_STATE), state);
  return state;
}

async function getSelfImproveStatus(root = process.cwd()) {
  const { active, overlay } = await loadProfiles(root);
  const eventsCount = await countJsonLines(statePath(root, EVENTS_LOG));
  const patchesCount = await countJsonLines(statePath(root, PATCHES_LOG));
  const tracesCount = await countJsonLines(statePath(root, TRACES_LOG));
  const recentEvents = await readRecentJsonLines(statePath(root, EVENTS_LOG), 5);
  const recentPatches = await readRecentJsonLines(statePath(root, PATCHES_LOG), 5);
  const recentTraces = await readRecentJsonLines(statePath(root, TRACES_LOG), 5);
  const optimizer = await readOptimizerState(root);
  return {
    growth: active.growth,
    files: {
      overlay: statePath(root, OVERLAY_PROFILE),
      events: statePath(root, EVENTS_LOG),
      patches: statePath(root, PATCHES_LOG),
      traces: statePath(root, TRACES_LOG),
      optimizer: statePath(root, OPTIMIZER_STATE)
    },
    counts: {
      events: eventsCount,
      patches: patchesCount,
      traces: tracesCount,
      overlay_rules: Array.isArray(overlay.rules) ? overlay.rules.length : 0,
      overlay_lessons: Array.isArray(overlay.memory?.lessons) ? overlay.memory.lessons.length : 0
    },
    optimizer,
    recent_events: recentEvents,
    recent_patches: recentPatches,
    recent_traces: recentTraces,
    next: active.growth.auto_apply
      ? 'Auto-apply is enabled when growth gate allows patch.'
      : 'Use `self-improve learn <message> --apply` or enable `growth medium --auto-apply true`.'
  };
}

async function getStatus(root = process.cwd()) {
  const { active } = await loadProfiles(root);
  const events = await readRecentJsonLines(statePath(root, EVENTS_LOG), 5);
  const patches = await readRecentJsonLines(statePath(root, PATCHES_LOG), 5);
  return {
    state_dir: statePath(root),
    profile: {
      id: active.id,
      version: active.version,
      growth: active.growth,
      rules: active.rules.length,
      lessons: active.memory.lessons.length
    },
    recent_events: events,
    recent_patches: patches
  };
}

module.exports = {
  STATE_DIR,
  statePath,
  initWorkspace,
  loadProfiles,
  saveOverlay,
  appendEvent,
  appendTrace,
  appendPatchAudit,
  applyPatchToOverlay,
  setGrowthLevel,
  readAllJsonLines,
  countJsonLines,
  readOptimizerState,
  writeOptimizerState,
  getSelfImproveStatus,
  getStatus,
  rollbackToBackup,
  rollbackToBackupFromNumber,
  recordFailedPatch
};
