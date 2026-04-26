'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { recordTaskTrace, runBackgroundReview, traceFailureMessages, traceLearningMessages } = require('../src/self-improve');

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sicli-bg-'));
}

test('traceFailureMessages detects max turns and shell file creation misuse', () => {
  const messages = traceFailureMessages({
    prompt: 'make file',
    stopped_after_max_turns: true,
    tools: [
      { name: 'run_command', args: { command: 'cmd', args: ['/c', 'echo hi > hello.md'] }, ok: true }
    ]
  });
  assert.equal(messages.length, 2);
  assert.match(messages.join('\n'), /max tool turns/);
  assert.match(messages.join('\n'), /shell redirection/);
});

test('traceLearningMessages detects thesis project context', () => {
  const messages = traceLearningMessages({
    prompt: 'jadi skripsi saya itu tentang quantum computing dengan simulator qiskit, projectq, dan cirq',
    tools: []
  });
  assert.equal(messages.some((message) => message.startsWith('User project context:')), true);
});

test('runBackgroundReview converts task traces into patch audits', async () => {
  const root = await tempRoot();
  await recordTaskTrace(root, {
    prompt: 'make file',
    tools: [{ name: 'run_command', args: { command: 'cmd', args: ['/c', 'echo hi > hello.md'] }, ok: true }],
    final_text: 'done'
  });
  const result = await runBackgroundReview(root);
  assert.equal(result.reviewed, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.status.counts.traces, 1);
  assert.equal(result.status.counts.patches, 1);
});
