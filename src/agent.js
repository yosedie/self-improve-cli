'use strict';

const { compileProfilePrompt, evaluatePatch, suggestPatchFromEvent } = require('./profile');
const { loadProfiles, appendEvent, appendPatchAudit, applyPatchToOverlay, loadMcpConfig, saveState } = require('./state');
const { loadConfig } = require('./config');
const { chatCompletion } = require('./provider');
const { readFileTool, searchTool, runCommandTool, writeFileTool, editFileTool } = require('./tools');
const { recordTaskTrace, scheduleBackgroundReview } = require('./self-improve');
const { validateAskUserArgs, deterministicPolicy, DeferredQuestionsQueue, reviewQuestion } = require('./ask_gate');
const { MCPManager, buildMcpToolBridge } = require('./mcp-client');
const { discoverSkills, buildSkillsPrompt, getSkillTools } = require('./skills');
const { stripThinkBlocks, compactJson } = require('./text-utils');
const os = require('node:os');
const path = require('node:path');
const { askApproval, handleSlashCommand, startChat: baseStartChat } = require('./commands/chat-commands');
const { ensureAllowed, isGitReversibleFileAction } = require('./safety/tool-safety');

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
  },
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description: 'Signal that the current task is finished. Provide a summary of what was accomplished.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Concise summary of completed work' },
          verification_status: { type: 'string', enum: ['passed', 'failed', 'skipped', 'pending'], description: 'Status of any verification performed' }
        },
        required: ['summary'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delegate_swarm',
      description: 'Delegate a complex multi-feature task to parallel swarm subagents. Each feature runs independently with its own agent + critic. Use when the task has 2+ clear independent sub-tasks.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The full task description to delegate to the swarm orchestrator' },
          enable_mmx: { type: 'boolean', description: 'Allow feature agents to use mmx search and text generation (default false)' },
          concurrency: { type: 'number', description: 'Number of feature agents to run in parallel (default 3)' }
        },
        required: ['prompt'],
        additionalProperties: false
      }
    }
  }
];

function systemPrompt(profile, skillsBlock) {
  let prompt = `${compileProfilePrompt(profile)}\n\nWorkspace:\n- cwd=${process.cwd()}\n- platform=${process.platform}\n- os=${os.type()} ${os.release()}\n- path_separator=${require('node:path').sep}\n\nAgent loop rules:\n- You are self-improve-cli, a lightweight coding agent.\n- Use tool calls when repository facts are needed.\n- For new files, use write_file. Do not use run_command for file creation.\n- Read relevant files before editing existing files.\n- For edits, use edit_file with exact unique old_text.\n- run_command uses spawn with shell=false: no redirection, pipes, heredocs, shell builtins, or compound command strings.\n- Keep final answers concise and include validation run when possible.\n- Do not output <think> blocks or hidden reasoning.\n- Do not claim a command passed unless run_command output proves it.`;
  if (skillsBlock) prompt += skillsBlock;
  return prompt;
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
  if (options.toolHandlers && name in options.toolHandlers) {
    return options.toolHandlers[name](root, args, options);
  }
  throw new Error(`Unknown tool: ${name || '(missing)'}`);
}

function trimHistory(messages, maxHistoryMessages) {
  const system = messages[0];
  const rest = messages.slice(1);
  return [system, ...rest.slice(-maxHistoryMessages)];
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
  const isAutonomous = Boolean(options.autonomous) || Boolean(active.harness?.autonomous_mode);

  const activeSkillNames = active.memory?.active_skills || [];
  let skillsBlock = '';
  try {
    const discovered = await discoverSkills(root);
    skillsBlock = buildSkillsPrompt(discovered, activeSkillNames);
  } catch {}

  let systemContent = systemPrompt(active, skillsBlock);
  if (isAutonomous) {
    systemContent += '\n\nYou are in autonomous mode. Continue working by default. Do not ask the user unnecessary questions. If you genuinely need user authority, use the ask_user tool. When finished, use task_complete. Otherwise, make reasonable decisions and keep going.';
  }
  // Handle both string prompt and multi-content prompt (text + image array)
  const userContent = Array.isArray(prompt) ? prompt : String(prompt);
  const messages = [
    { role: 'system', content: systemContent },
    ...(options.history || []),
    { role: 'user', content: userContent }
  ];
  const maxTurns = isAutonomous
    ? (options.maxTurns || active.harness?.max_tool_turns_autonomous || config.max_tool_turns_autonomous)
    : (options.maxTurns || active.harness?.max_tool_turns || config.max_tool_turns);
  const started = Date.now();
  const trace = { prompt, tools: [] };
  let loggedToolFailure = false;
  const deferredQueue = isAutonomous ? new DeferredQuestionsQueue() : null;
  let status = 'running';

  let mcpManager = null;
  let allTools = options.tools ? [...options.tools] : [...TOOL_SCHEMAS];
  const allHandlers = { ...(options.toolHandlers || {}) };

  try {
    const skillTools = await getSkillTools(root, activeSkillNames);
    allTools.push(...skillTools.schemas);
    Object.assign(allHandlers, skillTools.handlers);
  } catch {}

  try {
    const mcpConfig = await loadMcpConfig(root);
    if (mcpConfig.mcpServers && Object.keys(mcpConfig.mcpServers).length > 0) {
      mcpManager = new MCPManager(root, mcpConfig);
      await mcpManager.discover();
      const bridge = buildMcpToolBridge(mcpManager);
      allTools.push(...bridge.mcpToolSchemas);
      Object.assign(allHandlers, bridge.mcpToolHandlers);
    }
  } catch (err) {
    process.stderr.write(`mcp: init failed: ${err.message}\n`);
  }

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
    const requestMessages = trimHistory(messages, (active.harness?.max_history_messages ?? config.max_history_messages) + 1);
    const toolsToUse = allTools;
    const { message: assistant } = await chatCompletion(root, config, requestMessages, toolsToUse, options.signal);
    messages.push(assistant);
    const toolCalls = assistant.tool_calls || [];
    if (!toolCalls.length) {
      const text = stripThinkBlocks(assistant.content);
      trace.autonomous = isAutonomous;
      trace.status = 'completed';
      if (deferredQueue) {
        trace.deferred_questions = deferredQueue.getAll();
      }
      await recordTaskTrace(root, { ...trace, final_text: text, duration_ms: Date.now() - started });
      await scheduleBackgroundReview(root);
      await saveState(root).catch((err) => process.stderr.write(`saveState failed: ${err.message}\n`));
      const result = { text, messages, status: 'completed', autonomous: isAutonomous };
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
        if (name === 'task_complete') {
          const args = parseToolArgs(toolCall);
          const summary = String(args.summary || '');
          const verificationStatus = String(args.verification_status || 'pending');
          result = { ok: true, result: { task_complete: true, summary, verification_status: verificationStatus } };
          trace.tools.push({
            name,
            args: safeToolArgs(toolCall),
            raw_args: parseToolArgs(toolCall),
            raw_response: result,
            compact_args: compactJson(parseToolArgs(toolCall), 800),
            ok: result.ok,
            error: '',
            summary: `completed (${verificationStatus})`
          });
          if (options.interactive) {
            process.stdout.write(`${result.ok ? '✓' : '✗'} ${name} ${summarizeToolResult(result)}\n`);
          }
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: compactJson(result)
          });
          trace.autonomous = isAutonomous;
          trace.status = 'completed';
          trace.task_complete = { summary, verification_status: verificationStatus };
          if (deferredQueue) trace.deferred_questions = deferredQueue.getAll();
          await recordTaskTrace(root, { ...trace, final_text: summary, duration_ms: Date.now() - started });
          await scheduleBackgroundReview(root);
          await saveState(root).catch((err) => process.stderr.write(`saveState failed: ${err.message}\n`));
          const completionResult = { text: summary, messages, status: 'completed', autonomous: isAutonomous, verificationStatus };
          if (deferredQueue) {
            completionResult.deferredQuestions = deferredQueue.getAll();
            if (options.interactive) process.stdout.write(deferredQueue.toReport());
          }
          return completionResult;
        }

        if (name === 'delegate_swarm' && isAutonomous) {
          const args = parseToolArgs(toolCall);
          const swarmPrompt = String(args.prompt || '');
          if (!swarmPrompt) throw new Error('delegate_swarm requires prompt');
          const swarmOptions = {
            enableMmx: Boolean(args.enable_mmx),
            concurrency: Math.max(1, Math.min(10, parseInt(args.concurrency, 10) || 3)),
            signal: options.signal,
            interactive: options.interactive,
            runAgentTask,
            toolSchemas: TOOL_SCHEMAS
          };
          const swarmResult = await require('./orchestrator').runSwarm(root, swarmPrompt, swarmOptions);
          result = { ok: true, result: { swarm: true, merged: swarmResult.merged || swarmResult } };
        }

        if (name === 'ask_user' && isAutonomous) {
          const candidate = validateAskUserArgs(parseToolArgs(toolCall));
          let decision = deterministicPolicy(candidate);

          if (decision.action === 'defer' && deferredQueue && deferredQueue.isAtBudget()) {
            decision = { action: 'reject', reason: `deferred question budget exhausted (${deferredQueue.maxDeferred}); using safe_default` };
          }

          if (decision.action === 'approve') {
            result = { ok: true, result: { gate: 'approved', answer: 'User has approved this question via gate.' } };
          } else if (decision.action === 'review') {
            const reviewResult = await reviewQuestion(root, config, prompt, candidate, options);
            if (reviewResult.approved) {
              result = { ok: true, result: { gate: 'review_approved', answer: reviewResult.reason || 'Reviewer approved.' } };
            } else {
              result = { ok: true, result: { gate: 'review_rejected', safe_default: candidate.safe_default, reason: reviewResult.reason } };
              if (candidate.blocking) status = 'blocked';
            }
          } else {
            result = { ok: true, result: { gate: decision.action, safe_default: candidate.safe_default, reason: decision.reason } };
            if (decision.action === 'defer') {
              deferredQueue.push({ turn, question: candidate.question, reason: candidate.reason, risk_type: candidate.risk_type, files: candidate.files, safe_default: candidate.safe_default, blocking: candidate.blocking, tool_call_id: toolCall.id });
            }
            if (candidate.blocking && decision.action === 'reject') {
              status = 'blocked';
            }
          }
        } else if (name === 'ask_user' && !isAutonomous) {
          result = { ok: false, error: 'ask_user tool requires autonomous mode. Run with --dont-ask or set harness.autonomous_mode true.' };
        } else {
          result = normalizeToolExecution(name, await executeTool(root, active, toolCall, { ...options, root, config, toolHandlers: allHandlers }));
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
  trace.autonomous = isAutonomous;
  trace.status = 'max_turns';
  if (deferredQueue) trace.deferred_questions = deferredQueue.getAll();
  await recordTaskTrace(root, { ...trace, final_text: text, stopped_after_max_turns: true, duration_ms: Date.now() - started });
  await scheduleBackgroundReview(root);
  const result = { text, messages, status: 'max_turns', autonomous: isAutonomous };
  if (deferredQueue) {
    result.deferredQuestions = deferredQueue.getAll();
    if (options.interactive) process.stdout.write(deferredQueue.toReport());
  }
  return result;
  } finally {
    if (mcpManager) {
      await mcpManager.shutdown().catch(() => {});
    }
  }
}

async function startChat(root, options = {}) {
  return baseStartChat(root, options, { runAgentTask });
}

module.exports = {
  TOOL_SCHEMAS,
  systemPrompt,
  runAgentTask,
  handleSlashCommand,
  isGitReversibleFileAction,
  startChat
};
