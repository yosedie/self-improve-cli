'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { evaluatePatch, suggestPatchFromEvent } = require('./profile');
const { loadConfig } = require('./config');
const {
  loadProfiles,
  appendEvent,
  appendTrace,
  appendPatchAudit,
  applyPatchToOverlay,
  getSelfImproveStatus,
  readAllJsonLines,
  readOptimizerState,
  writeOptimizerState,
  statePath
} = require('./state');

const DEMO_MESSAGE = 'agent used run_command shell redirection for file creation';

async function learnFromMessage(root, message, { apply = false, type = 'lesson', source = 'manual' } = {}) {
  const { active } = await loadProfiles(root);
  const event = await appendEvent(root, { type, source, message });
  const suggestion = suggestPatchFromEvent(event);
  const gate = evaluatePatch(active, suggestion.patch, { manual: apply });
  const audit = { event, patch: suggestion.patch, gate, applied: false };
  if (gate.allowed && (gate.auto || apply)) {
    await applyPatchToOverlay(root, suggestion.patch);
    audit.applied = true;
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
    if (tool.name === 'run_command' && /[><|]|cat|printf|echo/.test(JSON.stringify(tool.args || {}))) {
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
  scheduleBackgroundReview,
  traceFailureMessages,
  traceLearningMessages
};
