'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { statePath, initWorkspace } = require('./state');

const CONFIG_FILE = 'config.json';
const PERMISSION_MODES = new Set(['secure', 'partial_secure', 'ai_reviewed', 'auto_approve']);

const PROVIDER_PRESETS = {
  openai: {
    id: 'openai',
    label: 'OpenAI Compatible',
    provider: 'openai-compatible',
    base_url: 'https://api.openai.com/v1',
    api_key_env: 'OPENAI_API_KEY',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1']
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax Coding Plan',
    provider: 'openai-compatible',
    base_url: 'https://api.minimax.io/v1',
    api_key_env: 'MINIMAX_API_KEY',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed']
  },
  zai: {
    id: 'zai',
    label: 'Z.AI Coding Plan',
    provider: 'openai-compatible',
    base_url: 'https://api.z.ai/api/coding/paas/v4',
    api_key_env: 'ZAI_API_KEY',
    models: ['GLM-5.1', 'GLM-5', 'GLM-5-Turbo', 'GLM-4.7', 'GLM-4.5-air']
  }
};

function defaultConfig(env = process.env) {
  const preset = PROVIDER_PRESETS.openai;
  return {
    provider_id: preset.id,
    provider_label: preset.label,
    provider: preset.provider,
    base_url: env.SICLI_BASE_URL || env.OPENAI_BASE_URL || preset.base_url,
    api_key_env: env.SICLI_API_KEY_ENV || preset.api_key_env,
    model: env.SICLI_MODEL || preset.models[0],
    permission_mode: env.SICLI_PERMISSION_MODE || 'partial_secure',
    temperature: 0.2,
    max_tool_turns: 8,
    max_history_messages: 20,
    self_improve_background: true,
    self_improve_review_every: 1
  };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  if (!(await exists(file))) return fallback;
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeConfig(config) {
  const merged = { ...defaultConfig(), ...(config || {}) };
  if (typeof merged.provider_id !== 'string') throw new Error('config.provider_id must be string');
  if (typeof merged.provider_label !== 'string') throw new Error('config.provider_label must be string');
  if (typeof merged.provider !== 'string') throw new Error('config.provider must be string');
  if (typeof merged.base_url !== 'string' || !merged.base_url) throw new Error('config.base_url must be non-empty string');
  if (typeof merged.api_key_env !== 'string' || !merged.api_key_env) throw new Error('config.api_key_env must be non-empty string');
  if (typeof merged.model !== 'string' || !merged.model) throw new Error('config.model must be non-empty string');
  if (!PERMISSION_MODES.has(merged.permission_mode)) throw new Error(`config.permission_mode must be one of ${Array.from(PERMISSION_MODES).join(', ')}`);
  if (typeof merged.temperature !== 'number') throw new Error('config.temperature must be number');
  if (!Number.isInteger(merged.max_tool_turns) || merged.max_tool_turns < 1) throw new Error('config.max_tool_turns must be positive integer');
  if (!Number.isInteger(merged.max_history_messages) || merged.max_history_messages < 1) throw new Error('config.max_history_messages must be positive integer');
  if (typeof merged.self_improve_background !== 'boolean') throw new Error('config.self_improve_background must be boolean');
  if (!Number.isInteger(merged.self_improve_review_every) || merged.self_improve_review_every < 1) throw new Error('config.self_improve_review_every must be positive integer');
  return merged;
}

async function loadConfig(root = process.cwd()) {
  await initWorkspace(root);
  const file = statePath(root, CONFIG_FILE);
  if (!(await exists(file))) await writeJson(file, defaultConfig());
  return normalizeConfig(await readJson(file, {}));
}

async function saveConfig(root, config) {
  const normalized = normalizeConfig(config);
  await writeJson(statePath(root, CONFIG_FILE), normalized);
  return normalized;
}

function parseConfigValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(String(value))) return Number(value);
  return value;
}

async function setConfigValue(root, key, value) {
  if (!key) throw new Error('config key required');
  const config = await loadConfig(root);
  config[key] = parseConfigValue(value);
  return saveConfig(root, config);
}

function listProviderPresets() {
  return Object.values(PROVIDER_PRESETS).map((preset) => ({
    id: preset.id,
    label: preset.label,
    provider: preset.provider,
    base_url: preset.base_url,
    api_key_env: preset.api_key_env,
    models: [...preset.models]
  }));
}

function findProviderPreset(value) {
  const query = String(value || '').trim().toLowerCase();
  if (!query) return null;
  const providers = listProviderPresets();
  if (/^\d+$/.test(query)) return providers[Number(query) - 1] || null;
  return providers.find((preset) => preset.id === query || preset.label.toLowerCase() === query || preset.label.toLowerCase().includes(query)) || null;
}

async function connectProvider(root, providerRef) {
  const preset = findProviderPreset(providerRef);
  if (!preset) throw new Error(`Unknown provider: ${providerRef}`);
  const current = await loadConfig(root);
  return saveConfig(root, {
    ...current,
    provider_id: preset.id,
    provider_label: preset.label,
    provider: preset.provider,
    base_url: preset.base_url,
    api_key_env: preset.api_key_env,
    model: preset.models[0]
  });
}

function modelsForConfig(config) {
  const preset = PROVIDER_PRESETS[config.provider_id];
  if (preset) return [...preset.models];
  return [config.model].filter(Boolean);
}

async function setModel(root, model) {
  if (!model) throw new Error('model required');
  const config = await loadConfig(root);
  return saveConfig(root, { ...config, model });
}

function listPermissionModes() {
  return [
    { id: 'secure', label: 'Secure: ask before every tool call' },
    { id: 'partial_secure', label: 'Partial secure: allow read/search and git-reversible file actions; ask otherwise' },
    { id: 'ai_reviewed', label: 'AI reviewed: reviewer model approves action tools; ask on deny/error' },
    { id: 'auto_approve', label: 'Auto approve: allow all profile-permitted tools' }
  ];
}

async function setPermissionMode(root, mode) {
  if (!PERMISSION_MODES.has(mode)) throw new Error(`permission mode must be one of ${Array.from(PERMISSION_MODES).join(', ')}`);
  const config = await loadConfig(root);
  return saveConfig(root, { ...config, permission_mode: mode });
}

module.exports = {
  CONFIG_FILE,
  PERMISSION_MODES,
  PROVIDER_PRESETS,
  defaultConfig,
  normalizeConfig,
  loadConfig,
  saveConfig,
  setConfigValue,
  listPermissionModes,
  setPermissionMode,
  listProviderPresets,
  findProviderPreset,
  connectProvider,
  modelsForConfig,
  setModel
};
