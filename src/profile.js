'use strict';

const GROWTH_LEVELS = new Set(['none', 'low', 'medium', 'high', 'very_high']);
const HEAVY_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.cache']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, overlay) {
  const left = clone(base) || {};
  const right = clone(overlay) || {};
  if (!isPlainObject(left) || !isPlainObject(right)) return right;
  for (const [key, value] of Object.entries(right)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && Array.isArray(left[key])) {
      left[key] = [...clone(left[key]), ...clone(value)];
    } else if (isPlainObject(value) && isPlainObject(left[key])) {
      left[key] = deepMerge(left[key], value);
    } else {
      left[key] = clone(value);
    }
  }
  return left;
}

function validateProfile(profile, label = 'profile') {
  if (!isPlainObject(profile)) throw new Error(`${label} must be an object`);
  if (typeof profile.id !== 'string' || !profile.id) throw new Error(`${label}.id must be a non-empty string`);
  if (!Number.isInteger(profile.version) || profile.version < 1) throw new Error(`${label}.version must be a positive integer`);
  if (!isPlainObject(profile.style)) throw new Error(`${label}.style must be an object`);
  if (!Array.isArray(profile.rules)) throw new Error(`${label}.rules must be an array`);
  if (!isPlainObject(profile.tool_policy)) throw new Error(`${label}.tool_policy must be an object`);
  if (!isPlainObject(profile.memory)) throw new Error(`${label}.memory must be an object`);
  if (!isPlainObject(profile.growth)) throw new Error(`${label}.growth must be an object`);
  if (!GROWTH_LEVELS.has(profile.growth.level)) throw new Error(`${label}.growth.level must be one of ${Array.from(GROWTH_LEVELS).join(', ')}`);
  if (typeof profile.growth.auto_apply !== 'boolean') throw new Error(`${label}.growth.auto_apply must be boolean`);
  if (!Number.isInteger(profile.growth.max_patch_ops) || profile.growth.max_patch_ops < 0) throw new Error(`${label}.growth.max_patch_ops must be a non-negative integer`);
  if (!Array.isArray(profile.memory.user_preferences)) throw new Error(`${label}.memory.user_preferences must be an array`);
  if (!Array.isArray(profile.memory.project_facts)) throw new Error(`${label}.memory.project_facts must be an array`);
  if (!Array.isArray(profile.memory.lessons)) throw new Error(`${label}.memory.lessons must be an array`);
  if (!isPlainObject(profile.harness)) throw new Error(`${label}.harness must be an object`);
  if (!Number.isInteger(profile.harness.max_tool_turns) || profile.harness.max_tool_turns < 1) throw new Error(`${label}.harness.max_tool_turns must be positive integer`);
  if (!Number.isInteger(profile.harness.max_history_messages) || profile.harness.max_history_messages < 1) throw new Error(`${label}.harness.max_history_messages must be positive integer`);
  if (typeof profile.harness.compact_tool_results !== 'boolean') throw new Error(`${label}.harness.compact_tool_results must be boolean`);
  if (!Number.isInteger(profile.harness.compact_limit) || profile.harness.compact_limit < 1000) throw new Error(`${label}.harness.compact_limit must be integer >= 1000`);
  if (!isPlainObject(profile.harness.failure_recovery)) throw new Error(`${label}.harness.failure_recovery must be an object`);
  if (typeof profile.harness.failure_recovery.retry_on_tool_error !== 'boolean') throw new Error(`${label}.harness.failure_recovery.retry_on_tool_error must be boolean`);
  if (!Number.isInteger(profile.harness.failure_recovery.max_retries) || profile.harness.failure_recovery.max_retries < 0) throw new Error(`${label}.harness.failure_recovery.max_retries must be non-negative integer`);
  if (typeof profile.harness.failure_recovery.switch_tool_after_2_failures !== 'boolean') throw new Error(`${label}.harness.failure_recovery.switch_tool_after_2_failures must be boolean`);
  if (!isPlainObject(profile.harness.safety_review)) throw new Error(`${label}.harness.safety_review must be an object`);
  if (typeof profile.harness.safety_review.enabled !== 'boolean') throw new Error(`${label}.harness.safety_review.enabled must be boolean`);
  return true;
}

function compileProfilePrompt(profile) {
  validateProfile(profile, 'active profile');
  const lines = [];
  lines.push(`Profile: ${profile.id}@${profile.version}`);
  lines.push(`Style: language=${profile.style.language}; verbosity=${profile.style.verbosity}; format=${profile.style.format}`);
  lines.push('Rules:');
  for (const rule of profile.rules) lines.push(`- ${rule}`);
  lines.push('Tool policy:');
  for (const [tool, policy] of Object.entries(profile.tool_policy)) lines.push(`- ${tool}: ${policy}`);
  if (profile.memory.user_preferences.length) {
    lines.push('User preferences:');
    for (const item of profile.memory.user_preferences) lines.push(`- ${item}`);
  }
  if (profile.memory.project_facts.length) {
    lines.push('Project facts:');
    for (const item of profile.memory.project_facts) lines.push(`- ${item}`);
  }
  if (profile.memory.lessons.length) {
    lines.push('Lessons:');
    for (const item of profile.memory.lessons.slice(-20)) lines.push(`- ${item}`);
  }
  lines.push(`Growth: level=${profile.growth.level}; auto_apply=${profile.growth.auto_apply}; max_patch_ops=${profile.growth.max_patch_ops}`);
  return lines.join('\n');
}

function decodePointerSegment(segment) {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function parsePointer(path) {
  if (path === '') return [];
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`Invalid JSON pointer: ${path}`);
  return path.slice(1).split('/').map(decodePointerSegment);
}

function getParent(target, path, createMissing = false) {
  const segments = parsePointer(path);
  if (segments.length === 0) return { parent: null, key: null };
  let node = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (node == null || typeof node !== 'object') throw new Error(`Cannot traverse ${path}`);
    if (!(segment in node)) {
      if (!createMissing) throw new Error(`Missing parent for ${path}`);
      const nextSegment = segments[i + 1];
      node[segment] = nextSegment === '-' || /^\d+$/.test(nextSegment) ? [] : {};
    }
    node = node[segment];
  }
  return { parent: node, key: segments[segments.length - 1] };
}

function applyJsonPatch(document, patch) {
  if (!Array.isArray(patch)) throw new Error('patch must be an array');
  const next = clone(document) || {};
  for (const op of patch) {
    if (!op || typeof op !== 'object') throw new Error('patch op must be an object');
    if (!['add', 'replace', 'remove'].includes(op.op)) throw new Error(`Unsupported patch op: ${op.op}`);
    const { parent, key } = getParent(next, op.path, op.op === 'add');
    if (parent === null) {
      if (op.op === 'remove') throw new Error('Cannot remove document root');
      return clone(op.value);
    }
    if (Array.isArray(parent)) {
      if (op.op === 'add') {
        if (key === '-') parent.push(clone(op.value));
        else parent.splice(Number(key), 0, clone(op.value));
      } else if (op.op === 'replace') {
        if (!(key in parent)) throw new Error(`Missing path: ${op.path}`);
        parent[Number(key)] = clone(op.value);
      } else {
        if (!(key in parent)) throw new Error(`Missing path: ${op.path}`);
        parent.splice(Number(key), 1);
      }
      continue;
    }
    if (op.op === 'add' || op.op === 'replace') {
      if (op.op === 'replace' && !(key in parent)) throw new Error(`Missing path: ${op.path}`);
      parent[key] = clone(op.value);
    } else {
      if (!(key in parent)) throw new Error(`Missing path: ${op.path}`);
      delete parent[key];
    }
  }
  return next;
}

function pathStarts(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function evaluatePatch(profile, patch, { manual = false } = {}) {
  validateProfile(profile, 'active profile');
  if (!Array.isArray(patch)) return { allowed: false, auto: false, reason: 'patch must be array' };
  const level = profile.growth.level;
  const maxOps = profile.growth.max_patch_ops;
  if (level === 'none') return { allowed: false, auto: false, reason: 'growth level none forbids profile mutation' };
  if (patch.length > maxOps) return { allowed: false, auto: false, reason: `patch has ${patch.length} ops; max ${maxOps}` };
  if (patch.some((op) => pathStarts(op.path, ['/id', '/version', '/growth/level', '/growth/auto_apply', '/growth/max_patch_ops']))) {
    return { allowed: false, auto: false, reason: 'patch touches protected profile fields' };
  }

  const allowedByLevel = {
    low: ['/rules', '/memory/lessons', '/memory/user_preferences', '/memory/project_facts'],
    medium: ['/rules', '/memory/lessons', '/memory/user_preferences', '/memory/project_facts'],
    high: ['/rules', '/memory', '/style', '/tool_policy'],
    very_high: ['/description', '/style', '/rules', '/tool_policy', '/memory', '/growth/requires_eval', '/growth/max_patch_ops', '/growth/rollback']
  };

  const allowedPrefixes = allowedByLevel[level] || [];
  const disallowed = patch.find((op) => !pathStarts(op.path, allowedPrefixes));
  if (disallowed) return { allowed: false, auto: false, reason: `${disallowed.path} not allowed for growth ${level}` };

  const auto = !manual && profile.growth.auto_apply && ['medium', 'high', 'very_high'].includes(level);
  if (!manual && !auto) return { allowed: true, auto: false, reason: `growth ${level} requires human apply` };
  return { allowed: true, auto, reason: manual ? 'manual apply allowed' : 'auto apply allowed' };
}

function lessonFromMessage(message) {
  return String(message || '').trim().replace(/\s+/g, ' ').slice(0, 240);
}

function suggestPatchFromEvent(event) {
  const message = lessonFromMessage(event.message || event.prompt || event.reason || '');
  const lower = message.toLowerCase();
  if (message.startsWith('User project context:')) {
    return {
      reason: 'User project context learned from repeated usage.',
      patch: [
        { op: 'add', path: '/memory/project_facts/-', value: message.replace(/^User project context:\s*/, '') }
      ]
    };
  }
  if (message.startsWith('User preference:')) {
    return {
      reason: 'User preference learned from repeated usage.',
      patch: [
        { op: 'add', path: '/memory/user_preferences/-', value: message.replace(/^User preference:\s*/, '') }
      ]
    };
  }
  if (/read|context|edit/.test(lower) && /before|tanpa|without|lupa|forgot/.test(lower)) {
    return {
      reason: 'Failure indicates missing context before edit.',
      patch: [
        { op: 'add', path: '/rules/-', value: 'Before editing an existing file, read the relevant file section first.' },
        { op: 'add', path: '/memory/lessons/-', value: `Avoid repeat failure: ${message}` }
      ]
    };
  }
  if (/run_command|redirection|heredoc|shell|cat >|printf.*>|file creation/.test(lower)) {
    return {
      reason: 'Failure indicates shell command misuse for file creation.',
      patch: [
        { op: 'add', path: '/rules/-', value: 'For new files, use write_file instead of run_command or shell redirection.' },
        { op: 'add', path: '/memory/lessons/-', value: `Tool lesson: ${message}` }
      ]
    };
  }
  if (/max tool turns|stopped after max|repeated tool|loop/.test(lower)) {
    return {
      reason: 'Failure indicates repeated tool loop without progress.',
      patch: [
        { op: 'add', path: '/rules/-', value: 'If a tool strategy fails twice, switch tools or ask for clarification instead of repeating.' },
        { op: 'add', path: '/memory/lessons/-', value: `Loop lesson: ${message}` }
      ]
    };
  }
  if (/slow|berat|ram|memory|performance|lambat/.test(lower)) {
    return {
      reason: 'Failure indicates performance or memory pressure.',
      patch: [
        { op: 'add', path: '/rules/-', value: 'Keep context and tool output capped; never load whole repositories unless required.' },
        { op: 'add', path: '/memory/lessons/-', value: `Performance lesson: ${message}` }
      ]
    };
  }
  return {
    reason: 'Generic lesson captured from observed event.',
    patch: [
      { op: 'add', path: '/memory/lessons/-', value: `Lesson: ${message || 'Unspecified failure; ask for clearer acceptance criteria next time.'}` }
    ]
  };
}

module.exports = {
  GROWTH_LEVELS,
  HEAVY_DIRS,
  deepMerge,
  validateProfile,
  compileProfilePrompt,
  applyJsonPatch,
  evaluatePatch,
  suggestPatchFromEvent
};
