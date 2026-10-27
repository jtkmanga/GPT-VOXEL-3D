#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '../..');

function number(name, fallback, min, max, integer = false) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value)))
    throw new Error(`${name} must be ${integer ? 'an integer ' : ''}in ${min}..${max}`);
  return value;
}

function workPath(value, fallback) {
  const file = path.resolve(ROOT, value || fallback);
  const work = path.resolve(ROOT, 'work') + path.sep;
  if (!file.startsWith(work)) throw new Error('load-test files must stay under work/');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] * 1000) / 1000;
}

function zoneFor(globalIndex) {
  const slot = globalIndex % 100;
  return `${slot % 10},${Math.floor(slot / 10)}`;
}

function movementPacket(index, seq, hz, elapsedMs) {
  const periodSeconds = 1 / hz;
  const phase = (Math.floor(elapsedMs / 750) + Math.floor(index / 2)) % 2 ? 1 : -1;
  const input = index % 2 === 0
    ? { x: phase, z: 0, jump: false }
    : { x: 0, z: phase, jump: false };
  const frameCount = Math.ceil(periodSeconds / 0.05);
  const delta = periodSeconds / frameCount;
  const frames = Array.from({ length: frameCount }, () => ({ input: { ...input }, delta }));
  return { type: 'move', input, seq, frames };
}

function selfTest() {
  const seen = new Map();
  for (let i = 0; i < 10000; i++) seen.set(zoneFor(i), (seen.get(zoneFor(i)) || 0) + 1);
  if (seen.size !== 100 || [...seen.values()].some(value => value !== 100))
    throw new Error('10K zone distribution self-test failed');
  for (const hz of [2, 5]) {
    const packet = movementPacket(17, 3, hz, 1000);
    const total = packet.frames.reduce((sum, frame) => sum + frame.delta, 0);
    if (packet.frames.length < 1 || packet.frames.length > 64 || total > 0.500000001 ||
        packet.frames.some(frame => frame.delta < 0 || frame.delta > 0.1))
      throw new Error('Movement frame self-test failed');
  }
  console.log('PASS 10K zone distribution: 100 zones x 100 players');
  console.log('PASS current movement packet shape: input + frames + seq');
}

async function run() {
  const botCount = number('BOT_COUNT', 100, 1, 10000, true);
  const durationSec = number('DURATION_SEC', 60, 10, 600, true);
  const moveHz = number('MOVE_HZ', 5, 2, 5, true);
  const connectRate = number('CONNECT_RATE_PER_SEC', 100, 5, 500);
  const minWelcomeRate = number('MIN_WELCOME_RATE', 0.995, 0.9, 1);
  const minAckRate = number('MIN_ACK_RATE', 0.95, 0.5, 1);
  const maxGeneratorLagMs = number('MAX_GENERATOR_EVENT_LOOP_P95_MS', 300, 20, 5000);
  const wsBase = String(process.env.WS_URL || '').trim();
  const origin = String(process.env.ORIGIN || '').trim();
  const target = String(process.env.TARGET || 'unknown').trim();
  if (!/^wss:\/\//.test(wsBase)) throw new Error('WS_URL must be wss://');
  if (!/^https:\/\//.test(origin)) throw new Error('ORIGIN must be https://');

  const tokenFile = workPath(process.env.TOKEN_FILE, 'work/load/firebase-load-users.json');
  const outputFile = workPath(process.env.LOAD_REPORT_FILE, 'work/load/live-load-report.json');
  const manifest = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  const tokenUsers = manifest.users || [];
  if (tokenUsers.length < botCount) throw new Error('Token pool is smaller than BOT_COUNT');
  const selected = tokenUsers.slice(0, botCount);
  const uniqueUids = new Set(selected.map(user => user.uid));
  if (uniqueUids.size !== botCount || selected.some(user => typeof user.idToken !== 'string' || user.idToken.length < 100))
    throw new Error('Token pool must contain BOT_COUNT unique UID/ID-token pairs');

  const stats = {
    started: 0, opened: 0, active: 0, welcomed: 0, authErrors: 0,
    connectionErrors: 0, unexpectedResponses: 0, serverErrors: 0,
    welcomeTimeouts: 0, prematureCloses: 0, closed: 0, messages: 0,
    movesSent: 0, moveAcks: 0, remoteMoves: 0, joins: 0, leaves: 0,
    ghostSnapshots: 0, zoneChanges: 0, generatorBackpressure: 0
  };
  const typeCounts = {};
  const welcomeLatencyMs = [];
  const sockets = new Set();
  const moveTimers = new Map();
  let finishing = false;
  const testStart = Date.now();
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  function summary(tag) {
    const active = [...sockets].filter(ws => ws.readyState === WebSocket.OPEN).length;
    const p95 = percentile(welcomeLatencyMs, 0.95);
    const lag = Math.round(loopDelay.percentile(95) / 1e6);
    console.log(`[${tag}] target=${target} started=${stats.started}/${botCount} open=${stats.opened} active=${active} welcome=${stats.welcomed} moves=${stats.movesSent} acks=${stats.moveAcks} errors=${stats.authErrors + stats.connectionErrors + stats.unexpectedResponses + stats.serverErrors + stats.welcomeTimeouts + stats.prematureCloses} welcomeP95=${p95 ?? '-'}ms generatorLoopP95=${lag}ms`);
  }

  function stopMovement(ws) {
    const timer = moveTimers.get(ws);
    if (timer) clearInterval(timer);
    moveTimers.delete(ws);
  }

  function startMovement(ws, index, initialSeq) {
    let seq = initialSeq;
    const periodMs = Math.round(1000 / moveHz);
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || finishing) return;
      if (ws.bufferedAmount > 256 * 1024) {
        stats.generatorBackpressure++;
        return;
      }
      const packet = movementPacket(index, seq++, moveHz, Date.now() - testStart);
      try {
        ws.send(JSON.stringify(packet));
        stats.movesSent++;
      } catch {
        stats.connectionErrors++;
      }
    }, periodMs);
    moveTimers.set(ws, timer);
  }

  function connectBot(index, user) {
    return new Promise(resolve => {
      const zone = zoneFor(index);
      const separator = wsBase.includes('?') ? '&' : '?';
      const url = wsBase + separator + 'server=free1&zone=' + encodeURIComponent(zone);
      const startedAt = Date.now();
      let welcomed = false;
      let settled = false;
      let open = false;

      const ws = new WebSocket(url, {
        origin,
        handshakeTimeout: 20000,
        perMessageDeflate: false
      });
      sockets.add(ws);
      stats.started++;

      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const timeout = setTimeout(() => {
        if (welcomed || finishing) return;
        stats.welcomeTimeouts++;
        try { ws.close(1000, 'load welcome timeout'); } catch {}
        settle();
      }, 25000);

      ws.on('open', () => {
        open = true;
        stats.opened++;
        stats.active++;
        try {
          ws.send(JSON.stringify({
            type: 'auth',
            token: user.idToken,
            protocol: 6,
            name: ('Load' + index).slice(0, 12),
            continuousHandoff: true
          }));
        } catch {
          stats.connectionErrors++;
          settle();
        }
      });

      ws.on('message', raw => {
        stats.messages++;
        let message;
        try { message = JSON.parse(String(raw)); } catch { return; }
        const type = String(message?.type || 'unknown');
        typeCounts[type] = (typeCounts[type] || 0) + 1;

        if (type === 'welcome' && !welcomed) {
          welcomed = true;
          clearTimeout(timeout);
          stats.welcomed++;
          welcomeLatencyMs.push(Date.now() - startedAt);
          const lastSeq = Number(message?.movement?.lastSeq ?? message?.motion?.lastSeq);
          startMovement(ws, index, Number.isSafeInteger(lastSeq) ? lastSeq + 1 : 0);
          settle();
        } else if (type === 'auth_error') {
          stats.authErrors++;
          clearTimeout(timeout);
          settle();
        } else if (type === 'server_error') {
          stats.serverErrors++;
        } else if (type === 'move') {
          if (Number.isSafeInteger(Number(message?.ack))) stats.moveAcks++;
          else stats.remoteMoves++;
        } else if (type === 'join') stats.joins++;
        else if (type === 'leave') stats.leaves++;
        else if (type === 'ghost_snapshot') stats.ghostSnapshots++;
        else if (type === 'zone_change') stats.zoneChanges++;
      });

      ws.on('unexpected-response', (_request, response) => {
        stats.unexpectedResponses++;
        clearTimeout(timeout);
        try { response.resume(); } catch {}
        settle();
      });

      ws.on('error', () => {
        stats.connectionErrors++;
        clearTimeout(timeout);
        settle();
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        stopMovement(ws);
        if (open && stats.active > 0) stats.active--;
        stats.closed++;
        if (!finishing && welcomed) stats.prematureCloses++;
        sockets.delete(ws);
        settle();
      });
    });
  }

  console.log('=== VOXEL live authenticated WebSocket load test (no Chromium) ===');
  console.log(`Target=${target} bots=${botCount} zones=100 moveHz=${moveHz} connectRate=${connectRate}/s hold=${durationSec}s`);
  console.log('Each bot uses a unique Firebase UID and protocol-6 movement frames.');

  const statTimer = setInterval(() => summary('STAT'), 5000);
  const launchPromises = [];
  const staggerMs = 1000 / connectRate;
  for (let index = 0; index < botCount; index++) {
    launchPromises.push(connectBot(index, selected[index]));
    if (staggerMs > 0) await sleep(staggerMs);
  }
  await Promise.allSettled(launchPromises);
  summary('ADMITTED');

  await sleep(durationSec * 1000);
  await sleep(1500);
  summary('BEFORE-CLOSE');

  finishing = true;
  clearInterval(statTimer);
  for (const ws of [...sockets]) {
    stopMovement(ws);
    try { ws.close(1000, 'load test complete'); } catch {}
  }
  await sleep(2000);
  loopDelay.disable();

  const welcomeRate = botCount ? stats.welcomed / botCount : 0;
  const ackRate = stats.movesSent ? stats.moveAcks / stats.movesSent : 0;
  const eventLoopP95Ms = Math.round(loopDelay.percentile(95) / 1e6);
  const countedErrors = stats.authErrors + stats.connectionErrors + stats.unexpectedResponses +
    stats.serverErrors + stats.welcomeTimeouts + stats.prematureCloses;
  const generatorHealthy = eventLoopP95Ms <= maxGeneratorLagMs && stats.generatorBackpressure === 0;
  const passed = welcomeRate >= minWelcomeRate && ackRate >= minAckRate &&
    countedErrors === 0 && stats.zoneChanges === 0 && generatorHealthy;

  const report = {
    formatVersion: 1,
    mode: 'live-authenticated-websocket-no-chromium',
    target,
    observedAtUTC: new Date().toISOString(),
    config: {
      botCount, durationSec, moveHz, connectRate, zones: 100,
      minWelcomeRate, minAckRate, maxGeneratorLagMs
    },
    result: {
      passed, generatorHealthy, welcomeRate, ackRate, countedErrors,
      eventLoopP95Ms,
      welcomeLatencyMs: {
        samples: welcomeLatencyMs.length,
        p50: percentile(welcomeLatencyMs, 0.50),
        p95: percentile(welcomeLatencyMs, 0.95),
        max: welcomeLatencyMs.length ? Math.max(...welcomeLatencyMs) : null
      }
    },
    stats,
    messageTypes: typeCounts,
    limitations: [
      'Traffic originates from one GitHub-hosted generator unless the workflow is later sharded.',
      'This measures Worker/Durable Object/WebSocket behavior, not browser rendering or mobile GPU performance.',
      'Synthetic clients move with the same protocol-6 input/frames/seq schema but do not render the voxel scene.',
      'Payment, coin collection and Lucky Box mutation are intentionally excluded from load traffic.',
      'A generator event-loop or socket backpressure failure marks the run inconclusive rather than claiming server failure.'
    ]
  };
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
  summary('FINAL');
  console.log(`RESULT passed=${passed} welcomeRate=${(welcomeRate * 100).toFixed(2)}% ackRate=${(ackRate * 100).toFixed(2)}% errors=${countedErrors} generatorLoopP95=${eventLoopP95Ms}ms`);
  if (!passed) process.exitCode = generatorHealthy ? 2 : 3;
}

(async () => {
  if (process.argv.includes('--self-test')) selfTest();
  else await run();
})().catch(error => {
  console.error('FATAL:', error?.message || error);
  process.exit(1);
});
