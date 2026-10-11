'use strict';

// P1 proved a behavior-preserving extraction against P0. Later security phases
// intentionally change those behaviors, so rerun that entire proof on the real
// committed P1 tree. Active runtime/security tests still use the working tree.
// This is a Git checkpoint, never an alternate implementation or recovery file.
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const P1 = '10dfaf0aff07d2896c50af06d88502166b16fe9e';
const HISTORICAL_TESTS = ['p1-structure.test.cjs'];

function successful(result, operation) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = result.stderr?.toString() || '';
    throw Error(`${operation} failed (exit ${result.status ?? 'unknown'})${details ? `: ${details}` : ''}`);
  }
}

function runHistory() {
  const archive = spawnSync('git', ['archive', '--format=tar', P1], {
    cwd: ROOT, maxBuffer: 64 * 1024 * 1024
  });
  successful(archive, 'Read pinned P1 Git tree');
  const parent = path.join(ROOT, 'work/checkpoints/p1');
  mkdirSync(parent, { recursive: true });
  // Every run gets a fresh Git-derived tree; cached or stray source files can
  // never change the checkpoint under test. Only this generated directory is
  // removed, and only after all child processes have finished.
  const checkpoint = mkdtempSync(path.join(parent, 'run-'));
  try {
    const extraction = spawnSync('tar', ['-xf', '-', '-C', checkpoint], {
      input: archive.stdout, maxBuffer: 1024 * 1024
    });
    successful(extraction, 'Extract pinned P1 Git tree');
    const args = ['--test', ...HISTORICAL_TESTS.map(file => `tests/rebuild/${file}`)];
    process.stdout.write(`\nRUN frozen P1 ${P1}: node ${args.join(' ')}\n`);
    const result = spawnSync(process.execPath, args, {
      cwd: checkpoint, stdio: 'inherit', env: process.env
    });
    successful(result, 'Complete unchanged historical P1 assertions');
  } finally {
    rmSync(checkpoint, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { runHistory(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}

module.exports = { runHistory, HISTORICAL_TESTS };
