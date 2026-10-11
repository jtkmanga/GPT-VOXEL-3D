'use strict';
const { spawnSync } = require('node:child_process');
const { readdirSync, mkdirSync, writeFileSync } = require('node:fs');
const { workerSourceView } = require('./source-view.cjs');
const { runHistory, HISTORICAL_TESTS } = require('./run-history.cjs');
// Run all frozen P1 extraction/equivalence assertions before active regression.
// The original test file is unchanged and executes the actual committed modules.
runHistory();
// Preserve every legacy assertion against the active module graph. Runtime tests
// independently execute the actual bundle rather than this static source view.
mkdirSync('work', { recursive: true });
const workerView = 'work/active-worker-source.js';
writeFileSync(workerView, workerSourceView());
const commands = [
  ['test_phase2c1_client_static.js', 'index.html'],
  ['test_phase2c1_1_static.js', 'index.html', workerView],
  ['test_phase2c2_multiplayer_static.js', 'index.html', workerView],
  ['--test', ...readdirSync('tests/rebuild')
    .filter(f => f.endsWith('.test.cjs') && !HISTORICAL_TESTS.includes(f))
    .sort().map(f => `tests/rebuild/${f}`)],
  ['tests/rebuild/run-legacy.cjs']
];
for (const args of commands) {
  process.stdout.write(`\nRUN node ${args.join(' ')}\n`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
