'use strict';

// Each source-preservation proof belongs to the phase whose allowed changes it
// enumerates. Rerun the complete unchanged proof on that committed Git tree.
// Active runtime/security tests still use the working tree, including every P0
// and P2 runtime suite. P8 additionally reruns the unchanged P4 Lucky Box
// product tests on P4 while strengthening their active collection-time gates.
// This is a Git checkpoint, never an alternate implementation or recovery file.
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const CHECKPOINTS = [
  { phase: 'P1', revision: '10dfaf0aff07d2896c50af06d88502166b16fe9e', tests: ['p1-structure.test.cjs'] },
  { phase: 'P2', revision: 'e7ce2674f66f8d7c7f22efb669bd506e5359bceb', tests: ['p2-source-preservation.test.cjs'] },
  { phase: 'P3', revision: '592c0707a746f7a55002ce5fcc7110f00cdccf66', tests: ['p3-source-preservation.test.cjs'] },
  { phase: 'P4', revision: '149ecd9f4c617dd432e3536443be7b3081827c9b', tests: ['p4-scope.test.cjs'], behaviorTests: ['p4-economy.test.cjs', 'p4-client.test.cjs'] },
  { phase: 'P5', revision: '0200876db8a6d26c6ce372264c37bfbdca29262c', tests: ['p5-scope.test.cjs'] },
  { phase: 'P6', revision: '33ace23c05875734eda909973b446a376bf307ae', tests: ['p6-scope.test.cjs'] },
  { phase: 'P7', revision: '5d5c7a499d872f1ca7ed9762860ceb4d887f0701', tests: ['p7-scope.test.cjs'] }
];
const HISTORICAL_TESTS = CHECKPOINTS.flatMap(checkpoint => checkpoint.tests);

function successful(result, operation) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = result.stderr?.toString() || '';
    throw Error(`${operation} failed (exit ${result.status ?? 'unknown'})${details ? `: ${details}` : ''}`);
  }
}

function runCheckpoint({ phase, revision, tests, behaviorTests = [] }) {
  const archive = spawnSync('git', ['archive', '--format=tar', revision], {
    cwd: ROOT, maxBuffer: 64 * 1024 * 1024
  });
  successful(archive, `Read pinned ${phase} Git tree`);
  const parent = path.join(ROOT, 'work/checkpoints', phase.toLowerCase());
  mkdirSync(parent, { recursive: true });
  // Every run gets a fresh Git-derived tree; cached or stray source files can
  // never change the checkpoint under test. Only this generated directory is
  // removed, and only after all child processes have finished.
  const checkpoint = mkdtempSync(path.join(parent, 'run-'));
  try {
    const extraction = spawnSync('tar', ['-xf', '-', '-C', checkpoint], {
      input: archive.stdout, maxBuffer: 1024 * 1024
    });
    successful(extraction, `Extract pinned ${phase} Git tree`);
    const args = ['--test', ...[...tests, ...behaviorTests].map(file => `tests/rebuild/${file}`)];
    process.stdout.write(`\nRUN frozen ${phase} ${revision}: node ${args.join(' ')}\n`);
    const result = spawnSync(process.execPath, args, {
      cwd: checkpoint, stdio: 'inherit', env: {
        ...process.env,
        // The archived tree is itself the test worktree root. Otherwise Git
        // discovers the enclosing live checkout and interprets `ls-tree`
        // pathspecs relative to work/checkpoints/<phase>/run-*.
        GIT_DIR: path.join(ROOT, '.git'), GIT_WORK_TREE: checkpoint
      }
    });
    successful(result, `Complete unchanged historical ${phase} assertions`);
  } finally {
    rmSync(checkpoint, { recursive: true, force: true });
  }
}

function runHistory() {
  for (const checkpoint of CHECKPOINTS) runCheckpoint(checkpoint);
}

if (require.main === module) {
  try { runHistory(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}

module.exports = { runHistory, HISTORICAL_TESTS, CHECKPOINTS };
