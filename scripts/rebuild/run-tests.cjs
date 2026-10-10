'use strict';
const { spawnSync } = require('node:child_process');
const { readdirSync, mkdirSync, writeFileSync } = require('node:fs');
const { workerSourceView } = require('./source-view.cjs');
// Preserve every legacy assertion against the active module graph. Runtime tests
// independently execute the actual bundle rather than this static source view.
mkdirSync('work', { recursive: true });
const workerView = 'work/active-worker-source.js';
writeFileSync(workerView, workerSourceView());
const commands = [
  ['test_phase2c1_client_static.js', 'index.html'],
  ['test_phase2c1_1_static.js', 'index.html', workerView],
  ['test_phase2c2_multiplayer_static.js', 'index.html', workerView],
  ['--test', ...readdirSync('tests/rebuild').filter(f => f.endsWith('.test.cjs')).sort().map(f => `tests/rebuild/${f}`)],
  ['tests/rebuild/run-legacy.cjs']
];
for (const args of commands) {
  process.stdout.write(`\nRUN node ${args.join(' ')}\n`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
