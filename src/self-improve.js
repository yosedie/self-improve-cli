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

async function sandboxEvaluateCandidate(root, patch, options = {}) {
  const { poolSize = 4, timeoutMs = 120000 } = options;

  const { applyJsonPatch } = await import('./profile.js');
  const { loadProfiles } = await import('./state.js');
  const { base, overlay } = await loadProfiles(root);
  const patchedOverlay = applyJsonPatch(overlay, patch);
  const candidateActive = { ...base, ...patchedOverlay };

  const benchmarkTasks = await loadBenchmarkTasks(root);

  const failureTraces = await loadFailureTraces(root);

  const allTasks = [
    ...benchmarkTasks.map(t => ({ type: 'synthetic', ...t })),
    ...failureTraces.map(t => ({ type: 'trace', ...t }))
  ];

  const { WorkerPool } = await import('./sandbox/worker_pool.js');
  const pool = new WorkerPool({ poolSize });
  let results;
  try {
    results = await pool.runWithTimeout(allTasks, candidateActive, timeoutMs);
  } catch (err) {
    return { passed: false, reason: `sandbox_timeout: ${err.message}`, failure_rate: 1.0 };
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  const failure_rate = failed / results.length;

  const { validateProfile } = await import('./profile.js');
  const validation = validateProfile(candidateActive, 'candidate harness');
  if (!validation.valid) {
    return { passed: false, reason: `structural_invalid: ${validation.error}`, failure_rate: 1.0 };
  }

  const baseline_rate = 0.5;
  const passed_growth_gate = failure_rate < baseline_rate;

  return {
    passed: passed_growth_gate,
    reason: passed_growth_gate
      ? `failure_rate=${failure_rate.toFixed(3)} < ${baseline_rate}`
      : `failure_rate=${failure_rate.toFixed(3)} >= ${baseline_rate}`,
    failure_rate,
    total_tasks: results.length,
    passed_tasks: passed,
    tokens_used: results.reduce((sum, r) => sum + (r.tokens || 0), 0),
    duration_ms: results.reduce((sum, r) => sum + (r.duration_ms || 0), 0)
  };
}

async function loadBenchmarkTasks(root) {
  const fs = require('fs');
  const benchmarkDir = path.join(root, 'meta-harness', 'experiments', 'benchmark_tasks');
  const tasks = [];
  for (let i = 1; i <= 10; i++) {
    const fp = path.join(benchmarkDir, `task_${String(i).padStart(3, '0')}.json`);
    try {
      const content = await fs.promises.readFile(fp, 'utf8');
      tasks.push({ id: `task_${i}`, ...JSON.parse(content) });
    } catch {}
  }
  return tasks;
}

async function loadFailureTraces(root) {
  const { readRecentJsonLines } = await import('./state.js');
  const traces = await readRecentJsonLines(path.join(root, '.selfimprove', 'traces.jsonl'), { limit: 100 });
  return traces.filter(t => t.outcome === 'failure' || t.error).slice(0, 20);
}

function applyProposerOutput(rawOutput, fallbackPrompt) {
  const cleaned = (rawOutput || '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0) return { patches: parsed, parse_method: 'direct' };
    if (parsed.patch || parsed.patches) return { patches: Array.isArray(parsed.patch) ? parsed.patch : [parsed.patch], parse_method: 'direct' };
    if (parsed.patches) return { patches: parsed.patches, parse_method: 'direct' };
  } catch {}

  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      const inner = codeBlockMatch[1].trim();
      const parsed = JSON.parse(inner);
      if (Array.isArray(parsed)) return { patches: parsed, parse_method: 'code_block' };
      if (parsed.patch || parsed.patches) return { patches: Array.isArray(parsed.patch) ? parsed.patch : [parsed.patch], parse_method: 'code_block' };
      if (parsed.patches) return { patches: parsed.patches, parse_method: 'code_block' };
    } catch {}
  }

  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    try {
      const substring = cleaned.substring(objStart, objEnd + 1);
      const parsed = JSON.parse(substring);
      if (Array.isArray(parsed)) return { patches: parsed, parse_method: 'brace_match' };
      if (parsed.patch || parsed.patches) return { patches: Array.isArray(parsed.patch) ? parsed.patch : [parsed.patch], parse_method: 'brace_match' };
      if (parsed.patches) return { patches: parsed.patches, parse_method: 'brace_match' };
    } catch {}
  }

  const patchesMatch = cleaned.match(/"patches"\s*:\s*\[([\s\S]*?)\]/);
  if (patchesMatch) {
    try {
      const arrStr = '[' + patchesMatch[1] + ']';
      const parsed = JSON.parse(arrStr);
      if (parsed.length > 0) return { patches: parsed, parse_method: 'array_extract' };
    } catch {}
  }

  const linePatches = [];
  const lines = cleaned.split('\n');
  let currentPatch = null;
  for (const line of lines) {
    const opMatch = line.match(/"op"\s*:\s*"(add|remove|replace|test)"/);
    const pathMatch = line.match(/"path"\s*:\s*"([^"]+)"/);
    const valueMatch = line.match(/"value"\s*:\s*(".*"|[\d\w]+)/);
    if (opMatch) {
      if (currentPatch) linePatches.push(currentPatch);
      currentPatch = { op: opMatch[1] };
    }
    if (currentPatch && pathMatch) currentPatch.path = pathMatch[1];
    if (currentPatch && valueMatch) currentPatch.value = JSON.parse(valueMatch[1]);
  }
  if (currentPatch) linePatches.push(currentPatch);
  if (linePatches.length > 0) return { patches: linePatches, parse_method: 'line_extract' };

  return { patches: [], parse_method: 'fallback', reason: 'all_parse_attempts_failed' };
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
    const cmdParts = [tool.raw_args?.command, ...(Array.isArray(tool.raw_args?.args) ? tool.raw_args.args : [])];
    if (tool.name === 'run_command' && /[><|]|cat|printf|echo/.test(cmdParts.join(' '))) {
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

async function diagnoseFailures(failures, recentPatches = []) {
  const mmxResult = await callMmxProposer({ type: 'diagnose', failures, recentPatches });
  if (mmxResult) return parseProposerDiagnosis(mmxResult);

  const { root } = globalThis._selfImproveRoot ? { root: globalThis._selfImproveRoot } : { root: process.cwd() };
  const { chatCompletion } = await import('./provider.js');
  const { loadProfiles } = await import('./state.js');
  const { base } = await loadProfiles(root);

  const systemPrompt = buildProposerSystemPrompt(base);
  const userPrompt = buildProposerDiagnosisUserPrompt(failures, recentPatches);

  let response;
  try {
    response = await chatCompletion(root, {}, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);
  } catch (err) {
    return staticDiagnoseFailures(failures);
  }

  const msg = response.message || response;
  const content = typeof msg === 'string' ? msg : (msg.content || '');
  return parseProposerDiagnosis(content);
}

async function buildHarnessPatch(diagnosis) {
  const mmxResult = await callMmxProposer({ type: 'patch', diagnosis });
  if (mmxResult) {
    const { patches } = applyProposerOutput(mmxResult);
    if (patches.length > 0) return patches;
  }

  const { root } = globalThis._selfImproveRoot ? { root: globalThis._selfImproveRoot } : { root: process.cwd() };
  const { chatCompletion } = await import('./provider.js');
  const { loadProfiles } = await import('./state.js');
  const { base } = await loadProfiles(root);

  const systemPrompt = buildProposerSystemPrompt(base);
  const userPrompt = buildProposerPatchUserPrompt(diagnosis);

  let response;
  try {
    response = await chatCompletion(root, {}, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);
  } catch (err) {
    return staticBuildHarnessPatch(diagnosis);
  }

  const msg = response.message || response;
  const content = typeof msg === 'string' ? msg : (msg.content || '');
  const { patches } = applyProposerOutput(content);
  return patches.length > 0 ? patches : staticBuildHarnessPatch(diagnosis);
}

async function callMmxProposer({ type, failures, recentPatches, diagnosis }) {
  try {
    const { execSync } = require('child_process');
    let prompt;
    if (type === 'diagnose') {
      prompt = `Diagnose these harness failures and suggest what harness config changes would fix them:\n\nFailures:\n${failures.map(f => `- ${f}`).join('\n')}\n\nRecent patches:\n${recentPatches.slice(-3).map(p => `- ${JSON.stringify(p)}`).join('\n')}\n\nReturn JSON with {patterns: [...], suggestions: [...]}`;
    } else {
      prompt = `Based on this diagnosis, propose JSON patch operations to fix the harness:\n\n${JSON.stringify(diagnosis)}\n\nReturn JSON patch array [{op, path, value},...] to apply to overlay.profile.json. Only modify paths under /harness/.`;
    }

    const cmd = `npx mmx text chat --message "user:${prompt}" --output json --quiet --non-interactive`;
    const output = execSync(cmd, { cwd: process.cwd(), timeout: 30000 });
    const parsed = JSON.parse(output.toString());
    return parsed.content || parsed.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

function buildProposerSystemPrompt(baseProfile) {
  return `You are an expert meta-harness engineer. You analyze AI coding agent failure patterns and propose precise JSON patches to the agent's harness configuration.

Harness profile (base):
${JSON.stringify(baseProfile, null, 2)}

Rules:
- Only propose patches under /harness/ paths
- Never modify /id, /version, /growth/level, /growth/auto_apply, /memory/mcp_config, /memory/active_skills
- max_patch_ops per iteration: 3
- Each patch must have op (add|remove|replace), path (JSON Pointer), and value
- Return ONLY valid JSON, no markdown, no explanation outside JSON`;
}

function buildProposerDiagnosisUserPrompt(failures, recentPatches) {
  return `Analyze these failures and recent patches:

Failures:
${failures.map(f => `- ${f}`).join('\n')}

Recent patches (last 3):
${recentPatches.slice(-3).map(p => `- ${JSON.stringify(p)}`).join('\n')}

Return JSON:
{
  "patterns": ["pattern1", "pattern2"],
  "suggestions": ["suggestion1", "suggestion2"],
  "root_cause": "what is the underlying issue"
}`;
}

function buildProposerPatchUserPrompt(diagnosis) {
  return `Based on this diagnosis, generate JSON patch operations:

${JSON.stringify(diagnosis, null, 2)}

Return JSON array of patch operations:
[{op: "replace", path: "/harness/max_tool_turns", value: 10}, ...]`;
}

function parseProposerDiagnosis(content) {
  const { patches } = applyProposerOutput(content);
  if (patches.length > 0) {
    return {
      patterns: patches.map(p => p.path),
      suggestions: patches.map(p => `${p.op} ${p.path}`),
      root_cause: 'from_model'
    };
  }
  return staticDiagnoseFailures([]);
}

function staticDiagnoseFailures(failures) {
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

  return { patterns, suggestions, root_cause: 'static_regex' };
}

function staticBuildHarnessPatch(diagnosis) {
  const patches = [];
  const s = diagnosis.suggestions || [];
  if (s.some(x => /max_history_messages|context/i.test(x))) {
    patches.push({ op: 'replace', path: '/harness/max_history_messages', value: 20 });
  }
  if (s.some(x => /max_tool_turns|timeout/i.test(x))) {
    patches.push({ op: 'replace', path: '/harness/max_tool_turns', value: 15 });
  }
  if (s.some(x => /compact.*tool.*results|compact.*limit/i.test(x))) {
    patches.push({ op: 'replace', path: '/harness/compact_tool_results', value: true });
    patches.push({ op: 'replace', path: '/harness/compact_limit', value: 1500 });
  }
  return patches;
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


async function listCandidates(root) {
  const { listCandidates: lc } = await import('./state.js');
  return lc(root);
}

async function loadCandidateScores(root, id) {
  const { loadCandidateScores: lcs } = await import('./state.js');
  return lcs(root, id);
}

async function promoteCandidate(root, id) {
  const { promoteCandidate: pc } = await import('./state.js');
  return pc(root, id);
}

function computeParetoFrontier(candidates) {
  const dominated = new Set();
  const frontier = [];

  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const a = candidates[i];
      const b = candidates[j];
      if (
        a.failure_rate <= b.failure_rate &&
        a.context_cost <= b.context_cost &&
        (a.failure_rate < b.failure_rate || a.context_cost < b.context_cost)
      ) {
        dominated.add(j);
      }
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    if (!dominated.has(i)) frontier.push(candidates[i]);
  }

  return frontier.sort((a, b) => a.id - b.id);
}

async function evaluateParetoFrontier(root) {
  const candidates = await listCandidates(root);
  if (candidates.length === 0) return [];

  const scored = [];
  for (const id of candidates) {
    try {
      const scores = await loadCandidateScores(root, id);
      scored.push({ id, ...scores });
    } catch {}
  }

  return computeParetoFrontier(scored);
}

async function criticEvaluate(patch, harnessSpec, context) {
  const mmxResult = await callMmxCritic({ patch, harnessSpec, context });
  if (mmxResult) return parseCriticOutput(mmxResult);

  const { root } = globalThis._selfImproveRoot ? { root: globalThis._selfImproveRoot } : { root: process.cwd() };
  const { chatCompletion } = await import('./provider.js');

  const systemPrompt = `You are a senior harness engineer and critic. You evaluate proposed JSON patches to an AI agent's harness configuration. Be rigorous — only approve patches that are:
1. Targeted at a real, identified failure
2. Not overly broad or aggressive
3. Within protected path boundaries
4. Unlikely to cause regression

Approve only the clearest, strongest patches. "Only the greatest and the best may pass."`;

  const userPrompt = `Critique this patch proposal:

Harness spec:
${JSON.stringify(harnessSpec, null, 2)}

Patch:
${JSON.stringify(patch, null, 2)}

Context:
${JSON.stringify(context, null, 2)}

Return JSON:
{
  "approved": true or false,
  "reasoning": "why you approve or reject",
  "suggested_refinements": ["refinement1"]
}`;

  try {
    const response = await chatCompletion(root, {}, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);
    const msg = response.message || response;
    const content = typeof msg === 'string' ? msg : (msg.content || '');
    return parseCriticOutput(content);
  } catch (err) {
    return { approved: false, reasoning: 'critic_unavailable', suggested_refinements: [] };
  }
}

async function callMmxCritic({ patch, harnessSpec, context }) {
  try {
    const { execSync } = require('child_process');
    const prompt = `Critique this harness patch:

Patch: ${JSON.stringify(patch)}

Return JSON with {approved: bool, reasoning: string, suggested_refinements: [string]}`;

    const cmd = `npx mmx text chat --message "user:${prompt}" --output json --quiet --non-interactive`;
    const output = execSync(cmd, { cwd: process.cwd(), timeout: 30000 });
    const parsed = JSON.parse(output.toString());
    return parsed.content || parsed.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

function parseCriticOutput(content) {
  try {
    const approvedMatch = content.match(/"approved"\s*:\s*(true|false)/i);
    const reasoningMatch = content.match(/"reasoning"\s*:\s*"([^"]+)"/i);
    const refinementsMatch = content.match(/"suggested_refinements"\s*:\s*\[([^\]]*)\]/);

    return {
      approved: approvedMatch ? approvedMatch[1] === 'true' : false,
      reasoning: reasoningMatch ? reasoningMatch[1] : 'parse_failed',
      suggested_refinements: refinementsMatch ? refinementsMatch[1].split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean) : []
    };
  } catch {
    return { approved: false, reasoning: 'parse_error', suggested_refinements: [] };
  }
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
  buildHarnessPatch,
  staticDiagnoseFailures,
  staticBuildHarnessPatch,
  listCandidates,
  loadCandidateScores,
  promoteCandidate,
  computeParetoFrontier,
  evaluateParetoFrontier,
  criticEvaluate,
  applyProposerOutput
};
