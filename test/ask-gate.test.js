'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { validateAskUserArgs, deterministicPolicy, DeferredQuestionsQueue } = require('../src/ask_gate');

describe('validateAskUserArgs', () => {
  it('accepts valid args', () => {
    const args = { question: 'Q', reason: 'R', risk_type: 'clarification', safe_default: 'skip', files: ['a.js'], blocking: false };
    const result = validateAskUserArgs(args);
    assert.strictEqual(result.question, 'Q');
    assert.strictEqual(result.blocking, false);
    assert.deepStrictEqual(result.files, ['a.js']);
  });

  it('rejects missing question', () => {
    assert.throws(() => validateAskUserArgs({ reason: 'R', risk_type: 'other', safe_default: 'skip' }), /question is required/);
  });

  it('rejects missing reason', () => {
    assert.throws(() => validateAskUserArgs({ question: 'Q', risk_type: 'other', safe_default: 'skip' }), /reason is required/);
  });

  it('rejects invalid risk_type', () => {
    assert.throws(() => validateAskUserArgs({ question: 'Q', reason: 'R', risk_type: 'bad', safe_default: 'skip' }), /risk_type must be one of/);
  });

  it('rejects missing safe_default', () => {
    assert.throws(() => validateAskUserArgs({ question: 'Q', reason: 'R', risk_type: 'other' }), /safe_default is required/);
  });
});

describe('deterministicPolicy', () => {
  it('rejects "should I continue" pattern', () => {
    const result = deterministicPolicy({ question: 'Should I continue?', reason: 'R', risk_type: 'clarification', safe_default: 'skip', blocking: true, files: [] });
    assert.strictEqual(result.action, 'reject');
  });

  it('rejects high-risk blocking file_delete', () => {
    const result = deterministicPolicy({ question: 'Delete old migrations?', reason: 'R', risk_type: 'file_delete', safe_default: 'keep', blocking: true, files: [] });
    assert.strictEqual(result.action, 'reject');
  });

  it('defers high-risk non-blocking command_exec', () => {
    const result = deterministicPolicy({ question: 'Run npm audit fix?', reason: 'R', risk_type: 'command_exec', safe_default: 'skip', blocking: false, files: [] });
    assert.strictEqual(result.action, 'defer');
  });

  it('defers non-blocking clarification', () => {
    const result = deterministicPolicy({ question: 'Should I add a helper?', reason: 'R', risk_type: 'clarification', safe_default: 'skip', blocking: false, files: [] });
    assert.strictEqual(result.action, 'defer');
  });

  it('approves blocking clarification that is not never_ask', () => {
    const result = deterministicPolicy({ question: 'Which payment provider should I integrate?', reason: 'R', risk_type: 'clarification', safe_default: 'use mock', blocking: true, files: [] });
    assert.strictEqual(result.action, 'approve');
  });

  it('rejects "what is next" pattern', () => {
    const result = deterministicPolicy({ question: "What's next?", reason: 'R', risk_type: 'clarification', safe_default: 'skip', blocking: true, files: [] });
    assert.strictEqual(result.action, 'reject');
  });

  it('returns review for permission + blocking', () => {
    const result = deterministicPolicy({ question: 'Can I share this data?', reason: 'R', risk_type: 'permission', safe_default: 'deny', blocking: true, files: [] });
    assert.strictEqual(result.action, 'review');
  });

  it('never_ask takes precedence over review', () => {
    const result = deterministicPolicy({ question: 'Should I continue?', reason: 'R', risk_type: 'permission', safe_default: 'skip', blocking: true, files: [] });
    assert.strictEqual(result.action, 'reject');
  });
});

describe('DeferredQuestionsQueue', () => {
  it('collects and reports questions', () => {
    const q = new DeferredQuestionsQueue();
    q.push({ turn: 1, question: 'Q1', reason: 'R1', risk_type: 'clarification', files: [], safe_default: 'skip', blocking: false, tool_call_id: 'tc1' });
    assert.strictEqual(q.getAll().length, 1);
    assert.strictEqual(q.hasBlocking(), false);
    const report = q.toReport();
    assert.ok(report.includes('Deferred Questions'));
    assert.ok(report.includes('Q1'));
  });

  it('detects blocking questions', () => {
    const q = new DeferredQuestionsQueue();
    q.push({ turn: 1, question: 'Q1', reason: 'R1', risk_type: 'clarification', files: [], safe_default: 'skip', blocking: false, tool_call_id: 'tc1' });
    q.push({ turn: 2, question: 'Q2', reason: 'R2', risk_type: 'permission', files: [], safe_default: 'deny', blocking: true, tool_call_id: 'tc2' });
    assert.strictEqual(q.hasBlocking(), true);
  });

  it('enforces max deferred budget', () => {
    const q = new DeferredQuestionsQueue({ maxDeferred: 2 });
    q.push({ turn: 1, question: 'Q1', reason: 'R1', risk_type: 'clarification', files: [], safe_default: 'skip', blocking: false, tool_call_id: 'tc1' });
    q.push({ turn: 2, question: 'Q2', reason: 'R2', risk_type: 'clarification', files: [], safe_default: 'skip', blocking: false, tool_call_id: 'tc2' });
    assert.strictEqual(q.isAtBudget(), true);
    assert.strictEqual(q.getAll().length, 2);
  });
});
