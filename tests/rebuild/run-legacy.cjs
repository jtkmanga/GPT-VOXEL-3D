#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPOSITORY = path.resolve(__dirname, '../..');
const LEGACY_TESTS = Object.freeze([
  {
    file: 'test_phase2b1_handoff.js',
    pass: 'PASS: secure one-time zone handoff preserved player id and position.'
  },
  {
    file: 'test_phase2b2_border_visibility.js',
    pass: 'PASS: adjacent zones exchanged filtered ghost snapshots and removed a departed player.'
  }
]);

async function main() {
  if (process.argv[2] === '--child') {
    const name = process.argv[3];
    if (!LEGACY_TESTS.some(test => test.file === name) || process.argv.length !== 4) {
      throw new Error('Only the unchanged checked-in legacy smoke tests may be loaded');
    }
    await require('./legacy-preload.cjs').install();
    require(path.join(REPOSITORY, name));
    return;
  }
  if (process.argv.length !== 2) throw new Error('Usage: node tests/rebuild/run-legacy.cjs');

  // Do not pass any real project/payment/Firebase credentials to test children.
  const environment = {};
  for (const name of ['PATH', 'NODE_PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.TZ = 'UTC';
  for (const test of LEGACY_TESTS) {
    const name = test.file;
    const result = spawnSync(process.execPath, [__filename, '--child', name], {
      cwd: REPOSITORY,
      env: environment,
      encoding: 'utf8',
      timeout: 45000,
      maxBuffer: 1024 * 1024
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0 || result.signal) {
      throw new Error(`${name} failed (exit=${result.status}, signal=${result.signal || 'none'})`);
    }
    if (!result.stdout.split(/\r?\n/).includes(test.pass)) {
      throw new Error(`${name} exited without reaching its original PASS assertion marker`);
    }
    console.log(`PASS unchanged local legacy test: ${name}`);
  }
}

main().catch(error => {
  console.error('FAIL offline legacy runner:', error.stack || error);
  process.exitCode = 1;
});
