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

function movementInput(index, seq, motionState = {}) {
  const home = motionState.home;
  const current = motionState.current;
  if (home && current && [home.x, home.z, current.x, current.z].every(Number.isFinite)) {
    const dx = current.x - home.x;
    const dz = current.z - home.z;
    // Keep the steady-state capacity test well inside the assigned Zone.
    // Authority ACKs, not client prediction, choose when to steer home.
    if (Math.abs(dx) >= 12) return { x: dx > 0 ? -1 : 1, z: 0, jump: false };
    if (Math.abs(dz) >= 12) return { x: 0, z: dz > 0 ? -1 : 1, jump: false };
  }
  const phase = (Math.floor(seq / 4) + index) % 4;
  if (phase === 0) return { x: 1, z: 0, jump: false };
  if (phase === 1) return { x: 0, z: 1, jump: false };
  if (phase === 2) return { x: -1, z: 0, jump: false };
  return { x: 0, z: -1, jump: false };
}

function movementPacket(index, seq, hz, elapsedMs, motionState = {}) {
  const periodSeconds = 1 / hz;
  const input = movementInput(index, seq, motionState);
  const frameCount = Math.ceil(periodSeconds / 0.05);
  const delta = periodSeconds / frameCount;
  const frames = Array.from({ length: frameCount }, () => ({ input: { ...input }, delta }));
  return { type: 'move', input, seq, frames };
}

// Charge estimate includes auth, zone visibility, request-fenced checkpointing,
// welcome and conservative fan-out overhead. Count sends during staggered ramp.
function estimatedRequests(bots, holdSeconds, hz, connectRate) {
  const rampSeconds = bots / connectRate;
  const movement = bots * hz * (holdSeconds + rampSeconds / 2);
  return Math.ceil(movement * 3 + bots * 16);
}

function printPlan() {
  const bots=number('BOT_COUNT',10000,1,10000,true);
  const hold=number('DURATION_SEC',60,10,600,true);
  const hz=number('MOVE_HZ',2,1,5,true);
  const rate=number('CONNECT_RATE_PER_SEC',50,5,500);
  const budget=number('MAX_ESTIMATED_DO_REQUESTS',75000,100,1000000000,true);
  const count=new Map();
  for(let i=0;i<bots;i++) count.set(zoneFor(i),(count.get(zoneFor(i))||0)+1);
  const requests=estimatedRequests(bots,hold,hz,rate);
  console.log(JSON.stringify({mode:'offline-capacity-plan-no-network',
    browser:'none',bots,zoneCount:count.size,peakPlayersPerZone:Math.max(...count.values()),
    holdSeconds:hold,moveHz:hz,connectRatePerSec:rate,
    expectedRampSeconds:Math.ceil(bots/rate),
    estimatedDurableObjectRequests:requests,maxAuthorizedRequests:budget,
    liveWouldExceedBudget:requests>budget,realServerCapacityProven:false},null,2));
}

function selfTest() {
  const seen = new Map();
  for (let i = 0; i < 10000; i++) seen.set(zoneFor(i), (seen.get(zoneFor(i)) || 0) + 1);
  if (seen.size !== 100 || [...seen.values()].some(value => value !== 100))
    throw new Error('10K zone distribution self-test failed');
  for (const hz of [2, 5]) {
    const packet = movementPacket(17, 3, hz, 1000, {
      home: { x: 0, z: 0 }, current: { x: 0, z: 0 }
    });
    const total = packet.frames.reduce((sum, frame) => sum + frame.delta, 0);
    if (packet.frames.length < 1 || packet.frames.length > 64 || total > 0.500000001 ||
        packet.frames.some(frame => frame.delta < 0 || frame.delta > 0.1))
      throw new Error('Movement frame self-test failed');
  }
  const correction = movementPacket(0, 10, 5, 0, {
    home: { x: 0, z: 0 }, current: { x: 20, z: 0 }
  });
  if (correction.input.x !== -1 || correction.input.z !== 0)
    throw new Error('Bounded movement steering self-test failed');
  console.log('PASS 10K zone distribution: 100 zones x 100 players');
  console.log('PASS current movement packet shape: input + frames + seq');
  console.log('PASS bounded authoritative steering keeps capacity traffic inside its assigned Zone');
  const projection=estimatedRequests(10000,60,5,100);
  if(projection<3000000) throw new Error('Missing conservative 10K Durable Object cost protection');
  console.log('PASS 10K/5Hz/60s estimated Durable Object request budget guard');
}

async function run() {
  const botCount = number('BOT_COUNT', 100, 1, 10000, true);
  const durationSec = number('DURATION_SEC', 60, 10, 600, true);
  const moveHz = number('MOVE_HZ', 2, 1, 5, true);
  const connectRate = number('CONNECT_RATE_PER_SEC', 50, 5, 500);
  const minWelcomeRate = number('MIN_WELCOME_RATE', 0.995, 0.9, 1);
  const minAckRate = number('MIN_ACK_RATE', 0.95, 0.5, 1);
  const maxGeneratorLagMs = number('MAX_GENERATOR_EVENT_LOOP_P95_MS', 300, 20, 5000);
  const dailyBudget = number('MAX_ESTIMATED_DO_REQUESTS', 75000, 100, 1000000000, true);
  const estimate = estimatedRequests(botCount, durationSec, moveHz, connectRate);
  if (estimate > dailyBudget) throw new Error(
    'SAFETY: Estimated Durable Object requests ' + estimate +
    ' exceed authorized MAX_ESTIMATED_DO_REQUESTS=' + dailyBudget +
    '. Never bypass on Free tier. Use an approved Paid plan and explicit budget before any live 10K.'
  );
  const wsBase = String(process.env.WS_URL || '').trim();
  const origin = String(process.env.ORIGIN || '').trim();
  const target = String(process.env.TARGET || 'unknown').trim();
  const local = target === 'loopback' &&
    /^ws:\/\/(127\.0\.0\.1|localhost):[0-9]+\/play$/.test(wsBase);
  if (!local && !/^wss:\/\//.test(wsBase))
    throw new Error('WS_URL must be wss:// (except explicit localhost loopback)');
  if (!['staging','loopback'].includes(target) &&
      process.env.ALLOW_PRODUCTION_LOAD !== 'I-ACCEPT-PRODUCTION-IMPACT')
    throw new Error('SAFETY: production or unknown target requires explicit ALLOW_PRODUCTION_LOAD confirmation');
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
    started: 0, opened: 0, active: 0, welcomed: 0, liveWelcomed: 0, peakWelcomed: 0, authErrors: 0,
    connectionErrors: 0, unexpectedResponses: 0, serverErrors: 0,
    welcomeTimeouts: 0, prematureCloses: 0, closed: 0, messages: 0,
    movesSent: 0, moveAcks: 0, remoteMoves: 0, joins: 0, leaves: 0,
    ghostSnapshots: 0, zoneChanges: 0, generatorBackpressure: 0
  };
  const typeCounts = {};
  const prematureCloseCodes = {};
  const prematureCloseReasons = {};
  const welcomeLatencyMs = [];
  const ackLatencyMs = [];
  const sockets = new Set();
  // One pooled timer serves all 10,000 sessions; never create 10,000 intervals.
  const movers = new Map();
  let schedulerTicks = 0;
  const scheduler = setInterval(() => {
    if (finishing) return;
    schedulerTicks++;
    const now=Date.now();
    for (const [socket, state] of movers) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (now < state.nextAt) continue;
      state.nextAt = now + state.periodMs; // no burst replay after stalled event loop
      if (socket.bufferedAmount > 256 * 1024) {
        stats.generatorBackpressure++;
        continue;
      }
      try {
        const packet=movementPacket(state.index,state.seq++,moveHz,
          now-testStart,state.motionState);
        socket.send(JSON.stringify(packet));
        state.sentAt.set(packet.seq, now);
        if (state.sentAt.size > 256) state.sentAt.delete(state.sentAt.keys().next().value);
        stats.movesSent++;
      } catch {
        stats.connectionErrors++;
      }
    }
  }, 40);
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

  function stopMovement(ws) { movers.delete(ws); }

  function startMovement(ws, index, initialSeq, motionState) {
    movers.set(ws, {
      index, seq:initialSeq, motionState,
      periodMs:Math.round(1000/moveHz),
      nextAt:Date.now()+Math.round(1000/moveHz), sentAt:new Map()
    });
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
      const motionState = { home: null, current: null };

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
          stats.liveWelcomed++;
          stats.peakWelcomed=Math.max(stats.peakWelcomed,stats.liveWelcomed);
          welcomeLatencyMs.push(Date.now() - startedAt);
          const lastSeq = Number(message?.movement?.lastSeq ?? message?.motion?.lastSeq);
          if (Number.isFinite(message?.spawn?.x) && Number.isFinite(message?.spawn?.z)) {
            motionState.home = { x: Number(message.spawn.x), z: Number(message.spawn.z) };
            motionState.current = { ...motionState.home };
          }
          startMovement(ws, index, Number.isSafeInteger(lastSeq) ? lastSeq + 1 : 0, motionState);
          settle();
        } else if (type === 'auth_error') {
          stats.authErrors++;
          clearTimeout(timeout);
          settle();
        } else if (type === 'server_error') {
          stats.serverErrors++;
        } else if (type === 'move') {
          if (Number.isSafeInteger(Number(message?.ack))) {
            stats.moveAcks++;
            const sending=movers.get(ws);
            const seq=Number(message.ack);
            const sentAt=sending?.sentAt?.get(seq);
            if (Number.isFinite(sentAt)) {
              ackLatencyMs.push(Math.max(0,Date.now()-sentAt));
              sending.sentAt.delete(seq);
            }
            if (Number.isFinite(message?.player?.x) && Number.isFinite(message?.player?.z))
              motionState.current = { x: Number(message.player.x), z: Number(message.player.z) };
          } else stats.remoteMoves++;
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

      ws.on('close', (code, reasonValue) => {
        clearTimeout(timeout);
        stopMovement(ws);
        if (open && stats.active > 0) stats.active--;
        if (welcomed && stats.liveWelcomed > 0) stats.liveWelcomed--;
        stats.closed++;
        if (!finishing && welcomed) {
          stats.prematureCloses++;
          const codeKey=String(code);
          const reason=Buffer.isBuffer(reasonValue)
            ? reasonValue.toString('utf8').slice(0,120)
            : String(reasonValue||'').slice(0,120);
          const reasonKey=reason||'(none)';
          prematureCloseCodes[codeKey]=(prematureCloseCodes[codeKey]||0)+1;
          prematureCloseReasons[reasonKey]=(prematureCloseReasons[reasonKey]||0)+1;
          if (stats.prematureCloses<=12)
            console.log(`[PREMATURE-CLOSE] index=${index} zone=${zone} code=${codeKey} reason=${reasonKey}`);
        }
        sockets.delete(ws);
        settle();
      });
    });
  }

  console.log('=== VOXEL live authenticated WebSocket load test (no Chromium) ===');
  console.log(`Target=${target} bots=${botCount} zones=100 moveHz=${moveHz} connectRate=${connectRate}/s hold=${durationSec}s estimatedDORequests=${estimate}/${dailyBudget}`);
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
  clearInterval(scheduler);
  const closing=[...sockets];
  const closeRate=200;
  for (let index=0; index<closing.length; index++) {
    const ws=closing[index];
    stopMovement(ws);
    try { ws.close(1000, 'load test complete'); } catch {}
    if ((index+1)%closeRate===0 && index+1<closing.length) await sleep(1000);
  }
  await sleep(2000);
  loopDelay.disable();

  const welcomeRate = botCount ? stats.welcomed / botCount : 0;
  const ackRate = stats.movesSent ? stats.moveAcks / stats.movesSent : 0;
  const eventLoopP95Ms = Math.round(loopDelay.percentile(95) / 1e6);
  const countedErrors = stats.authErrors + stats.connectionErrors + stats.unexpectedResponses +
    stats.serverErrors + stats.welcomeTimeouts + stats.prematureCloses;
  const generatorHealthy = eventLoopP95Ms <= maxGeneratorLagMs && stats.generatorBackpressure === 0;
  const hasPeakConcurrency = stats.peakWelcomed >= Math.ceil(botCount * minWelcomeRate) &&
    (botCount !== 10000 || stats.peakWelcomed === 10000);
  const passed = hasPeakConcurrency && welcomeRate >= minWelcomeRate && ackRate >= minAckRate &&
    countedErrors === 0 && stats.zoneChanges === 0 && generatorHealthy;

  const report = {
    formatVersion: 2,
    mode: 'live-authenticated-websocket-no-chromium-v2-pooled',
    target,
    observedAtUTC: new Date().toISOString(),
    config: {
      botCount, durationSec, moveHz, connectRate, zones: 100,
      minWelcomeRate, minAckRate, maxGeneratorLagMs
    },
    result: {
      passed, hasPeakConcurrency, generatorHealthy, welcomeRate, ackRate, countedErrors,
      eventLoopP95Ms,
      welcomeLatencyMs: {
        samples: welcomeLatencyMs.length,
        p50: percentile(welcomeLatencyMs, 0.50),
        p95: percentile(welcomeLatencyMs, 0.95),
        max: welcomeLatencyMs.length ? Math.max(...welcomeLatencyMs) : null
      },
      ackLatencyMs: {
        samples:ackLatencyMs.length,
        p50:percentile(ackLatencyMs,0.50),
        p95:percentile(ackLatencyMs,0.95),
        max:ackLatencyMs.length?ackLatencyMs.reduce((max,v)=>Math.max(max,v),0):null
      }
    },
    stats,
    scheduler: { mode:'pooled-40ms', ticks:schedulerTicks, peakAuthenticatedConcurrent:stats.peakWelcomed },
    budget: { estimatedDurableObjectRequests:estimate, approvedMax:dailyBudget,
      note:'Conservative safety projection, not Cloudflare invoice or measured usage' },
    messageTypes: typeCounts,
    prematureCloseCodes,
    prematureCloseReasons,
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
  else if (process.argv.includes('--plan')) printPlan();
  else await run();
})().catch(error => {
  console.error('FATAL:', error?.message || error);
  process.exit(1);
});
