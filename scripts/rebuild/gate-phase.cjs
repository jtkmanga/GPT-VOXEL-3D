'use strict';
// Local verification only. No staging, commit, remote write or deployment.
const { spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const phase = process.argv[2];
if (!/^P[2-8]$/.test(phase || '') || process.argv.length !== 3) throw Error('Usage: node scripts/rebuild/gate-phase.cjs P2..P8');
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
if (phase === 'P8') checks.push(['load-evidence', process.execPath, ['scripts/rebuild/load-evidence.cjs']]);
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
const summary = {
  phase, passed: nodePass + legacyPass + browserPass, failed: 0, skipped: 0,
  node: nodePass, legacy: legacyPass, browser: browserPass,
  staticAssertions: [...outputs.regression.matchAll(/^OK\s+/gm)].length,
  syntaxUnits: Number(outputs.syntax.match(/syntax: (\d+)/)?.[1]),
  checks: checks.map(([name]) => name)
};
writeFileSync(`${directory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
