'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const path = require('node:path');
const os = require('node:os');

const { readFileTool, writeFileTool, editFileTool, searchTool, runCommandTool } = require('../src/tools');

const TEST_ROOT = path.join(os.tmpdir(), 'escape-cancellation-test-' + Date.now());
const fs = require('node:fs/promises');

async function setup() {
  await fs.mkdir(TEST_ROOT, { recursive: true });
}

async function teardown() {
  try {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
  } catch { }
}

describe('escape-cancellation', () => {
  beforeEach(async () => {
    await setup();
  });

  afterEach(async () => {
    await teardown();
  });

  test('readFileTool accepts signal and throws AbortError when aborted', async () => {
    const testFile = path.join(TEST_ROOT, 'test.txt');
    await fs.writeFile(testFile, 'hello world');
    const controller = new AbortController();
    const promise = readFileTool(TEST_ROOT, 'test.txt', { signal: controller.signal });
    controller.abort();
    try {
      await promise;
      throw new Error('Should have thrown AbortError');
    } catch (error) {
      if (error.message !== 'AbortError') throw error;
    }
  });

  test('writeFileTool accepts signal and throws AbortError when aborted', async () => {
    const controller = new AbortController();
    const promise = writeFileTool(TEST_ROOT, 'test.txt', 'content', { signal: controller.signal });
    controller.abort();
    try {
      await promise;
      throw new Error('Should have thrown AbortError');
    } catch (error) {
      if (error.message !== 'AbortError') throw error;
    }
  });

  test('editFileTool accepts signal and throws AbortError when aborted', async () => {
    const testFile = path.join(TEST_ROOT, 'test.txt');
    await fs.writeFile(testFile, 'hello world');
    const controller = new AbortController();
    const promise = editFileTool(TEST_ROOT, 'test.txt', 'hello', 'goodbye', { signal: controller.signal });
    controller.abort();
    try {
      await promise;
      throw new Error('Should have thrown AbortError');
    } catch (error) {
      if (error.message !== 'AbortError') throw error;
    }
  });

  test('searchTool accepts signal and handles abort gracefully', async () => {
    for (let i = 0; i < 30; i++) {
      await fs.writeFile(path.join(TEST_ROOT, `file${i}.txt`), 'needle in haystack\n'.repeat(20));
    }
    const controller = new AbortController();
    const promise = searchTool(TEST_ROOT, 'needle', '.', { signal: controller.signal });
    controller.abort();
    const result = await promise;
    if (!result.truncated) throw new Error('searchTool should return truncated when aborted');
  });

  test('runCommandTool signal abort kills the child process', async () => {
    if (process.platform === 'win32') {
      const controller = new AbortController();
      const promise = runCommandTool(TEST_ROOT, process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { signal: controller.signal });
      controller.abort();
      const result = await promise;
      if (!(result.signal === 'SIGTERM' || result.error === 'Command aborted')) {
        throw new Error(`Expected SIGTERM abort, got signal=${result.signal} error=${result.error}`);
      }
    } else {
      const controller = new AbortController();
      const promise = runCommandTool(TEST_ROOT, 'sleep', ['60'], { signal: controller.signal });
      controller.abort();
      const result = await promise;
      if (!(result.signal === 'SIGTERM' || result.error === 'Command aborted')) {
        throw new Error(`Expected SIGTERM abort, got signal=${result.signal} error=${result.error}`);
      }
    }
  });

  test('signal is properly passed through executeTool for all tool types', async () => {
    const testFile = path.join(TEST_ROOT, 'signal-test.txt');
    await fs.writeFile(testFile, 'test content');

    const readResult = await readFileTool(TEST_ROOT, 'signal-test.txt', { signal: new AbortController().signal });
    if (!readResult.content.includes('test content')) {
      throw new Error('readFileTool did not receive signal');
    }

    const writeController = new AbortController();
    await writeFileTool(TEST_ROOT, 'signal-write.txt', 'content', { signal: writeController.signal });
    writeController.abort();
    try {
      await writeFileTool(TEST_ROOT, 'signal-write2.txt', 'content', { signal: writeController.signal });
      throw new Error('Should have thrown');
    } catch (e) {
      if (e.message !== 'AbortError') throw e;
    }

    const editController = new AbortController();
    await editFileTool(TEST_ROOT, 'signal-test.txt', 'test', 'changed', { signal: editController.signal });
    editController.abort();
    try {
      await editFileTool(TEST_ROOT, 'signal-test.txt', 'changed', 'test', { signal: editController.signal });
      throw new Error('Should have thrown');
    } catch (e) {
      if (e.message !== 'AbortError') throw e;
    }

    const searchController = new AbortController();
    const searchResult = await searchTool(TEST_ROOT, 'test', '.', { signal: searchController.signal });
    searchController.abort();
    try {
      await searchTool(TEST_ROOT, 'xyz123', '.', { signal: searchController.signal });
      throw new Error('Should have thrown or returned truncated');
    } catch (e) {
      if (e.message !== 'AbortError') throw e;
    }
  });
});