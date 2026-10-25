#!/usr/bin/env node
'use strict';

// In-process, local-only Worker simulation. No URL, credential or network target
// can be supplied. The existing harness executes the actual bundled Worker,
// Firebase RSA verifier, SQLite stores, movement and fan-out; only WebSocket
// transport, trusted synthetic certificates, provider fixtures and clock are
// adapters. This is deliberately NOT real network/Cloudflare capacity evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { execFileSync } = require('node:child_process');
const { workerFingerprint } = require('./load-evidence.cjs');

function repositoryRoot() {
  for (const start of [process.cwd(), __dirname]) {
    for (let candidate = start; ; candidate = path.dirname(candidate)) {
      if (fs.existsSync(path.join(candidate, 'worker.js')) &&
          fs.existsSync(path.join(candidate, 'tests/rebuild/harness.cjs'))) return candidate;
      if (path.dirname(candidate) === candidate) break;
    }
  }
  throw Error('Run inside the GPT-VOXEL-3D repository');
}

const ROOT = repositoryRoot();
const { createHarness, CERTS_URL } = require(path.join(ROOT, 'tests/rebuild/harness.cjs'));
const { ZONE_GRID_SIZE, ZONE_SOFT_CAP, PLAYER_VISIBILITY_RADIUS, MOVE_TICK_MS } =
  require(path.join(ROOT, 'src/shared/config.mjs'));
const { MOVEMENT } = require(path.join(ROOT, 'src/shared/movement.mjs'));

function options(argv) {
  const result = { levels: [100], rounds: 3, batch: 50, maxRuntimeSeconds: 900,
    output: path.join(ROOT, 'work/load/p8-local.json') };
  for (const argument of argv) {
    const match = /^--(levels|rounds|batch|max-runtime-seconds|out)=(.+)$/.exec(argument);
    if (!match) throw Error('Usage: node scripts/rebuild/load-local.cjs --levels=100,1000,10000 --rounds=3 --batch=50 --max-runtime-seconds=900 --out=work/load/p8-local.json');
    if (match[1] === 'levels') result.levels = match[2].split(',').map(Number);
    else if (match[1] === 'out') result.output = path.resolve(ROOT, match[2]);
    else result[{ rounds: 'rounds', batch: 'batch', 'max-runtime-seconds': 'maxRuntimeSeconds' }[match[1]]] = Number(match[2]);
  }
  assert.ok(result.levels.length && result.levels.length <= 10, 'one to ten levels required');
  const maximum = ZONE_GRID_SIZE ** 2 * ZONE_SOFT_CAP;
  assert.ok(result.levels.every(level => Number.isSafeInteger(level) && level >= 1 && level <= maximum), `player levels must be 1..${maximum}`);
  assert.deepEqual(result.levels, [...new Set(result.levels)].sort((a, b) => a - b), 'levels must be unique and ascending');
  assert.ok(Number.isSafeInteger(result.rounds) && result.rounds >= 3 && result.rounds <= 300, 'at least three and at most 300 rounds required');
  assert.ok(Number.isSafeInteger(result.batch) && result.batch >= 1 && result.batch <= 200, 'batch must be 1..200');
  assert.ok(Number.isFinite(result.maxRuntimeSeconds) && result.maxRuntimeSeconds >= 10 && result.maxRuntimeSeconds <= 3600, 'runtime budget must be 10..3600 seconds');
  const outputRelative = path.relative(path.join(ROOT, 'work'), result.output);
  assert.ok(outputRelative && !outputRelative.startsWith('..') && !path.isAbsolute(outputRelative), 'JSON output must stay in ignored work/');
  return result;
}

const round = value => Math.round(value * 1000) / 1000;
function latency(values) {
  if (!values.length) return { samples: 0, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = p => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]);
  return { samples: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: round(sorted.at(-1)) };
}

function boundedSamples(counter, message) {
  counter.count++;
  if (counter.samples.length < 10) counter.samples.push(message);
}

function counters() {
  return { messages: 0, bytes: 0, typeCounts: {}, coordinatorCalls: 0, zoneCalls: 0,
    routePaths: {}, zoneNames: new Set(), deliveries: 0, moveDeliveries: 0,
    ghostDeliveries: 0, ghostPlayerItems: 0, selfAcks: 0,
    errors: { count: 0, samples: [] }, visibilityViolations: { count: 0, samples: [] },
    consistencyViolations: { count: 0, samples: [] }, authLatencies: [], updateLatencies: [],
    totalSigningMs: 0 };
}

function captureRoutes(h, stats) {
  // Instrument the harness's diagnostics only, never Worker routing/methods.
  // Limit retained samples so memory measures the connected simulation instead
  // of an ever-growing audit log. Counts cover every route before truncation.
  const originalPush = h.records.routes.push.bind(h.records.routes);
  h.records.routes.push = (...routes) => {
    for (const route of routes) {
      stats.routePaths[`${route.binding} ${route.path}`] = (stats.routePaths[`${route.binding} ${route.path}`] || 0) + 1;
      if (route.binding === 'ROOM') stats.coordinatorCalls++;
      if (route.binding === 'ZONE') { stats.zoneCalls++; stats.zoneNames.add(route.name); }
      if (h.records.routes.length < 128) originalPush(route);
    }
    return h.records.routes.length;
  };
}

function observe(entry, stats) {
  // A streaming transport observer replaces only the mock's inbox retention;
  // every real ws.send still serializes/delivers through the actual Worker.
  entry.connection.client.inbox.push = (...messages) => {
    for (const raw of messages) {
      stats.messages++;
      stats.bytes += Buffer.byteLength(raw);
      let message;
      try { message = JSON.parse(raw); }
      catch (_) { boundedSamples(stats.errors, `invalid JSON for ${entry.uid}`); continue; }
      stats.typeCounts[message.type] = (stats.typeCounts[message.type] || 0) + 1;
      if (['auth_error', 'server_error', 'box_error', 'handoff_error'].includes(message.type))
        boundedSamples(stats.errors, `${entry.uid}: ${message.type}: ${message.message || ''}`);
      if (message.type === 'welcome') {
        entry.welcomed = true;
        entry.playerId = message.id;
        entry.position = message.spawn;
        entry.resumeToken = message.session?.resumeToken;
        stats.authLatencies.push(performance.now() - entry.admissionStartedAt);
      }
      if (message.type === 'move' && Number.isSafeInteger(message.ack)) {
        if (message.player?.id !== entry.playerId || message.applied !== true)
          boundedSamples(stats.errors, `${entry.uid}: invalid/unapplied own movement ACK ${message.ack}`);
        const sentAt = entry.pending.get(message.ack);
        if (sentAt === undefined || entry.acks.has(message.ack))
          boundedSamples(stats.errors, `${entry.uid}: unexpected/duplicate ACK ${message.ack}`);
        else {
          stats.updateLatencies.push(performance.now() - sentAt);
          entry.acks.add(message.ack);
          entry.pending.delete(message.ack);
          stats.selfAcks++;
        }
        entry.position = message.player;
      }
      const projections = message.type === 'ghost_snapshot' ? message.players :
        ['join', 'move'].includes(message.type) && message.player?.id !== entry.playerId ? [message.player] : [];
      if (!Array.isArray(projections)) {
        boundedSamples(stats.errors, `${entry.uid}: malformed visibility projection`); continue;
      }
      if (message.type === 'ghost_snapshot') {
        stats.ghostDeliveries++;
        stats.ghostPlayerItems += projections.length;
        if (new Set(projections.map(player => player.id)).size !== projections.length)
          boundedSamples(stats.visibilityViolations, `${entry.uid}: duplicate ghost identities`);
      }
      if (message.type === 'move' && message.player?.id !== entry.playerId) stats.moveDeliveries++;
      stats.deliveries += projections.length;
      for (const player of projections) {
        if (!player || !['x', 'y', 'z', 'r'].every(axis => Number.isFinite(player[axis])) ||
            Math.abs(player.x) > MOVEMENT.bounds || Math.abs(player.z) > MOVEMENT.bounds ||
            player.y < 0 || player.y > 8) {
          boundedSamples(stats.visibilityViolations, `${entry.uid}: nonfinite/out-of-world player`); continue;
        }
        if (player.id === entry.playerId)
          boundedSamples(stats.visibilityViolations, `${entry.uid}: ghost projection contains self`);
        if (entry.position && Math.hypot(player.x - entry.position.x, player.z - entry.position.z) > PLAYER_VISIBILITY_RADIUS + 1e-6)
          boundedSamples(stats.visibilityViolations, `${entry.uid}: remote player outside ${PLAYER_VISIBILITY_RADIUS} visibility radius`);
      }
    }
    return 0;
  };
}

function verify(h, entries, stats, expectedAcks) {
  assert.equal(stats.errors.count, 0, JSON.stringify(stats.errors));
  assert.equal(stats.visibilityViolations.count, 0, JSON.stringify(stats.visibilityViolations));
  const rows = h.room().sql.exec('SELECT * FROM voxel_sessions').toArray();
  assert.equal(rows.length, entries.length, 'exactly one durable session row per admitted UID');
  const indexed = new Map(rows.map(row => [row.uid, row]));
  assert.equal(indexed.size, entries.length, 'UID ownership cannot duplicate');
  for (const entry of entries) {
    const player = entry.connection.attachment(), row = indexed.get(entry.uid);
    const valid = entry.welcomed && entry.connection.client.readyState === 1 &&
      player.uid === entry.uid && player.id === entry.playerId && !player.revoked &&
      !player.handoffResume && !player.sessionClosed && row?.session_id === player.sessionId &&
      row?.player_id === player.id && row?.owner === `zone:${entry.zone}` &&
      Number(row.lease_expires) > h.now() && Number(row.exp) > Math.floor(h.now() / 1000) &&
      entry.acks.size === expectedAcks && entry.pending.size === 0 &&
      ['x', 'y', 'z', 'r'].every(axis => row[axis] === player[axis]);
    if (!valid) boundedSamples(stats.consistencyViolations, `${entry.uid}: attachment/durable ownership or ACK mismatch`);
  }
  assert.equal(stats.consistencyViolations.count, 0, JSON.stringify(stats.consistencyViolations));
  assert.equal(h.room().coinSnapshot().length, 200, 'load cannot duplicate world resources');
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_lucky_box').toArray()[0].n, 1, 'one logical Lucky Box');
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_scores WHERE score<>0').toArray()[0].n, 0, 'movement/admission cannot mint economy rewards');
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_economy_actions').toArray()[0].n, 0, 'movement/admission cannot create economy receipts');
  assert.ok(h.records.fetches.every(request => request.url === CERTS_URL), 'only isolated synthetic certificate fixture fetches permitted');
}

function snapshotCounters(stats) {
  return Object.fromEntries(['messages', 'bytes', 'coordinatorCalls', 'zoneCalls', 'deliveries',
    'moveDeliveries', 'ghostDeliveries', 'ghostPlayerItems', 'selfAcks'].map(key => [key, stats[key]]));
}
function difference(stats, before) {
  return Object.fromEntries(Object.entries(before).map(([key, value]) => [key, stats[key] - value]));
}

async function level(players, config) {
  globalThis.gc?.();
  const startMemory = process.memoryUsage(), startCPU = process.cpuUsage();
  const started = performance.now(), stats = counters(), h = createHarness(), entries = [];
  let peakRSS = startMemory.rss, peakHeap = startMemory.heapUsed;
  const sampleMemory = () => {
    const current = process.memoryUsage();
    peakRSS = Math.max(peakRSS, current.rss); peakHeap = Math.max(peakHeap, current.heapUsed);
  };
  const checkpoint = () => {
    sampleMemory();
    if (performance.now() - started > config.maxRuntimeSeconds * 1000)
      throw Error(`Local runtime budget ${config.maxRuntimeSeconds}s exceeded at ${entries.length}/${players} admitted players`);
    assert.equal(stats.errors.count, 0, JSON.stringify(stats.errors));
    assert.equal(stats.visibilityViolations.count, 0, JSON.stringify(stats.visibilityViolations));
  };
  captureRoutes(h, stats);
  try {
    const admissionStarted = performance.now();
    for (let base = 0; base < players; base += config.batch) {
      const batch = Array.from({ length: Math.min(config.batch, players - base) }, (_, offset) => base + offset);
      await Promise.all(batch.map(async index => {
        const cell = index % ZONE_GRID_SIZE ** 2;
        const zone = `${cell % ZONE_GRID_SIZE},${Math.floor(cell / ZONE_GRID_SIZE)}`;
        const uid = `synthetic-p8-load-${players}-${String(index).padStart(5, '0')}`;
        const signingStarted = performance.now(), token = h.token(uid);
        stats.totalSigningMs += performance.now() - signingStarted;
        const entry = { uid, zone, index, welcomed: false, pending: new Map(), acks: new Set(),
          admissionStartedAt: performance.now() };
        entry.connection = await h.open(`/play?zone=${encodeURIComponent(zone)}`);
        observe(entry, stats);
        entries.push(entry);
        await entry.connection.send({ type: 'auth', token, protocol: 6, name: `Load${index}` });
        assert.ok(entry.welcomed && entry.connection.client.readyState === 1, `admission failed for ${uid}`);
      }));
      checkpoint();
      if (base === 0 || base + config.batch >= players || Math.floor(base / config.batch) % 20 === 19)
        process.stderr.write(`local simulation ${players}: admitted ${entries.length}/${players}\n`);
    }
    const admissionMs = performance.now() - admissionStarted;
    verify(h, entries, stats, 0);
    const admittedResources = snapshotCounters(stats), movementStarted = performance.now();
    const rounds = [];
    for (let seq = 0; seq < config.rounds; seq++) {
      await h.advance(MOVE_TICK_MS);
      const before = snapshotCounters(stats), roundStarted = performance.now();
      for (let base = 0; base < entries.length; base += config.batch) {
        const batch = entries.slice(base, base + config.batch);
        await Promise.all(batch.map(async entry => {
          // Small alternating, authenticated intent exercises actual physics;
          // no server attachment/state or client coordinates are manufactured.
          const x = (entry.index % 2 ? 1 : -1) * (seq % 2 ? -.1 : .1);
          entry.pending.set(seq, performance.now());
          await entry.connection.send({ type: 'move', seq, input: { x, z: 0, jump: false } });
        }));
        checkpoint();
      }
      const elapsedMs = performance.now() - roundStarted;
      verify(h, entries, stats, seq + 1);
      rounds.push({ sequence: seq, elapsedMs: round(elapsedMs), updates: players,
        updatesPerWallSecond: round(players / (elapsedMs / 1000)), ...difference(stats, before) });
      process.stderr.write(`local simulation ${players}: movement round ${seq + 1}/${config.rounds}, ${round(elapsedMs)} ms\n`);
    }
    const movementMs = performance.now() - movementStarted;
    verify(h, entries, stats, config.rounds);
    checkpoint();
    const endMemory = process.memoryUsage(), cpu = process.cpuUsage(startCPU);
    const updateCounts = difference(stats, admittedResources);
    const result = {
      requestedPlayers: players, admittedPlayers: entries.length, admissionSuccessPercent: 100,
      activePlayers: entries.filter(entry => entry.connection.client.readyState === 1).length,
      occupiedZones: new Set(entries.map(entry => entry.zone)).size,
      maximumPlayersPerZone: Math.ceil(players / ZONE_GRID_SIZE ** 2),
      authVerification: 'actual Worker RSA signature and claims checks with isolated synthetic X.509 fixture',
      admission: { wallMs: round(admissionMs), admissionsPerWallSecond: round(players / (admissionMs / 1000)),
        clientFixtureSigningWallMs: round(stats.totalSigningMs), latency: latency(stats.authLatencies), ...admittedResources },
      movement: { rounds: config.rounds, syntheticElapsedMs: config.rounds * MOVE_TICK_MS,
        offeredUpdatesPerPlayerPerSyntheticSecond: 1000 / MOVE_TICK_MS,
        wallMs: round(movementMs), updates: players * config.rounds,
        updatesPerWallSecond: round(players * config.rounds / (movementMs / 1000)),
        latency: latency(stats.updateLatencies), ...updateCounts, roundResults: rounds },
      fanout: { remoteMoveDeliveriesPerUpdate: round(updateCounts.moveDeliveries / (players * config.rounds)),
        ghostSnapshots: stats.ghostDeliveries, ghostProjectedPlayerItems: stats.ghostPlayerItems,
        allMessageTypes: stats.typeCounts, deliveredBytes: stats.bytes },
      errors: stats.errors, visibilityViolations: stats.visibilityViolations,
      consistencyViolations: stats.consistencyViolations, closedSessions: 0,
      timeouts: 0,
      stateConsistency: 'every admitted UID has one current durable owner; all attachment/save positions agree; all updates acknowledged; 200 coins, one Lucky Box, zero illicit economy mutations',
      privateRPCs: { coordinator: stats.coordinatorCalls, zone: stats.zoneCalls,
        instantiatedZoneNames: stats.zoneNames.size, countsByBindingAndPath: stats.routePaths },
      resources: { startRSSBytes: startMemory.rss, endRSSBytes: endMemory.rss,
        sampledPeakRSSBytes: peakRSS, startHeapUsedBytes: startMemory.heapUsed,
        endHeapUsedBytes: endMemory.heapUsed, sampledPeakHeapUsedBytes: peakHeap,
        processLifetimeMaximumRSSKiB: process.resourceUsage().maxRSS,
        userCPUMs: round(cpu.user / 1000), systemCPUMs: round(cpu.system / 1000),
        totalWallMs: round(performance.now() - started),
        note: 'process memory includes VM, real SQLite, synthetic transport, streaming metric arrays and test adapters; sampled peak is observed at batch boundaries' },
      externalNetworkRequests: 0,
      syntheticCertificateFixtureRequests: h.records.fetches.length,
      passed: true
    };
    return result;
  } catch (error) {
    error.loadProgress = { requestedPlayers: players, admittedPlayers: entries.filter(entry => entry.welcomed).length,
      openedMockTransports: entries.length, movementAcks: stats.selfAcks,
      errors: stats.errors, visibilityViolations: stats.visibilityViolations,
      consistencyViolations: stats.consistencyViolations,
      actualWallMs: round(performance.now() - started), ...snapshotCounters(stats) };
    throw error;
  } finally {
    // Storage is local, and no lingering timer can emit a real network request.
    await h.close();
  }
}

async function main() {
  const config = options(process.argv.slice(2));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const report = { formatVersion: 1, mode: 'local-in-process-synthetic-worker-session-load', commit,
    observedAtUTC: new Date().toISOString(),
    workerSourceSHA256: workerFingerprint(),
    workingTreeStatus: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    command: `node ${process.execArgv.join(' ')} scripts/rebuild/load-local.cjs --levels=${config.levels.join(',')} --rounds=${config.rounds} --batch=${config.batch} --max-runtime-seconds=${config.maxRuntimeSeconds} --out=${path.relative(ROOT, config.output)}`.replace(/ +/g, ' '),
    nodeVersion: process.version, platform: `${process.platform}/${process.arch}`,
    limitations: [
      'No real WebSocket/TCP connections or production endpoint is used.',
      'Synthetic clock offers 5 Hz; reported wall-clock throughput/latency is actual transport-free processing, not sustained real-time network delivery.',
      'Durable Objects are VM instances backed by local SQLite; Cloudflare scheduling, billing, isolates, hibernation limits and regional network behavior are not represented.',
      'Admission/update batches are bounded; all admitted sessions remain simultaneously active across rounds.',
      'Passing this simulation is not proof of 10,000 concurrent production players, production readiness, failover or mobile-client performance.'
    ], levels: [], highestCompletedPlayers: 0, complete: false };
  const save = () => {
    fs.mkdirSync(path.dirname(config.output), { recursive: true });
    fs.writeFileSync(config.output, `${JSON.stringify(report, null, 2)}\n`);
  };
  try {
    for (const players of config.levels) {
      assert.equal(workerFingerprint(), report.workerSourceSHA256, 'Worker source changed during load run');
      report.levels.push(await level(players, config));
      assert.equal(workerFingerprint(), report.workerSourceSHA256, 'Worker source changed during load run');
      report.highestCompletedPlayers = players;
      save();
    }
    report.complete = true;
    save();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    report.error = String(error?.stack || error);
    if (error.loadProgress) report.interruptedLevel = error.loadProgress;
    save();
    process.stderr.write(`FAIL local simulation; completed lower levels preserved at ${path.relative(ROOT, config.output)}\n${report.error}\n`);
    process.exitCode = 1;
  }
}

main().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
