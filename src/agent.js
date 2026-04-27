'use strict';

const readline = require('node:readline');
const rlPromises = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { compileProfilePrompt, evaluatePatch, suggestPatchFromEvent } = require('./profile');
const { loadProfiles, appendEvent, appendPatchAudit, applyPatchToOverlay, setGrowthLevel, getSelfImproveStatus } = require('./state');
const { loadConfig, setConfigValue, listProviderPresets, connectProvider, modelsForConfig, setModel, listPermissionModes, setPermissionMode } = require('./config');
const { chatCompletion } = require('./provider');
const { setProviderApiKey, hasProviderApiKey, secretStatus } = require('./secrets');
const { readFileTool, searchTool, runCommandTool, writeFileTool, editFileTool } = require('./tools');
const { learnFromMessage, runDemo, runBackgroundReview, recordTaskTrace, scheduleBackgroundReview } = require('./self-improve');
const { validateAskUserArgs, deterministicPolicy, DeferredQuestionsQueue } = require('./ask_gate');
const os = require('node:os');
const path = require('node:path');

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file from the workspace. Output is capped.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description: 'Search workspace files for literal text. Heavy directories are skipped.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          dir: { type: 'string' }
        },
        required: ['pattern'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a command with args using shell=false. No shell redirection, pipes, heredocs, glob expansion, or command strings. Use write_file for file creation.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file directly. Prefer this over shell commands for new files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Edit a file by replacing one exact, unique old_text block with new_text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' }
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Submit a question candidate to the user. Only use when the task genuinely requires user authority. In autonomous mode, this goes through a review gate.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask' },
          reason: { type: 'string', description: 'Why this question is necessary' },
          risk_type: { type: 'string', enum: ['clarification', 'file_write', 'file_delete', 'command_exec', 'external_dependency', 'api_key', 'permission', 'other'], description: 'Category of risk' },
          files: { type: 'array', items: { type: 'string' }, description: 'Affected file paths' },
          safe_default: { type: 'string', description: 'What to do if the question is rejected or deferred' },
          blocking: { type: 'boolean', description: 'Whether the task cannot proceed without an answer' }
        },
        required: ['question', 'reason', 'risk_type', 'safe_default'],
        additionalProperties: false
      }
    }
  }
];

const TOOL_POLICY_KEYS = {
  read_file: 'read_file',
  search: 'search',
  run_command: 'run_command',
  write_file: 'write_file',
  edit_file: 'edit_file',
  ask_user: 'ask_user'
};

function compactJson(value, limit = 12000) {
  const text = JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}...<truncated>` : text;
}

function systemPrompt(profile) {
  return `${compileProfilePrompt(profile)}\n\nWorkspace:\n- cwd=${process.cwd()}\n- platform=${process.platform}\n- os=${os.type()} ${os.release()}\n- path_separator=${require('node:path').sep}\n\nAgent loop rules:\n- You are self-improve-cli, a lightweight coding agent.\n- Use tool calls when repository facts are needed.\n- For new files, use write_file. Do not use run_command for file creation.\n- Read relevant files before editing existing files.\n- For edits, use edit_file with exact unique old_text.\n- run_command uses spawn with shell=false: no redirection, pipes, heredocs, shell builtins, or compound command strings.\n- Keep final answers concise and include validation run when possible.\n- Do not output <think> blocks or hidden reasoning.\n- Do not claim a command passed unless run_command output proves it.`;
}

function parseToolArgs(toolCall) {
  const raw = toolCall.function?.arguments || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON tool args for ${toolCall.function?.name || 'unknown'}: ${raw}`);
  }
}

function safeToolArgs(toolCall) {
  try {
    return parseToolArgs(toolCall);
  } catch {
    return { raw: toolCall.function?.arguments || '' };
  }
}

async function askApproval(question, rl) {
  if (!rl) throw new Error('askApproval requires rl in interactive mode');
  const answer = await rl.question(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

async function askToolPermission(name, args, options, reason = '') {
  if (options.yes) return;
  if (!options.interactive) throw new Error(`Tool requires approval: ${name}. ${reason} Re-run with --yes or use interactive chat.`.trim());
  const suffix = reason ? ` (${reason})` : '';
  const ok = await askApproval(`Allow ${name} ${compactJson(args, 500)}${suffix}?`, options.rl);
  if (!ok) throw new Error(`Tool not approved: ${name}`);
}

function fileTargetForTool(name, args) {
  if (name === 'write_file' || name === 'edit_file' || name === 'read_file') return args.path;
  return '';
}

async function isGitReversibleFileAction(root, name, args) {
  const target = fileTargetForTool(name, args);
  if (!target) return false;
  const absolute = path.resolve(root, target);
  let exists = true;
  try {
    await require('node:fs/promises').access(absolute);
  } catch {
    exists = false;
  }
  const inside = await runCommandTool(root, 'git', ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return false;
  if (!exists && name === 'write_file') return true;
  const status = await runCommandTool(root, 'git', ['status', '--porcelain', '--', target]);
  if (status.code !== 0) return false;
  if (status.stdout.trim()) return false;
  const tracked = await runCommandTool(root, 'git', ['ls-files', '--error-unmatch', '--', target]);
  return tracked.code === 0;
}

async function reviewToolSafety(root, config, name, args, signal) {
  const prompt = `Review this proposed local coding-agent tool call for safety. Reply only JSON: {"approved": boolean, "reason": string}.\nTool: ${name}\nArgs: ${compactJson(args, 4000)}\nRules:\n- Approve read/search.\n- Approve write/edit only if normal coding task and path looks safe.\n- Reject destructive commands, secret exfiltration, network install scripts, deletion, chmod/chown, rm, format, credential access, or unclear broad changes.\n- For run_command, approve only clearly safe tests/status/read-only commands.`;
  const reviewer = await chatCompletion(root, config, [
    { role: 'system', content: 'You are a strict security reviewer. No tools. Return JSON only.' },
    { role: 'user', content: prompt }
  ], [], signal);
  const text = stripThinkBlocks(reviewer.content || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(text);
    return { approved: Boolean(parsed.approved), reason: String(parsed.reason || '') };
  } catch {
    return { approved: false, reason: `reviewer returned non-JSON: ${text.slice(0, 200)}` };
  }
}

async function ensureAllowed(root, profile, config, name, args, options) {
  const policyKey = TOOL_POLICY_KEYS[name];
  const policy = profile.tool_policy[policyKey] || 'deny';
  if (policy === 'deny') throw new Error(`Tool denied by profile: ${name}`);
  if (!['allow', 'ask'].includes(policy)) throw new Error(`Unknown tool policy for ${name}: ${policy}`);

  const mode = config.permission_mode;
  if (mode === 'auto_approve') return;
  if (mode === 'secure') return askToolPermission(name, args, options, 'secure mode');
  if (mode === 'partial_secure') {
    if (name === 'read_file' || name === 'search') return;
    if ((name === 'write_file' || name === 'edit_file') && await isGitReversibleFileAction(root, name, args)) return;
    return askToolPermission(name, args, options, 'not proven git-reversible');
  }
  if (mode === 'ai_reviewed') {
    if (name === 'read_file' || name === 'search') return;
    let review;
    try {
      review = await reviewToolSafety(options.root || process.cwd(), config, name, args, options.signal);
    } catch (error) {
      review = { approved: false, reason: `review failed: ${error.message}` };
    }
    if (review.approved) {
      if (options.interactive) process.stdout.write(`✓ ai_review ${review.reason || 'approved'}\n`);
      return;
    }
    return askToolPermission(name, args, options, `AI review: ${review.reason || 'not approved'}`);
  }
  throw new Error(`Unknown permission mode: ${mode}`);
}

function validateRunCommandArgs(args) {
  const command = String(args.command || '');
  const argv = args.args || [];
  if (!Array.isArray(argv)) throw new Error('run_command args must be array');
  if (/\s|[|&;<>()$`>]/.test(command)) {
    throw new Error('run_command command must be executable name only because shell=false. Use args array, or write_file for file creation.');
  }
}

async function executeTool(root, profile, toolCall, options) {
  const name = toolCall.function?.name;
  const args = parseToolArgs(toolCall);
  await ensureAllowed(root, profile, options.config, name, args, options);
  if (options.trace) process.stderr.write(`tool ${name} ${compactJson(args, 800)}\n`);
  if (name === 'read_file') return readFileTool(root, args.path, { signal: options.signal });
  if (name === 'search') return searchTool(root, args.pattern, args.dir || '.', { signal: options.signal });
  if (name === 'run_command') {
    validateRunCommandArgs(args);
    return runCommandTool(root, args.command, args.args || [], { signal: options.signal });
  }
  if (name === 'write_file') return writeFileTool(root, args.path, args.content, { signal: options.signal, overwrite: args.overwrite !== false });
  if (name === 'edit_file') return editFileTool(root, args.path, args.old_text, args.new_text, { signal: options.signal });
  throw new Error(`Unknown tool: ${name || '(missing)'}`);
}

function trimHistory(messages, maxHistoryMessages) {
  const system = messages[0];
  const rest = messages.slice(1);
  return [system, ...rest.slice(-maxHistoryMessages)];
}

function stripThinkBlocks(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function toolCallName(toolCall) {
  return toolCall.function?.name || 'unknown_tool';
}

function summarizeToolResult(result) {
  if (!result.ok) return result.error;
  const value = result.result || {};
  if (value.path) return value.path;
  if (typeof value.code === 'number' || value.signal || value.error) return `code=${value.code} signal=${value.signal || 'none'}`;
  if (Array.isArray(value.matches)) return `${value.matches.length} matches`;
  return 'ok';
}

function normalizeToolExecution(name, value) {
  if (name === 'run_command' && (value.error || value.code !== 0)) {
    const detail = value.error || value.stderr || `command exited with code ${value.code}`;
    return { ok: false, error: detail, result: value };
  }
  return { ok: true, result: value };
}

async function recordSelfImprove(root, active, event, options = {}) {
  try {
    const record = await appendEvent(root, event);
    const suggestion = suggestPatchFromEvent(record);
    const gate = evaluatePatch(active, suggestion.patch, { manual: false });
    const audit = { event: record, patch: suggestion.patch, gate, applied: false };
    if (gate.allowed && gate.auto) {
      await applyPatchToOverlay(root, suggestion.patch);
      audit.applied = true;
    }
    await appendPatchAudit(root, audit);
    if (options.interactive) process.stdout.write(`↻ self-improve ${audit.applied ? 'applied' : 'logged'}: ${suggestion.reason}\n`);
    return audit;
  } catch (error) {
    if (options.interactive) process.stdout.write(`✗ self-improve log failed: ${error.message}\n`);
    return null;
  }
}

async function runAgentTask(root, prompt, options = {}) {
  const { active } = await loadProfiles(root);
  const config = await loadConfig(root);
  let systemContent = systemPrompt(active);
  if (options.autonomous) {
    systemContent += '\n\nYou are in autonomous mode. Continue working by default. Do not ask the user unnecessary questions. If you genuinely need user authority, use the ask_user tool. Otherwise, make reasonable decisions and keep going.';
  }
  const messages = [
    { role: 'system', content: systemContent },
    ...(options.history || []),
    { role: 'user', content: prompt }
  ];
  const maxTurns = options.autonomous
    ? (options.maxTurns || active.harness?.max_tool_turns_autonomous || config.max_tool_turns_autonomous)
    : (options.maxTurns || active.harness?.max_tool_turns || config.max_tool_turns);
  const started = Date.now();
  const trace = { prompt, tools: [] };
  let loggedToolFailure = false;
  const deferredQueue = options.autonomous ? new DeferredQuestionsQueue() : null;
  let status = 'running';
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const requestMessages = trimHistory(messages, (active.harness?.max_history_messages ?? config.max_history_messages) + 1);
    const assistant = await chatCompletion(root, config, requestMessages, TOOL_SCHEMAS, options.signal);
    messages.push(assistant);
    const toolCalls = assistant.tool_calls || [];
    if (!toolCalls.length) {
      const text = stripThinkBlocks(assistant.content);
      trace.autonomous = Boolean(options.autonomous);
      trace.status = 'completed';
      if (deferredQueue) {
        trace.deferred_questions = deferredQueue.getAll();
      }
      await recordTaskTrace(root, { ...trace, final_text: text, duration_ms: Date.now() - started });
      await scheduleBackgroundReview(root);
      const result = { text, messages, status: 'completed' };
      if (deferredQueue) {
        result.deferredQuestions = deferredQueue.getAll();
        if (options.interactive) process.stdout.write(deferredQueue.toReport());
      }
      return result;
    }
    for (const toolCall of toolCalls) {
      let result;
      const name = toolCallName(toolCall);
      try {
        if (name === 'ask_user' && options.autonomous) {
          const candidate = validateAskUserArgs(parseToolArgs(toolCall));
          const decision = deterministicPolicy(candidate);
          if (decision.action === 'approve') {
            result = { ok: true, result: { gate: 'approved', answer: 'User has approved this question via gate.' } };
          } else {
            result = { ok: true, result: { gate: decision.action, safe_default: candidate.safe_default } };
            deferredQueue.push({ turn, question: candidate.question, reason: candidate.reason, risk_type: candidate.risk_type, files: candidate.files, safe_default: candidate.safe_default, blocking: candidate.blocking, tool_call_id: toolCall.id });
            if (candidate.blocking && decision.action === 'reject') {
              status = 'blocked';
            }
          }
        } else if (name === 'ask_user' && !options.autonomous) {
          result = { ok: false, error: 'ask_user tool requires autonomous mode. Run with --dont-ask or set autonomous: true.' };
        } else {
          result = normalizeToolExecution(name, await executeTool(root, active, toolCall, { ...options, root, config }));
        }
      } catch (error) {
        result = { ok: false, error: error.message };
      }
      const parsedArgs = parseToolArgs(toolCall);
      trace.tools.push({
        name,
        args: safeToolArgs(toolCall),
        raw_args: parsedArgs,
        raw_response: result,
        compact_args: compactJson(parsedArgs, 800),
        ok: result.ok,
        error: result.error || '',
        summary: summarizeToolResult(result)
      });
      if (options.interactive) {
        process.stdout.write(`${result.ok ? '✓' : '✗'} ${name} ${summarizeToolResult(result)}\n`);
      }
      if (!result.ok && !loggedToolFailure) {
        loggedToolFailure = true;
        await recordSelfImprove(root, active, {
          type: 'tool_failure',
          message: `${name} failed during prompt "${prompt}": ${result.error}`
        }, options);
      }
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: compactJson(result)
      });
    }
  }
  await recordSelfImprove(root, active, {
    type: 'max_tool_turns',
    message: `Stopped after max tool turns (${maxTurns}) for prompt "${prompt}"`
  }, options);
  const text = `Stopped after max tool turns (${maxTurns}). Self-improve logged this failure.`;
  trace.autonomous = Boolean(options.autonomous);
  trace.status = 'max_turns';
  if (deferredQueue) trace.deferred_questions = deferredQueue.getAll();
  await recordTaskTrace(root, { ...trace, final_text: text, stopped_after_max_turns: true, duration_ms: Date.now() - started });
  await scheduleBackgroundReview(root);
  const result = { text, messages, status: 'max_turns' };
  if (deferredQueue) {
    result.deferredQuestions = deferredQueue.getAll();
    if (options.interactive) process.stdout.write(deferredQueue.toReport());
  }
  return result;
}

async function printProviderHelp(root, config) {
  const status = await secretStatus(root, config);
  process.stdout.write(`Connected: ${config.provider_label}\n`);
  process.stdout.write(`Base URL: ${config.base_url}\n`);
  process.stdout.write(`Model: ${config.model}\n`);
  process.stdout.write(`Stored API key: ${status.stored_api_key ? 'yes' : 'no'}\n`);
  process.stdout.write(`Secret file: ${status.secrets_file}\n`);
  process.stdout.write(`Env fallback: ${config.api_key_env}\n`);
}

async function askHidden(question, rl) {
  if (!input.isTTY || !input.setRawMode) {
    process.stdout.write('Warning: terminal cannot hide input; key may be visible.\n');
    try {
      return (await rl.question(question)).trim();
    } catch (error) {
      if (error.message === 'readline was closed') return '';
      throw error;
    }
  }
  rl.pause();
  let nestedInputActive = false;
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      nestedInputActive = false;
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      rl.resume();
    };
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\r' || char === '\n') {
          output.write('\n');
          cleanup();
          resolve(value.trim());
          return;
        }
        if (char === '\b' || char === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    output.write(question);
    nestedInputActive = true;
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function promptAndStoreApiKey(root, config, rl) {
  const existing = await hasProviderApiKey(root, config.provider_id);
  const suffix = existing ? 'replace stored key, empty to keep existing' : 'empty to skip';
  const key = await askHidden(`API key for ${config.provider_label} (${suffix}): `, rl);
  if (!key) {
    process.stdout.write(existing ? 'Stored API key unchanged.\n' : 'No API key stored. Use /key later.\n');
    return false;
  }
  const result = await setProviderApiKey(root, config.provider_id, key);
  process.stdout.write(`Stored API key securely in ${result.path}\n`);
  return true;
}

function listProviders() {
  const providers = listProviderPresets();
  process.stdout.write('Providers:\n');
  providers.forEach((provider, index) => {
    process.stdout.write(`  ${index + 1}. ${provider.id} - ${provider.label} (${provider.base_url})\n`);
  });
  return providers;
}

async function handleConnectCommand(root, arg, rl) {
  let selection = arg;
  if (!selection) {
    listProviders();
    selection = (await rl.question('provider> ')).trim();
  }
  const config = await connectProvider(root, selection);
  await printProviderHelp(root, config);
  await promptAndStoreApiKey(root, config, rl);
  return true;
}

async function handleModelsCommand(root, arg, rl) {
  const config = await loadConfig(root);
  const models = modelsForConfig(config);
  if (!models.length) {
    process.stdout.write(`No model preset for ${config.provider_label}. Use /models <model>.\n`);
    return true;
  }
  const prompted = !arg;
  let selection = arg;
  process.stdout.write(`Models for ${config.provider_label}:\n`);
  models.forEach((model, index) => {
    const active = model === config.model ? ' *' : '';
    process.stdout.write(`  ${index + 1}. ${model}${active}\n`);
  });
  if (!selection) selection = (await rl.question('model> ')).trim();
  if (!selection) return true;
  const model = /^\d+$/.test(selection) ? models[Number(selection) - 1] : selection;
  if (!model) throw new Error(`Unknown model selection: ${selection}`);
  if (prompted && !models.includes(model)) {
    process.stdout.write(`Invalid model selection: ${selection}. Pick a number, or use /models <custom-model>.\n`);
    return true;
  }
  const next = await setModel(root, model);
  process.stdout.write(`Model: ${next.model}\n`);
  return true;
}

function printSelfImproveResult(result) {
  process.stdout.write(`Self-improve: ${result.audit.applied ? 'applied' : 'logged'}\n`);
  process.stdout.write(`Reason: ${result.suggestion.reason}\n`);
  process.stdout.write(`Gate: ${result.audit.gate.reason}\n`);
  process.stdout.write(`Patch ops: ${result.suggestion.patch.length}\n`);
}

async function handleSelfImproveCommand(root, arg) {
  const [action, ...parts] = String(arg || '').trim().split(/\s+/).filter(Boolean);
  if (!action || action === 'status') {
    process.stdout.write(`${JSON.stringify(await getSelfImproveStatus(root), null, 2)}\n`);
    return true;
  }
  if (action === 'demo') {
    printSelfImproveResult(await runDemo(root, { apply: parts.includes('--apply') }));
    return true;
  }
  if (action === 'enable') {
    await setGrowthLevel(root, 'medium', { auto_apply: true });
    await setConfigValue(root, 'self_improve_background', 'true');
    await setConfigValue(root, 'self_improve_review_every', '1');
    process.stdout.write('Self-improve enabled: background=true, review_every=1, growth=medium auto_apply=true\n');
    return true;
  }
  if (action === 'growth') {
    const level = parts[0];
    if (!level) throw new Error('usage: /self-improve growth <none|low|medium|high|very_high> [--auto-apply true|false]');
    const autoFlag = parts.includes('--auto-apply') ? parts[parts.indexOf('--auto-apply') + 1] : undefined;
    const result = await setGrowthLevel(root, level, autoFlag === undefined ? {} : { auto_apply: String(autoFlag) === 'true' });
    process.stdout.write(`Growth: ${JSON.stringify(result.active.growth)}\n`);
    return true;
  }
  if (action === 'background-run') {
    const result = await runBackgroundReview(root);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return true;
  }
  if (action === 'learn') {
    const apply = parts.includes('--apply');
    const message = parts.filter((part) => part !== '--apply').join(' ');
    if (!message) throw new Error('usage: /self-improve learn <message> [--apply]');
    printSelfImproveResult(await learnFromMessage(root, message, { apply, type: 'user_lesson' }));
    return true;
  }
  process.stdout.write('Usage: /self-improve [status|enable|growth <level> [--auto-apply true|false]|demo [--apply]|background-run|learn <message> [--apply]]\n');
  return true;
}

async function handlePermissionsCommand(root, arg) {
  if (!arg) {
    const config = await loadConfig(root);
    process.stdout.write(`Permission mode: ${config.permission_mode}\n`);
    process.stdout.write('Modes:\n');
    for (const mode of listPermissionModes()) process.stdout.write(`  ${mode.id} - ${mode.label}\n`);
    return true;
  }
  const config = await setPermissionMode(root, arg);
  process.stdout.write(`Permission mode: ${config.permission_mode}\n`);
  return true;
}

async function handleSlashCommand(root, prompt, rl) {
  const [command, ...parts] = prompt.split(/\s+/);
  const arg = parts.join(' ').trim();
  if (command === '/exit' || command === '/quit') return false;
  if (command === '/help') {
    process.stdout.write('Commands: /connect [provider], /key, /models [model], /permissions [mode], /self-improve [status|enable|growth|demo|learn], /config, /help, /exit\n');
    return true;
  }
  if (command === '/config') {
    const config = await loadConfig(root);
    process.stdout.write(`${JSON.stringify({ ...config, ...(await secretStatus(root, config)) }, null, 2)}\n`);
    return true;
  }
  if (command === '/key') {
    const config = await loadConfig(root);
    await promptAndStoreApiKey(root, config, rl);
    return true;
  }
  if (command === '/connect') return handleConnectCommand(root, arg, rl);
  if (command === '/models') return handleModelsCommand(root, arg, rl);
  if (command === '/permissions') return handlePermissionsCommand(root, arg);
  if (command === '/self-improve') return handleSelfImproveCommand(root, arg);
  process.stdout.write(`Unknown command: ${command}. Use /help.\n`);
  return true;
}

async function startChat(root, options = {}) {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const rl = await rlPromises.createInterface({ input, output });
  const history = [];
  process.stdout.write('self-improve-cli chat. /help for commands. /exit to quit. Press ESC to cancel task.\n');
  
  let nestedInputActive = false;
  let currentController = null;
  const keypressHandler = (str, key) => {
    if (key && key.name === 'escape' && currentController && !nestedInputActive) {
      currentController.abort();
      process.stdout.write('\n[Cancelled]\n');
    }
  };
  process.stdin.on('keypress', keypressHandler);

  try {
    while (true) {
      let prompt;
      try {
        prompt = ((await rl.question('sicli> ')) || '').trim();
      } catch (error) {
        if (error.message === 'readline was closed') break;
        throw error;
      }
      if (!prompt) continue;
      if (prompt.startsWith('/')) {
        try {
          const keepGoing = await handleSlashCommand(root, prompt, rl);
          if (!keepGoing) break;
        } catch (error) {
          process.stderr.write(`Error: ${error.message}\n`);
        }
        continue;
      }
      try {
        currentController = new AbortController();
        const result = await runAgentTask(root, prompt, { ...options, interactive: true, history, rl, signal: currentController.signal });
        process.stdout.write(`${result.text}\n`);
        history.splice(0, history.length, ...result.messages.filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls)).slice(-10));
      } catch (error) {
        if (error.name === 'AbortError') process.stdout.write('\n[Task Aborted]\n');
        else process.stderr.write(`Error: ${error.message}\n`);
      } finally {
        currentController = null;
      }
    }
  } finally {
    process.stdin.removeListener('keypress', keypressHandler);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    rl.close();
  }
}

module.exports = {
  TOOL_SCHEMAS,
  systemPrompt,
  runAgentTask,
  handleSlashCommand,
  isGitReversibleFileAction,
  stripThinkBlocks,
  startChat
};
