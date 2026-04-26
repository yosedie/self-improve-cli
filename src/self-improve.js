'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { evaluatePatch, suggestPatchFromEvent, deepMerge, applyJsonPatch, validateProfile } = require('./profile');
const { loadConfig } = require('./config');
const {
  loadProfiles,
  appendEvent,
  appendTrace,
  appendPatchAudit,
  applyPatchToOverlay,
  getSelfImproveStatus,
  readAllJsonLines,
  readRecentJsonLines,
  readOptimizerState,
  writeOptimizerState,
  statePath,
  rollbackToBackup,
  recordFailedPatch
} = require('./state');

const DEMO_MESSAGE = 'agent used run_command shell redirection for file creation';

async function sandboxEvaluateCandidate(root, patch) {
  const { base, overlay } = await loadProfiles(root);
  try {
    const candidateOverlay = applyJsonPatch(overlay, patch);
    const candidateActive = deepMerge(base, candidateOverlay);
    validateProfile(candidateActive, 'candidate harness');
    const gate = evaluatePatch(candidateActive, patch, { manual: true });
    if (!gate.allowed) {
      return { passed: false, reason: 'patch blocked by growth gate: ' + gate.reason };
    }
    return { passed: true, reason: 'sandbox validation passed' };
  } catch (err) {
    return { passed: false, reason: 'sandbox validation failed: ' + err.message };
  }
}

async function proposePatch(root, patch) {
  const sandbox = await sandboxEvaluateCandidate(root, patch);
  if (!sandbox.passed) {
    return { proposed: false, reason: sandbox.reason };
  }
  const { overlay } = await applyPatchToOverlay(root, patch);
  const evalResult = await evaluateAppliedPatch(root, patch);
  return {
    proposed: true,
    applied: !evalResult.failed,
    sandbox,
    eval: evalResult
  };
}

async function evaluateAppliedPatch(root, patch) {
  const traces = await readAllJsonLines(statePath(root, 'traces.jsonl'), { limit: 10 });
  const recentFailures = traces.filter(t =>
    t.tools?.some(tool => !tool.ok) || t.stopped_after_max_turns
  );

  if (recentFailures.length < 1) {
    return { sufficient: true, reason: 'no recent failures to compare against' };
  }

  const patchHash = JSON.stringify(patch);
  const sameFailureCount = recentFailures.filter(t => {
    const messages = traceFailureMessages(t);
    return messages.length > 0;
  }).length;

  const optimizer = await readOptimizerState(root);
  const tracesSincePatch = traces.slice(optimizer.last_trace_count || 0);
  const sameFailureSince = tracesSincePatch.filter(t =>
    t.tools?.some(tool => !tool.ok) || t.stopped_after_max_turns
  ).length;

  if (sameFailureSince >= 2) {
    await rollbackToBackup(root);
    await recordFailedPatch(root, patch, `failure recurred ${sameFailureSince} times after patch`);
    return { sufficient: false, reason: `failure recurred ${sameFailureSince} times after patch`, failed: true };
  }

  return { sufficient: true, reason: `failure not seen in last ${tracesSincePatch.length} traces` };
}

async function learnFromMessage(root, message, { apply = false, type = 'lesson', source = 'manual' } = {}) {
  const { active } = await loadProfiles(root);
  const event = await appendEvent(root, { type, source, message });
  const suggestion = suggestPatchFromEvent(event);
  const gate = evaluatePatch(active, suggestion.patch, { manual: apply });
  const audit = { event, patch: suggestion.patch, gate, applied: false };
  if (gate.allowed && (gate.auto || apply)) {
    await applyPatchToOverlay(root, suggestion.patch);
    audit.applied = true;
    audit.eval = await evaluateAppliedPatch(root, suggestion.patch);
    if (audit.eval?.failed) {
      audit.rollback = await rollbackToBackup(root);
    }
  }
  await appendPatchAudit(root, audit);
  return {
    event,
    suggestion,
    audit,
    status: await getSelfImproveStatus(root)
  };
}

async function runDemo(root, options = {}) {
  return learnFromMessage(root, DEMO_MESSAGE, { ...options, type: 'demo_failure', source: 'demo' });
}

function traceFailureMessages(trace) {
  const messages = [];
  if (trace.stopped_after_max_turns) messages.push(`Stopped after max tool turns for prompt "${trace.prompt}"`);
  for (const tool of trace.tools || []) {
    if (tool.ok === false) messages.push(`${tool.name} failed during prompt "${trace.prompt}": ${tool.error || 'unknown error'}`);
    if (tool.name === 'run_command' && /[><|]|cat|printf|echo/.test(String(tool.raw_args?.command || tool.raw_args?.args || ''))) {
      messages.push(`agent used run_command shell redirection for file creation during prompt "${trace.prompt}"`);
    }
  }
  return messages;
}

function traceLearningMessages(trace) {
  const messages = traceFailureMessages(trace);
  const prompt = String(trace.prompt || '').trim().replace(/\s+/g, ' ');
  const lower = prompt.toLowerCase();
  if (/(skripsi|tugas akhir|thesis).*(quantum|qiskit|cirq|projectq)/.test(lower)) {
    messages.push(`User project context: ${prompt.slice(0, 240)}`);
  }
  if (/tanpa basic quantum|tanpa dasar quantum|without quantum background/.test(lower)) {
    messages.push('User project context: user is an informatics student working on quantum computing without prior quantum background');
  }
  return [...new Set(messages)];
}

async function recordTaskTrace(root, trace) {
  return appendTrace(root, {
    type: 'task_trace',
    prompt: trace.prompt,
    final_text: trace.final_text || '',
    stopped_after_max_turns: Boolean(trace.stopped_after_max_turns),
    tools: trace.tools || [],
    duration_ms: trace.duration_ms || 0
  });
}

async function runBackgroundReview(root, { limit = 20 } = {}) {
  const config = await loadConfig(root);
  const traces = await readAllJsonLines(statePath(root, 'traces.jsonl'));
  const optimizer = await readOptimizerState(root);
  const newTraces = traces.slice(optimizer.last_trace_count).slice(-limit);
  const results = [];
  if (!newTraces.length) {
    await writeOptimizerState(root, { ...optimizer, last_run_at: new Date().toISOString(), last_trace_count: traces.length });
    return { reviewed: 0, results, status: await getSelfImproveStatus(root) };
  }
  for (const trace of newTraces) {
    for (const message of traceLearningMessages(trace)) {
      results.push(await learnFromMessage(root, message, { type: 'background_review', source: 'background' }));
    }
  }
  await writeOptimizerState(root, {
    last_run_at: new Date().toISOString(),
    last_trace_count: traces.length,
    reviewed_traces: newTraces.length,
    proposed_patches: results.length
  });
  return { reviewed: newTraces.length, results, status: await getSelfImproveStatus(root) };
}

function diagnoseFailures(failures, recentPatches) {
  const patterns = {
    maxTurnsExceeded: failures.some(f => f.stopped_after_max_turns),
    toolErrors: failures.flatMap(f => f.failed_tools).filter(t => t.error),
    shellRedirection: failures.flatMap(f => f.failed_tools).some(t =>
      t.name === 'run_command' && /[><|]/.test(String(t.command || ''))
    ),
    missingContext: failures.flatMap(f => f.failed_tools).some(t =>
      t.name === 'read_file' && t.error?.includes('ENOENT')
    )
  };

  const suggestions = [];
  if (patterns.maxTurnsExceeded) {
    suggestions.push('Increase max_tool_turns or add failure recovery to prevent loops');
  }
  if (patterns.shellRedirection) {
    suggestions.push('Add rule: use write_file not run_command for file creation');
  }
  if (patterns.missingContext) {
    suggestions.push('Add rule: verify file existence before reading');
  }

  return { patterns, suggestions };
}

function buildHarnessPatch(diagnosis) {
  const patch = [];
  if (diagnosis.patterns.maxTurnsExceeded) {
    patch.push({ op: 'replace', path: '/harness/max_tool_turns', value: 12 });
  }
  if (diagnosis.patterns.shellRedirection) {
    patch.push({ op: 'add', path: '/rules/-', value: 'For new files, use write_file instead of run_command or shell redirection.' });
  }
  return patch;
}

async function runSelfImprovePropose(root, options = {}) {
  const traces = await readAllJsonLines(statePath(root, 'traces.jsonl'), { limit: options.limit || 20 });
  const optimizer = await readOptimizerState(root);

  const failures = traces.filter(t =>
    t.tools?.some(tool => !tool.ok) || t.stopped_after_max_turns
  );

  if (failures.length === 0) {
    return { proposed: false, reason: 'no recent failures', stable: true };
  }

  const failureSummary = failures.map((t, i) => {
    const failedTools = t.tools?.filter(tool => !tool.ok) || [];
    return {
      index: i,
      prompt: t.prompt,
      stopped_after_max_turns: t.stopped_after_max_turns,
      failed_tools: failedTools.map(tool => ({
        name: tool.name,
        error: tool.error,
        command: tool.raw_args?.command,
        path: tool.raw_args?.path,
        args: tool.raw_args?.args
      }))
    };
  });

  const recentPatches = await readRecentJsonLines(statePath(root, 'patches.jsonl'), 10);

  const diagnosis = diagnoseFailures(failureSummary, recentPatches);

  const patch = buildHarnessPatch(diagnosis);

  if (!patch || patch.length === 0) {
    return { proposed: false, reason: 'no patch candidate generated', diagnosis };
  }

  if (options.dryRun) {
    const sandbox = await sandboxEvaluateCandidate(root, patch);
    return { proposed: true, dryRun: true, patch, diagnosis, sandbox };
  }

  const result = await proposePatch(root, patch);
  return { ...result, diagnosis, patch };
}

async function scheduleBackgroundReview(root) {
  const config = await loadConfig(root);
  if (!config.self_improve_background) return { scheduled: false, reason: 'background disabled' };
  const traces = await readAllJsonLines(statePath(root, 'traces.jsonl'));
  const optimizer = await readOptimizerState(root);
  const pending = traces.length - (optimizer.last_trace_count || 0);
  if (pending < config.self_improve_review_every) return { scheduled: false, reason: `pending traces ${pending}` };
  const bin = path.resolve(__dirname, '..', 'bin', 'self-improve-cli.js');
  const child = spawn(process.execPath, [bin, 'self-improve', 'background-run', '--quiet'], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return { scheduled: true, pending };
}

module.exports = {
  DEMO_MESSAGE,
  learnFromMessage,
  runDemo,
  recordTaskTrace,
  runBackgroundReview,
  runSelfImprovePropose,
  scheduleBackgroundReview,
  traceFailureMessages,
  traceLearningMessages,
  evaluateAppliedPatch,
  sandboxEvaluateCandidate,
  proposePatch,
  diagnoseFailures,
  buildHarnessPatch
};
