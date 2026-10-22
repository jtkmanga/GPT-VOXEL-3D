'use strict';
// Local verification only: no deployment, provider traffic, or Git mutation.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const STEPS = Object.freeze([
  ['tests', 'scripts/rebuild/run-tests.cjs'],
  ['client', 'scripts/rebuild/build-client.cjs', '--check'],
  ['syntax', 'scripts/rebuild/check-syntax.cjs'],
  ['static', 'scripts/rebuild/check-static.cjs'],
  ['staging', 'scripts/rebuild/check-staging.cjs', '--allow-unconfigured'],
  ['secrets', 'scripts/rebuild/check-secrets.cjs']
]);

function runSteps(run) {
  const results = [];
  for (const [name, ...args] of STEPS) {
    const result = run(args, name);
    const passed = !result.error && !result.signal && result.status === 0;
    results.push({ name, passed, exitCode: result.status ?? null,
      signal: result.signal ?? null, errorCode: result.error?.code ?? null });
    if (!passed) {
      const file = path.join(directory, `${name}.log`);
      let tail = '';
      try {
        tail = fs.readFileSync(file, 'utf8').slice(-12000)
          .replace(/AIza[A-Za-z0-9_-]{30,}/g, '[redacted-firebase-key]')
          .replace(/(?:ghp_|github_pat_|sk_live_|rk_live_)[A-Za-z0-9_]{16,}/g, '[redacted-token]')
          .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\\s\\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted-private-key]');
      } catch {}
      if (tail) process.stderr.write(`\nFAILED STEP LOG TAIL (${name}, redacted):\n${tail}\n`);
      break;
    }
  }
  return { passed: results.length === STEPS.length && results.every(r => r.passed), results };
}

function main() {
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const branch = git(['branch', '--show-current']);
  if (branch !== 'development/voxel-continuous') throw Error('Use the dedicated development branch');
  const sourceCommit = git(['rev-parse', 'HEAD']);
  const dirty = Boolean(git(['status', '--porcelain']));
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'voxel-development-'));
  const startedAt = new Date().toISOString();
  const result = runSteps((args, name) => {
    const fd = fs.openSync(path.join(directory, `${name}.log`), 'wx', 0o600);
    try {
      return spawnSync(process.execPath, args, { cwd: ROOT,
        stdio: ['ignore', fd, fd], timeout: 15 * 60 * 1000 });
    } finally { fs.closeSync(fd); }
  });
  const report = { schemaVersion: 1, sourceCommit, branch, dirty, startedAt,
    completedAt: new Date().toISOString(), scope: 'local-code-only',
    browserVerified: false, liveStagingVerified: false, productionReady: false, ...result };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportDirectory: directory }, null, 2));
  if (!result.passed) process.exitCode = 1;
}

if (require.main === module) main();
module.exports = { runSteps, STEPS };
