'use strict';
// Local verification only. No staging, commit, remote write or deployment.
const { spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const phase = process.argv[2];
let loadReport;
if (process.argv.length === 5 && phase === 'P8' && process.argv[3] === '--load-report') {
  loadReport = path.resolve(process.argv[4]);
  const relative = path.relative(path.resolve('work'), loadReport);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw Error('Fresh P8 load evidence must stay in ignored work/');
} else if (process.argv.length !== 3) {
  throw Error('Usage: node scripts/rebuild/gate-phase.cjs P2..P9 [P8 only: --load-report work/load/report.json]');
}
if (!/^P[2-9]$/.test(phase || '')) throw Error('Unknown verification phase');
const directory = `work/gates/${phase}`;
mkdirSync(directory, { recursive: true });
const checks = [
  ['regression', 'npm', ['test']],
  ['static', 'npm', ['run', 'check:static']],
  ['generated-client', 'npm', ['run', 'check:client']],
  ['syntax', 'npm', ['run', 'check:syntax']],
  ['diff', process.execPath, ['scripts/rebuild/check-diff.cjs']],
  ['staged-diff', 'git', ['diff', '--cached', '--check']],
  ['wrangler-dry-run', 'npm', ['run', 'bundle:dry-run']],
  ['browser', 'python', ['tests/rebuild/p1-browser.py']],
  ['secret-config', process.execPath, ['scripts/rebuild/check-secrets.cjs']]
];
// A historical report must never be relabeled as a measurement of newer code.
// An explicit fresh report still goes through every original assertion,
// including exact equality to the current Worker/shared source fingerprint.
if (phase === 'P8') checks.push(['load-evidence', process.execPath,
  ['scripts/rebuild/load-evidence.cjs', ...(loadReport ? [loadReport] : [])]]);
if (phase === 'P9') checks.push(
  ['p8-evidence', process.execPath, ['scripts/rebuild/check-p8-evidence.cjs']],
  ['staging-isolation', process.execPath, ['scripts/rebuild/check-staging.cjs', '--allow-unconfigured']],
  ['staging-prepare', process.execPath, ['scripts/rebuild/prepare-staging.cjs', '--unconfigured']],
  ['staging-assets', process.execPath, ['scripts/rebuild/check-staging.cjs', '--config', 'work/staging/prepared/wrangler.jsonc', '--allow-unconfigured', '--require-assets']],
  ['staging-dry-run', 'npm', ['run', 'staging:dry-run']],
  ['staging-browser', 'python', ['tests/rebuild/p9-browser.py']]
);
const outputs = {};
for (const [name, command, args] of checks) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  writeFileSync(`${directory}/${name}.log`, output);
  if (result.error || result.status !== 0 || result.signal) {
    console.error(output.slice(-16_000));
    console.error(`FAIL ${phase} ${name}; full log: ${directory}/${name}.log`);
    process.exit(1);
  }
  if (/ℹ (?:fail|skipped|cancelled|todo) [1-9]\d*/.test(output)) {
    throw Error(`${name} has failed, skipped or unfinished tests`);
  }
  outputs[name] = output;
  console.log(`PASS ${phase} ${name}`);
}
const nodePass = [...outputs.regression.matchAll(/ℹ pass (\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
const legacyPass = [...outputs.regression.matchAll(/^PASS unchanged local legacy test:/gm)].length;
const browserPass = Number(outputs.browser.match(/browser cases: (\d+) passed \/ 0 failed \/ 0 skipped/)?.[1]);
if (!nodePass || legacyPass !== 2 || browserPass !== 8) throw Error('Incomplete regression/browser evidence');
const stagingBrowserPass = phase === 'P9' ? Number(outputs['staging-browser'].match(/P9 browser cases: (\d+) passed \/ 0 failed \/ 0 skipped/)?.[1]) : 0;
if (phase === 'P9' && stagingBrowserPass !== 11) throw Error('Incomplete staging browser evidence');
const summary = {
  phase, passed: nodePass + legacyPass + browserPass + stagingBrowserPass, failed: 0, skipped: 0,
  node: nodePass, legacy: legacyPass, browser: browserPass,
  staticAssertions: [...outputs.regression.matchAll(/^OK\s+/gm)].length,
  syntaxUnits: Number(outputs.syntax.match(/syntax: (\d+)/)?.[1]),
  checks: checks.map(([name]) => name)
};
if (phase === 'P9') summary.stagingBrowser = stagingBrowserPass;
if (loadReport) summary.loadReport = path.relative(process.cwd(), loadReport);
writeFileSync(`${directory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
