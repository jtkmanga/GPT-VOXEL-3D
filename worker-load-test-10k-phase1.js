#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const TARGET = process.env.WS_URL || 'wss://voxel-run-v2-demo.hjinffv5426.workers.dev/play';
const BOT_COUNT = Math.max(1, Number(process.env.BOT_COUNT || 100));
const DURATION_SEC = Math.max(5, Number(process.env.DURATION_SEC || 60));
const CONNECT_STAGGER_MS = Math.max(0, Number(process.env.CONNECT_STAGGER_MS || 25));
const MOVE_INTERVAL_MS = Math.max(200, Number(process.env.MOVE_INTERVAL_MS || 210));
const TOKEN = String(process.env.FIREBASE_ID_TOKEN || '').trim();
const AUTH_MODE = TOKEN.length >= 100;

const sockets = new Set();
const moveTimers = new Map();
const latencies = [];

const stats = {
  started: 0,
  opened: 0,
  welcomed: 0,
  authErrors: 0,
  connectionErrors: 0,
  closed: 0,
  messages: 0,
  movesSent: 0,
  serverMovesReceived: 0,
  joinsReceived: 0,
  leavesReceived: 0,
  serverErrors: 0,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a,b)=>a-b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p/100)*s.length)-1));
  return s[i];
}

function snapshot(label='STAT') {
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const active = [...sockets].filter(ws => ws.readyState === WebSocket.OPEN).length;
  console.log(
    `[${label}] mode=${AUTH_MODE ? 'AUTH+MOVE' : 'CONNECTION-ONLY'} ` +
    `started=${stats.started}/${BOT_COUNT} open=${stats.opened} active=${active} ` +
    `welcome=${stats.welcomed} authErr=${stats.authErrors} connErr=${stats.connectionErrors} ` +
    `closed=${stats.closed} movesSent=${stats.movesSent} recv=${stats.messages} ` +
    `serverMoves=${stats.serverMovesReceived}` +
    (p50 === null ? '' : ` welcomeLatencyMs(p50/p95)=${p50}/${p95}`)
  );
}

function stopMove(ws) {
  const timer = moveTimers.get(ws);
  if (timer) clearInterval(timer);
  moveTimers.delete(ws);
}

function beginMovement(ws, botIndex, spawn) {
  let x = Number(spawn?.x) || 0;
  let y = Number(spawn?.y) || 0;
  let z = Number(spawn?.z) || 0;
  let r = 0;

  const originX = x;
  const originZ = z;
  const angle = ((botIndex * 137.508) % 360) * Math.PI / 180;
  let vx = Math.cos(angle) * 4.0;
  let vz = Math.sin(angle) * 4.0;
  const radius = 8;

  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;

    const dt = MOVE_INTERVAL_MS / 1000;
    let nx = x + vx * dt;
    let nz = z + vz * dt;

    if (Math.abs(nx - originX) > radius) {
      vx *= -1;
      nx = x + vx * dt;
    }
    if (Math.abs(nz - originZ) > radius) {
      vz *= -1;
      nz = z + vz * dt;
    }

    x = nx;
    z = nz;
    r += 0.03;

    try {
      ws.send(JSON.stringify({ type:'move', x, y, z, r }));
      stats.movesSent++;
    } catch (_) {}
  }, MOVE_INTERVAL_MS);

  moveTimers.set(ws, timer);
}

function startBot(i) {
  return new Promise(resolve => {
    stats.started++;
    const createdAt = Date.now();
    let welcomed = false;
    let settled = false;

    const ws = new WebSocket(TARGET, {
      handshakeTimeout: 15000,
      perMessageDeflate: false,
    });
    sockets.add(ws);

    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    ws.on('open', () => {
      stats.opened++;
      if (AUTH_MODE) {
        try {
          ws.send(JSON.stringify({ type:'auth', token:TOKEN }));
        } catch (_) {}
      } else {
        settle();
      }
    });

    ws.on('message', raw => {
      stats.messages++;
      let m;
      try { m = JSON.parse(String(raw)); } catch (_) { return; }

      if (m?.type === 'welcome') {
        if (!welcomed) {
          welcomed = true;
          stats.welcomed++;
          latencies.push(Date.now() - createdAt);
          beginMovement(ws, i, m.spawn || {});
          settle();
        }
      } else if (m?.type === 'auth_error') {
        stats.authErrors++;
        settle();
      } else if (m?.type === 'move') {
        stats.serverMovesReceived++;
      } else if (m?.type === 'join') {
        stats.joinsReceived++;
      } else if (m?.type === 'leave') {
        stats.leavesReceived++;
      } else if (m?.type === 'server_error') {
        stats.serverErrors++;
      }
    });

    ws.on('error', () => {
      stats.connectionErrors++;
      settle();
    });

    ws.on('close', () => {
      stopMove(ws);
      stats.closed++;
      settle();
    });

    setTimeout(settle, 16000);
  });
}

async function main() {
  console.log('=== VOXEL RUN Phase 1 Load Test ===');
  console.log(`Target: ${TARGET}`);
  console.log(`Bots: ${BOT_COUNT}`);
  console.log(`Duration: ${DURATION_SEC}s`);
  console.log(`Connect stagger: ${CONNECT_STAGGER_MS}ms`);
  console.log(`Mode: ${AUTH_MODE ? 'AUTHENTICATED + movement' : 'CONNECTION-ONLY (no Firebase token)'}`);
  if (AUTH_MODE) console.log(`Movement interval: ${MOVE_INTERVAL_MS}ms`);
  console.log('');

  const starters = [];
  for (let i = 0; i < BOT_COUNT; i++) {
    starters.push(startBot(i));
    if (CONNECT_STAGGER_MS) await sleep(CONNECT_STAGGER_MS);
  }

  const statTimer = setInterval(() => snapshot(), 5000);

  await Promise.allSettled(starters);
  snapshot('CONNECTED');

  await sleep(DURATION_SEC * 1000);

  clearInterval(statTimer);
  snapshot('BEFORE-CLOSE');

  for (const ws of sockets) {
    stopMove(ws);
    try { ws.close(1000, 'load test finished'); } catch (_) {}
  }

  await sleep(1500);
  snapshot('FINAL');

  console.log('');
  if (!AUTH_MODE) {
    console.log('NOTE: This run tested WebSocket connection capacity only.');
    console.log('Set FIREBASE_ID_TOKEN to test authenticated 5Hz movement/proximity broadcasting.');
  } else if (stats.welcomed < Math.floor(BOT_COUNT * 0.95)) {
    console.log('WARNING: Fewer than 95% of bots received welcome. Inspect auth errors / connection errors.');
  } else {
    console.log('Authenticated movement load test completed.');
  }
}

process.on('SIGINT', async () => {
  for (const ws of sockets) {
    stopMove(ws);
    try { ws.close(); } catch (_) {}
  }
  process.exit(130);
});

main().catch(err => {
  console.error(err);
  process.exit(1);
});
