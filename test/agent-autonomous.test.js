'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { validateAskUserArgs, deterministicPolicy, DeferredQuestionsQueue, reviewQuestion } = require('../src/ask_gate');

describe('agent autonomous mode', () => {
  it('deterministic policy rejects obvious never-ask patterns', () => {
    const candidate = validateAskUserArgs({
      question: 'Should I continue?',
      reason: 'test',
      risk_type: 'clarification',
      safe_default: 'skip',
      blocking: true
    });
    const decision = deterministicPolicy(candidate);
    assert.strictEqual(decision.action, 'reject');
  });

  it('deterministic policy defers non-blocking questions', () => {
    const candidate = validateAskUserArgs({
      question: 'Should I add a helper function?',
      reason: 'test',
      risk_type: 'clarification',
      safe_default: 'skip',
      blocking: false
    });
    const decision = deterministicPolicy(candidate);
    assert.strictEqual(decision.action, 'defer');
  });

  it('deferred queue collects questions and produces report', () => {
    const q = new DeferredQuestionsQueue();
    q.push({ turn: 1, question: 'Q1', reason: 'R1', risk_type: 'clarification', files: [], safe_default: 'skip', blocking: false, tool_call_id: 'tc1' });
    q.push({ turn: 2, question: 'Q2', reason: 'R2', risk_type: 'file_delete', files: ['a.js'], safe_default: 'keep', blocking: true, tool_call_id: 'tc2' });
    assert.strictEqual(q.getAll().length, 2);
    assert.strictEqual(q.hasBlocking(), true);
    const report = q.toReport();
    assert.ok(report.includes('Q1'));
    assert.ok(report.includes('Q2'));
    assert.ok(report.includes('file_delete'));
  });

  it('reviewQuestion is exported as a function', () => {
    assert.strictEqual(typeof reviewQuestion, 'function');
  });

  it('DeferredQuestionsQueue defaults to budget 5', () => {
    const q = new DeferredQuestionsQueue();
    assert.strictEqual(q.maxDeferred, 5);
    assert.strictEqual(q.isAtBudget(), false);
  });
});
