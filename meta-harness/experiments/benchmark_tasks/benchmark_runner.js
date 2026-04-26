#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

async function runBenchmark(root, options = {}) {
  const tasksDir = path.join(__dirname);
  let files;
  try {
    files = await fs.readdir(tasksDir);
  } catch {
    return [{ error: 'benchmark_tasks directory not found' }];
  }
  const taskFiles = files.filter((f) => f.startsWith('task_') && f.endsWith('.json')).sort();

  if (taskFiles.length === 0) {
    return [{ error: 'no task files found' }];
  }

  const results = [];
  for (const file of taskFiles) {
    const task = JSON.parse(await fs.readFile(path.join(tasksDir, file), 'utf8'));
    results.push({
      id: task.id,
      name: task.name,
      failure_mode: task.failure_mode,
      status: 'defined'
    });
  }

  return {
    total: taskFiles.length,
    tasks: results,
    note: 'Benchmark runner validates task definitions. Execution against agent requires full CLI environment.'
  };
}

if (require.main === module) {
  const root = process.cwd();
  runBenchmark(root).then((r) => {
    console.log(JSON.stringify(r, null, 2));
  }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { runBenchmark };
