'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function workerFingerprint(root = path.resolve(__dirname, '../..')) {
  const files = ['worker.js'];
  for (const directory of ['src/worker', 'src/shared']) {
    for (const file of fs.readdirSync(path.join(root, directory)).filter(file => file.endsWith('.mjs')).sort())
      files.push(`${directory}/${file}`);
  }
  const digest = createHash('sha256');
  for (const file of files) digest.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  return digest.digest('hex');
}

function verifyLoadEvidence(report, fingerprint = workerFingerprint()) {
  assert.equal(report.formatVersion, 1);
  assert.equal(report.mode, 'local-in-process-synthetic-worker-session-load');
  assert.equal(report.workerSourceSHA256, fingerprint, 'load evidence must match the current Worker source');
  assert.ok(Array.isArray(report.limitations) && report.limitations.length >= 5, 'synthetic limitations must be recorded');
  assert.ok(Array.isArray(report.levels) && report.levels.length, 'completed load levels required');
  const completed = new Set();
  for (const level of report.levels) {
    assert.ok(!completed.has(level.requestedPlayers), 'duplicate levels cannot count as additional load');
    completed.add(level.requestedPlayers);
    assert.equal(level.passed, true);
    assert.equal(level.admittedPlayers, level.requestedPlayers);
    assert.equal(level.activePlayers, level.requestedPlayers);
    assert.equal(level.admissionSuccessPercent, 100);
    for (const key of ['errors', 'visibilityViolations', 'consistencyViolations']) assert.equal(level[key]?.count, 0, key);
    for (const key of ['closedSessions', 'timeouts', 'externalNetworkRequests']) assert.equal(level[key], 0, key);
    assert.ok(level.movement.rounds >= 3);
    assert.equal(level.movement.updates, level.requestedPlayers * level.movement.rounds);
    assert.equal(level.movement.selfAcks, level.movement.updates);
    assert.equal(level.movement.latency.samples, level.movement.updates);
    assert.equal(level.admission.latency.samples, level.requestedPlayers);
    for (const measurement of [level.admission.wallMs, level.movement.wallMs,
      level.movement.updatesPerWallSecond, level.movement.latency.p95Ms,
      level.resources.sampledPeakRSSBytes]) assert.ok(Number.isFinite(measurement) && measurement > 0);
    assert.ok(level.occupiedZones <= 100 && level.maximumPlayersPerZone <= 120);
    assert.ok(level.fanout.remoteMoveDeliveriesPerUpdate < level.requestedPlayers,
      'proximity fan-out cannot broadcast every movement to all players');
  }
  assert.ok(completed.has(100) && completed.has(1000), '100 and 1,000 completed local simulation levels required');
  assert.equal(report.highestCompletedPlayers, Math.max(...completed));
  if (!report.complete) {
    // A controlled upper-level runtime limit may stop exploration. Preserve the
    // actual partial counts and reason; functional/security failures still fail.
    assert.ok(/Local runtime budget \d+s exceeded/.test(report.error || ''), 'only a reported runtime limit may interrupt upper exploration');
    assert.ok(report.interruptedLevel?.requestedPlayers > report.highestCompletedPlayers);
    for (const key of ['errors', 'visibilityViolations', 'consistencyViolations'])
      assert.equal(report.interruptedLevel[key]?.count, 0);
  }
  return report.highestCompletedPlayers;
}

if (require.main === module) {
  const file = process.argv[2] || (fs.existsSync('docs/rebuild/P8-load-results.json')
    ? 'docs/rebuild/P8-load-results.json' : 'work/load/p8-local.json');
  const highest = verifyLoadEvidence(JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log(`PASS P8 local load evidence: highest completed ${highest} synthetic sessions; source fingerprint matches; no production capacity claim`);
}
module.exports = { workerFingerprint, verifyLoadEvidence };
