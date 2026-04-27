'use strict';

const RISK_TYPES = new Set([
  'clarification',
  'file_write',
  'file_delete',
  'command_exec',
  'external_dependency',
  'api_key',
  'permission',
  'other'
]);

const NEVER_ASK_PATTERNS = [
  /should i (continue|go on|proceed)/i,
  /should i (run tests?|execute tests?)/i,
  /should i (fix lint|fix formatting)/i,
  /should i add (tests?|validation)/i,
  /should i (retry|try again)/i,
  /what('s| is) next/i,
  /do you want me to (continue|proceed)/i,
  /(shall|may) i continue/i
];

const ALWAYS_REVIEW_TYPES = new Set([
  'file_delete',
  'command_exec',
  'external_dependency',
  'api_key',
  'permission'
]);

const REVIEW_IF_BLOCKING_TYPES = new Set([
  'permission'
]);

function validateAskUserArgs(args) {
  if (!args || typeof args !== 'object') throw new Error('ask_user args must be an object');
  const question = String(args.question || '').trim();
  const reason = String(args.reason || '').trim();
  const riskType = String(args.risk_type || '').trim();
  const safeDefault = String(args.safe_default || '').trim();
  if (!question) throw new Error('ask_user question is required');
  if (!reason) throw new Error('ask_user reason is required');
  if (!riskType) throw new Error('ask_user risk_type is required');
  if (!RISK_TYPES.has(riskType)) throw new Error(`ask_user risk_type must be one of ${Array.from(RISK_TYPES).join(', ')}`);
  if (!safeDefault) throw new Error('ask_user safe_default is required');
  const files = Array.isArray(args.files) ? args.files.map(String) : [];
  const blocking = Boolean(args.blocking);
  return { question, reason, risk_type: riskType, files, safe_default: safeDefault, blocking };
}

function deterministicPolicy(candidate) {
  const { question, risk_type: riskType, blocking } = candidate;

  for (const pattern of NEVER_ASK_PATTERNS) {
    if (pattern.test(question)) {
      return { action: 'reject', reason: 'question matches never_ask pattern (agent should decide itself)' };
    }
  }

  if (REVIEW_IF_BLOCKING_TYPES.has(riskType) && blocking) {
    return { action: 'review', reason: `risk_type=${riskType} blocking question requires clean-context review` };
  }

  if (ALWAYS_REVIEW_TYPES.has(riskType)) {
    if (blocking) {
      return { action: 'reject', reason: `risk_type=${riskType} is high-risk; use safe_default and continue` };
    }
    return { action: 'defer', reason: `risk_type=${riskType} is high-risk but non-blocking; defer to end` };
  }

  if (!blocking) {
    return { action: 'defer', reason: 'non-blocking question; safe_default will be used and question deferred to end' };
  }

  return { action: 'approve', reason: 'question passes deterministic policy' };
}

class DeferredQuestionsQueue {
  constructor({ maxDeferred = 5 } = {}) {
    this.questions = [];
    this.maxDeferred = maxDeferred;
  }

  push(q) {
    this.questions.push(q);
  }

  getAll() {
    return [...this.questions];
  }

  hasBlocking() {
    return this.questions.some(q => q.blocking);
  }

  isAtBudget() {
    return this.questions.length >= this.maxDeferred;
  }

  toReport() {
    if (!this.questions.length) return '';
    const lines = ['\n--- Deferred Questions ---'];
    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      lines.push(`${i + 1}. ${q.question}`);
      lines.push(`   Reason: ${q.reason}`);
      lines.push(`   Risk: ${q.risk_type} | Blocking: ${q.blocking}`);
      lines.push(`   Safe default: ${q.safe_default}`);
      if (q.files.length) lines.push(`   Files: ${q.files.join(', ')}`);
    }
    lines.push('--- End Deferred Questions ---\n');
    return lines.join('\n');
  }
}

function stripThinkBlocks(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function reviewQuestion(root, config, originalPrompt, candidate, options = {}) {
  const reviewPrompt = `You are reviewing a question that an AI coding agent wants to ask the user.
Original task prompt: ${originalPrompt}
Candidate question: ${candidate.question}
Reason given by agent: ${candidate.reason}
Risk type: ${candidate.risk_type}
Files affected: ${candidate.files.join(', ') || 'none'}
Safe default if rejected: ${candidate.safe_default}

Should the agent ask this question, or should it proceed with the safe default?
Reply with JSON only: {"approved": boolean, "reason": string}`;

  // Try mmx-cli subagent first
  try {
    const { execSync } = require('node:child_process');
    const os = require('node:os');
    const fs = require('node:fs');
    const path = require('node:path');
    const tmpFile = path.join(os.tmpdir(), `sicli-review-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify([
      { role: 'system', content: 'You are a strict gatekeeper. Only return JSON.' },
      { role: 'user', content: reviewPrompt }
    ]));
    const stdout = execSync(
      `npx mmx text chat --messages-file "${tmpFile.replace(/"/g, '\\"')}" --output json --quiet --non-interactive`,
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    try { fs.unlinkSync(tmpFile); } catch {}
    const parsed = JSON.parse(stdout);
    const text = parsed.content || parsed.text || parsed.message?.content || '';
    const cleaned = stripThinkBlocks(text).replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const result = JSON.parse(cleaned);
    return { approved: Boolean(result.approved), reason: String(result.reason || 'mmx review') };
  } catch {
    // fall through to chatCompletion
  }

  // Fallback to chatCompletion
  try {
    const { chatCompletion } = require('./provider');
    const review = await chatCompletion(root, config, [
      { role: 'system', content: 'You are a strict gatekeeper. Only return JSON.' },
      { role: 'user', content: reviewPrompt }
    ], [], options.signal);
    const text = stripThinkBlocks(review.message?.content || '').replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const result = JSON.parse(text);
    return { approved: Boolean(result.approved), reason: String(result.reason || 'chatCompletion review') };
  } catch (error) {
    return { approved: false, reason: `review failed: ${error.message}` };
  }
}

module.exports = {
  RISK_TYPES,
  validateAskUserArgs,
  deterministicPolicy,
  DeferredQuestionsQueue,
  reviewQuestion
};
