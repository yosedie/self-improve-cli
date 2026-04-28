'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function getDiscoveryDirs(projectRoot) {
  const home = os.homedir();
  return [
    ...[
      path.join(home, '.config', 'opencode', 'skills'),
      path.join(home, '.claude', 'skills'),
      path.join(home, '.agents', 'skills')
    ],
    ...[
      path.join(projectRoot, '.opencode', 'skills'),
      path.join(projectRoot, '.claude', 'skills'),
      path.join(projectRoot, '.agents', 'skills')
    ]
  ];
}

function parseSkillFrontmatter(content) {
  if (!content || !content.startsWith('---')) {
    return null;
  }
  // Match closing --- on its own line (with optional whitespace)
  const endMatch = content.match(/\r?\n---\s*(?:\r?\n|$)/);
  if (!endMatch) return null;
  const endIdx = endMatch.index;
  const yaml = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + endMatch[0].length).trim();
  const frontmatter = {};
  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return { name: frontmatter.name, description: frontmatter.description || '', body };
}

async function discoverSkills(projectRoot) {
  const dirs = getDiscoveryDirs(projectRoot);
  const seen = new Set();
  const results = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;
      const skillFile = path.join(dir, entry.name, 'SKILL.md');
      try {
        const content = await fs.readFile(skillFile, 'utf8');
        const parsed = parseSkillFrontmatter(content);
        if (!parsed || !parsed.name) continue;
        if (!SKILL_NAME_RE.test(parsed.name)) continue;
        if (parsed.name.length > 64) continue;
        seen.add(parsed.name);
        results.push({
          name: parsed.name,
          description: parsed.description,
          dir: path.join(dir, entry.name)
        });
      } catch {
        continue;
      }
    }
  }
  return results;
}

async function loadSkill(skillDir, projectRoot) {
  const skillMd = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  const parsed = parseSkillFrontmatter(skillMd);
  if (!parsed) throw new Error(`Invalid SKILL.md in ${skillDir}`);
  const result = {
    name: parsed.name,
    description: parsed.description,
    instructions: parsed.body,
    tools: [],
    handlers: {}
  };

  const toolsPath = path.join(skillDir, 'tools.json');
  try {
    const raw = await fs.readFile(toolsPath, 'utf8');
    const parsedTools = JSON.parse(raw);
    if (Array.isArray(parsedTools)) {
      result.tools = parsedTools.map(t => prefixToolSchema(parsed.name, t));
    }
  } catch {}

  // Security: only load handlers.js from project-local skills directories
  const isLocal = projectRoot && skillDir.toLowerCase().startsWith(path.resolve(projectRoot).toLowerCase());
  const handlersPath = path.join(skillDir, 'handlers.js');
  try {
    if (isLocal) {
      const rawHandlers = require(handlersPath);
      result.handlers = prefixHandlers(parsed.name, rawHandlers);
    } else {
      // Check if handlers.js exists to warn user
      await fs.access(handlersPath);
      process.stderr.write(`skills: skipping handlers.js for global skill "${parsed.name}" (security: only project-local skills may provide handlers)\n`);
    }
  } catch {}

  return result;
}

function prefixToolSchema(skillName, schema) {
  if (!schema?.function?.name) return schema;
  return {
    ...schema,
    function: {
      ...schema.function,
      name: `skill__${skillName}__${schema.function.name}`
    }
  };
}

function prefixHandlers(skillName, handlers) {
  const result = {};
  for (const [key, fn] of Object.entries(handlers)) {
    if (typeof fn === 'function') {
      result[`skill__${skillName}__${key}`] = fn;
    }
  }
  return result;
}

async function enableSkill(root, skillName) {
  const { loadProfiles, saveOverlay } = require('./state');
  const { overlay } = await loadProfiles(root);
  if (!overlay.memory) overlay.memory = {};
  if (!Array.isArray(overlay.memory.active_skills)) overlay.memory.active_skills = [];
  if (!overlay.memory.active_skills.includes(skillName)) {
    overlay.memory.active_skills.push(skillName);
    await saveOverlay(root, overlay);
  }
  return overlay.memory.active_skills;
}

async function disableSkill(root, skillName) {
  const { loadProfiles, saveOverlay } = require('./state');
  const { overlay } = await loadProfiles(root);
  if (!overlay.memory?.active_skills) return [];
  overlay.memory.active_skills = overlay.memory.active_skills.filter(s => s !== skillName);
  await saveOverlay(root, overlay);
  return overlay.memory.active_skills;
}

function buildSkillsPrompt(discovered, activeNames) {
  const lines = ['\nAvailable skills:'];
  for (const skill of discovered) {
    const marker = activeNames.includes(skill.name) ? ' [ACTIVE]' : '';
    lines.push(`- ${skill.name}${marker}: ${skill.description}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function getSkillTools(root, activeNames) {
  const schemas = [];
  const handlers = {};
  if (!activeNames || !activeNames.length) return { schemas, handlers };
  const discovered = await discoverSkills(root);
  for (const name of activeNames) {
    const skill = discovered.find(s => s.name === name);
    if (!skill) continue;
    try {
      const loaded = await loadSkill(skill.dir, root);
      schemas.push(...loaded.tools);
      Object.assign(handlers, loaded.handlers);
    } catch {
      process.stderr.write(`skills: failed to load "${name}"\n`);
    }
  }
  return { schemas, handlers };
}

module.exports = {
  SKILL_NAME_RE,
  getDiscoveryDirs,
  parseSkillFrontmatter,
  discoverSkills,
  loadSkill,
  prefixToolSchema,
  prefixHandlers,
  enableSkill,
  disableSkill,
  buildSkillsPrompt,
  getSkillTools
};
