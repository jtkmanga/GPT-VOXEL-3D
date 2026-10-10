'use strict';
const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
// Existing assertions run against active source, never archived snapshots.
const commands = [
  ['test_phase2c1_client_static.js', 'index.html'],
  ['test_phase2c1_1_static.js', 'index.html', 'worker.js'],
  ['test_phase2c2_multiplayer_static.js', 'index.html', 'worker.js'],
  ['--test', ...readdirSync('tests/rebuild').filter(f => f.endsWith('.test.cjs')).sort().map(f => `tests/rebuild/${f}`)],
  ['tests/rebuild/run-legacy.cjs']
];
for (const args of commands) {
  process.stdout.write(`\nRUN node ${args.join(' ')}\n`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
