'use strict';

const { getProviderApiKey } = require('./secrets');

function joinUrl(baseUrl, suffix) {
  return `${baseUrl.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

async function apiKeyFromConfig(root, config, env = process.env) {
  const stored = await getProviderApiKey(root, config.provider_id);
  if (stored) return stored;
  const key = env[config.api_key_env];
  if (key) return key;
  throw new Error(`Missing API key for ${config.provider_label || config.provider_id}. Run /connect or /key, or set env ${config.api_key_env}.`);
}

async function chatCompletion(root, config, messages, tools = [], signal) {
  if (config.provider !== 'openai-compatible') throw new Error(`Unsupported provider: ${config.provider}`);
  const response = await fetch(joinUrl(config.base_url, 'chat/completions'), {
    signal,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await apiKeyFromConfig(root, config)}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: config.temperature,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined
    })
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const message = body.error?.message || body.message || response.statusText;
    throw new Error(`Provider error ${response.status}: ${message}`);
  }
  const message = body.choices?.[0]?.message;
  if (!message) throw new Error('Provider response missing choices[0].message');
  return message;
}

module.exports = {
  joinUrl,
  apiKeyFromConfig,
  chatCompletion
};
