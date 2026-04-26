#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const { GROWTH_LEVELS, compileProfilePrompt, evaluatePatch, suggestPatchFromEvent } = require('../src/profile');
const { initWorkspace, loadProfiles, appendEvent, appendPatchAudit, applyPatchToOverlay, setGrowthLevel, getSelfImproveStatus, getStatus } = require('../src/state');
const { readFileTool, searchTool, runCommandTool, writeFileTool, editFileTool } = require('../src/tools');
const { loadConfig, setConfigValue, listPermissionModes, setPermissionMode } = require('../src/config');
const { runAgentTask, startChat } = require('../src/agent');
const { learnFromMessage, runDemo, runBackgroundReview } = require('../src/self-improve');

function usage() {
  return `sicli - lightweight self-improve coding CLI

Usage:
  sicli
  sicli chat [prompt...] [--yes] [--trace]
  sicli config show
  sicli config get <key>
  sicli config set <key> <value>
  sicli permissions [secure|partial_secure|ai_reviewed|auto_approve]
  sicli init
  sicli status
  sicli profile [--json|--prompt]
  sicli growth <none|low|medium|high|very_high> [--auto-apply true|false]
  sicli observe --type <kind> --message <text>
  sicli improve --type <kind> --message <text> [--apply]
  sicli self-improve status
  sicli self-improve demo [--apply]
  sicli self-improve learn <message> [--apply]
  sicli self-improve background-run [--quiet]
  sicli apply-patch <patch.json>
  sicli tool read <file>
  sicli tool search <text> [dir]
  sicli tool run <cmd> [args...]
  sicli tool write <file> <content>
  sicli tool edit <file> <old_text> <new_text>

Notes:
  - State lives in .selfimprove/.
  - Base profile is immutable; overlay profile mutates.
  - Commands run with shell=false for portability.
`;
}

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(item);
    }
  }
  return { flags, rest };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function maybeApplyPatch(root, active, patch, event, manual) {
  const gate = evaluatePatch(active, patch, { manual });
  const audit = {
    event,
    patch,
    gate,
    applied: false
  };
  if (gate.allowed && (gate.auto || manual)) {
    await applyPatchToOverlay(root, patch);
    audit.applied = true;
  }
  await appendPatchAudit(root, audit);
  return audit;
}

async function main() {
  const root = process.cwd();
  const [command, ...args] = process.argv.slice(2);
  const { flags, rest } = command === 'tool' ? { flags: {}, rest: args } : parseFlags(args);

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return;
  }

  if (!command) {
    await startChat(root, { interactive: true });
    return;
  }

  if (command === 'init') {
    const dir = await initWorkspace(root);
    printJson({ ok: true, state_dir: dir });
    return;
  }

  if (command === 'status') {
    printJson(await getStatus(root));
    return;
  }

  if (command === 'config') {
    const [action, key, ...valueParts] = rest;
    if (!action || action === 'show') {
      printJson(await loadConfig(root));
      return;
    }
    if (action === 'get') {
      const config = await loadConfig(root);
      printJson({ [key]: config[key] });
      return;
    }
    if (action === 'set') {
      printJson(await setConfigValue(root, key, valueParts.join(' ')));
      return;
    }
    throw new Error(`unknown config action: ${action}`);
  }

  if (command === 'chat') {
    const prompt = rest.join(' ').trim();
    if (!prompt) {
      await startChat(root, { interactive: true, yes: Boolean(flags.yes), trace: Boolean(flags.trace) });
      return;
    }
    const result = await runAgentTask(root, prompt, { interactive: false, yes: Boolean(flags.yes), trace: Boolean(flags.trace) });
    process.stdout.write(`${result.text}\n`);
    return;
  }

  if (command === 'self-improve') {
    const [action, ...messageParts] = rest;
    if (!action || action === 'status') {
      printJson(await getSelfImproveStatus(root));
      return;
    }
    if (action === 'demo') {
      printJson(await runDemo(root, { apply: Boolean(flags.apply) }));
      return;
    }
    if (action === 'learn') {
      const message = messageParts.join(' ');
      if (!message) throw new Error('usage: self-improve learn <message> [--apply]');
      printJson(await learnFromMessage(root, message, { apply: Boolean(flags.apply), type: 'user_lesson' }));
      return;
    }
    if (action === 'background-run') {
      const result = await runBackgroundReview(root);
      if (!flags.quiet) printJson(result);
      return;
    }
    throw new Error(`unknown self-improve action: ${action}`);
  }

  if (command === 'permissions') {
    const mode = rest[0];
    if (!mode) {
      const config = await loadConfig(root);
      printJson({ current: config.permission_mode, modes: listPermissionModes() });
      return;
    }
    const config = await setPermissionMode(root, mode);
    printJson({ ok: true, permission_mode: config.permission_mode });
    return;
  }

  if (command === 'profile') {
    const { active } = await loadProfiles(root);
    if (flags.prompt) process.stdout.write(`${compileProfilePrompt(active)}\n`);
    else printJson(active);
    return;
  }

  if (command === 'growth') {
    const level = rest[0];
    if (!GROWTH_LEVELS.has(level)) throw new Error(`growth level must be one of ${Array.from(GROWTH_LEVELS).join(', ')}`);
    const options = {};
    if (flags['auto-apply'] !== undefined) options.auto_apply = String(flags['auto-apply']) === 'true';
    const { active } = await setGrowthLevel(root, level, options);
    printJson({ ok: true, growth: active.growth });
    return;
  }

  if (command === 'observe') {
    const event = await appendEvent(root, {
      type: flags.type || 'note',
      message: flags.message || rest.join(' ')
    });
    printJson({ ok: true, event });
    return;
  }

  if (command === 'improve') {
    const { active } = await loadProfiles(root);
    const event = await appendEvent(root, {
      type: flags.type || 'failure',
      message: flags.message || rest.join(' ')
    });
    const suggestion = suggestPatchFromEvent(event);
    const audit = await maybeApplyPatch(root, active, suggestion.patch, event, Boolean(flags.apply));
    printJson({ ok: true, suggestion, audit });
    return;
  }

  if (command === 'apply-patch') {
    const patchFile = rest[0];
    if (!patchFile) throw new Error('patch file required');
    const patch = JSON.parse(await fs.readFile(patchFile, 'utf8'));
    const { active } = await loadProfiles(root);
    const audit = await maybeApplyPatch(root, active, patch, { type: 'manual_patch', patchFile }, true);
    printJson({ ok: audit.applied, audit });
    return;
  }

  if (command === 'tool') {
    const [tool, ...toolArgs] = rest;
    if (tool === 'read') {
      printJson(await readFileTool(root, toolArgs[0]));
      return;
    }
    if (tool === 'search') {
      printJson(await searchTool(root, toolArgs[0], toolArgs[1] || '.'));
      return;
    }
    if (tool === 'run') {
      printJson(await runCommandTool(root, toolArgs[0], toolArgs.slice(1)));
      return;
    }
    if (tool === 'write') {
      printJson(await writeFileTool(root, toolArgs[0], toolArgs.slice(1).join(' ')));
      return;
    }
    if (tool === 'edit') {
      printJson(await editFileTool(root, toolArgs[0], toolArgs[1], toolArgs[2] || ''));
      return;
    }
    throw new Error(`unknown tool: ${tool || '(missing)'}`);
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 1;
});
