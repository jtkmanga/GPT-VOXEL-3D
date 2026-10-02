#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const { monitorEventLoopDelay } = require('perf_hooks');

const WS_BASE = process.env.WS_BASE || 'wss://voxel-run-v2-demo.hjinffv5426.workers.dev/play';
const BOT_COUNT = Math.max(1, Number(process.env.BOT_COUNT || 1000));
const DURATION_SEC = Math.max(10, Number(process.env.DURATION_SEC || 120));
const CONNECT_STAGGER_MS = Math.max(5, Number(process.env.CONNECT_STAGGER_MS || 30));
const MOVE_HZ = Math.min(5, Math.max(1, Number(process.env.MOVE_HZ || 5)));
const GEN_ID = Math.max(0, Number(process.env.GEN_ID || 0));
const GEN_TOTAL = Math.max(1, Number(process.env.GEN_TOTAL || 1));
const FIREBASE_API_KEY = String(process.env.FIREBASE_API_KEY || '').trim();
let FIREBASE_ID_TOKEN = String(process.env.FIREBASE_ID_TOKEN || '').trim();

const ZONE_GRID = 10;
const MAP_SIZE = 1500;
const ZONE_SIZE = MAP_SIZE / ZONE_GRID;
const HALF = MAP_SIZE / 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  return s[Math.min(s.length-1, Math.max(0, Math.floor((p/100) * s.length)))];
};

function zoneIdForBot(i) {
  // Deterministic spread across all 100 zones and across multiple generators.
  const globalIndex = i * GEN_TOTAL + GEN_ID;
  const n = globalIndex % 100;
  return `${n % ZONE_GRID},${Math.floor(n / ZONE_GRID)}`;
}

function zoneCenter(zoneId) {
  const [zx, zz] = zoneId.split(',').map(Number);
  return {
    x: HALF * -1 + zx * ZONE_SIZE + ZONE_SIZE / 2,
    z: HALF * -1 + zz * ZONE_SIZE + ZONE_SIZE / 2
  };
}

function safeMotion(seed, zoneId, t) {
  const c = zoneCenter(zoneId);
  const phase = (seed % 360) * Math.PI / 180;
  // Radius 20 keeps bots far from Zone borders so Phase 3A measures steady-state load,
  // not handoff cost. Cross-zone stress comes in Phase 3B.
  const radius = 20;
  const w = 0.35;
  return {
    x: c.x + Math.cos(phase + t * w) * radius,
    y: 0,
    z: c.z + Math.sin(phase + t * w) * radius,
    r: phase + t * w + Math.PI / 2
  };
}

async function createAnonymousToken() {
  if (FIREBASE_ID_TOKEN) return FIREBASE_ID_TOKEN;
  if (!FIREBASE_API_KEY) {
    throw new Error('Set FIREBASE_ID_TOKEN or FIREBASE_API_KEY');
  }
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({returnSecureToken:true})
    }
  );
  const body = await r.json().catch(()=>({}));
  if (!r.ok || !body.idToken) {
    throw new Error(`Anonymous Firebase sign-in failed: ${body?.error?.message || r.status}`);
  }
  FIREBASE_ID_TOKEN = body.idToken;
  return FIREBASE_ID_TOKEN;
}

async function deleteAnonymousToken() {
  if (!FIREBASE_API_KEY || !FIREBASE_ID_TOKEN) return;
  try {
    await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({idToken:FIREBASE_ID_TOKEN})
      }
    );
  } catch (_) {}
}

const stats = {
  started:0, open:0, active:0, welcome:0, authErr:0, connErr:0, rejected:0, closed:0,
  movesSent:0, recv:0, moveRecv:0, ghostRecv:0, serverErr:0, zoneChange:0
};
const welcomeMs = [];
const sockets = new Set();
const eventLoop = monitorEventLoopDelay({resolution:20});
eventLoop.enable();

function printStats(tag='STAT') {
  const p50 = Math.round(pct(welcomeMs,50));
  const p95 = Math.round(pct(welcomeMs,95));
  const lagP95 = Math.round(eventLoop.percentile(95) / 1e6);
  console.log(
    `[${tag}] gen=${GEN_ID+1}/${GEN_TOTAL} started=${stats.started}/${BOT_COUNT} ` +
    `open=${stats.open} active=${stats.active} welcome=${stats.welcome} ` +
    `authErr=${stats.authErr} connErr=${stats.connErr} rejected=${stats.rejected} ` +
    `closed=${stats.closed} movesSent=${stats.movesSent} recv=${stats.recv} ` +
    `moveRecv=${stats.moveRecv} ghostRecv=${stats.ghostRecv} zoneChange=${stats.zoneChange} ` +
    `serverErr=${stats.serverErr} welcomeMs(p50/p95)=${p50}/${p95} eventLoopP95=${lagP95}ms`
  );
}

function connectBot(i, token, startedAt) {
  return new Promise(resolve => {
    const zone = zoneIdForBot(i);
    const url = `${WS_BASE}?zone=${encodeURIComponent(zone)}`;
    const started = Date.now();
    let welcomed = false;
    let moveTimer = null;
    let settled = false;

    const ws = new WebSocket(url, {
      handshakeTimeout: 15000,
      perMessageDeflate: false
    });
    sockets.add(ws);
    stats.started++;

    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    ws.on('open', () => {
      stats.open++;
      stats.active++;
      ws.send(JSON.stringify({
        type:'auth',
        token,
        name:`Load${GEN_ID}-${i}`
      }));
    });

    ws.on('message', raw => {
      stats.recv++;
      let m;
      try { m = JSON.parse(String(raw)); } catch (_) { return; }

      if (m?.type === 'welcome' && !welcomed) {
        welcomed = true;
        stats.welcome++;
        welcomeMs.push(Date.now() - started);

        // Use server spawn as a safe baseline, then orbit within the assigned zone.
        let tick = 0;
        const period = Math.round(1000 / MOVE_HZ);
        moveTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const t = (Date.now() - startedAt) / 1000;
          const p = safeMotion(i + GEN_ID * 10000, zone, t + tick * 0.001);
          ws.send(JSON.stringify({type:'move', ...p}));
          stats.movesSent++;
          tick++;
        }, period);
      } else if (m?.type === 'move') {
        stats.moveRecv++;
      } else if (m?.type === 'ghost_snapshot') {
        stats.ghostRecv++;
      } else if (m?.type === 'zone_change') {
        stats.zoneChange++;
      } else if (m?.type === 'auth_error') {
        stats.authErr++;
      } else if (m?.type === 'server_error') {
        stats.serverErr++;
      }
    });

    ws.on('unexpected-response', (_req,res) => {
      stats.rejected++;
      try { res.resume(); } catch (_) {}
      settle();
    });

    ws.on('error', () => {
      stats.connErr++;
      settle();
    });

    ws.on('close', () => {
      if (moveTimer) clearInterval(moveTimer);
      if (stats.active > 0) stats.active--;
      stats.closed++;
      sockets.delete(ws);
      settle();
    });
  });
}

async function main() {
  console.log('=== VOXEL RUN Phase 3A steady-state zone load test ===');
  console.log(`Target: ${WS_BASE}`);
  console.log(`Bots: ${BOT_COUNT}`);
  console.log(`Duration: ${DURATION_SEC}s`);
  console.log(`Move rate: ${MOVE_HZ}Hz`);
  console.log(`Connect stagger: ${CONNECT_STAGGER_MS}ms`);
  console.log(`Generator: ${GEN_ID+1}/${GEN_TOTAL}`);
  console.log('Distribution: round-robin across 100 zones');
  console.log('NOTE: Phase 3A intentionally avoids Zone borders/handoffs.');

  const token = await createAnonymousToken();
  const start = Date.now();

  const launches = [];
  for (let i=0;i<BOT_COUNT;i++) {
    launches.push(connectBot(i, token, start));
    await sleep(CONNECT_STAGGER_MS);
  }

  const statTimer = setInterval(()=>printStats('STAT'), 5000);

  const remaining = Math.max(0, DURATION_SEC * 1000 - (Date.now() - start));
  await sleep(remaining);

  clearInterval(statTimer);
  printStats('BEFORE-CLOSE');

  for (const ws of [...sockets]) {
    try { ws.close(1000,'Phase3A complete'); } catch (_) {}
  }

  await sleep(1500);
  printStats('FINAL');

  const welcomeRate = stats.started ? stats.welcome / stats.started : 0;
  const errorTotal = stats.authErr + stats.connErr + stats.rejected + stats.serverErr;

  console.log('');
  console.log('=== RESULT ===');
  console.log(`welcomeRate=${(welcomeRate*100).toFixed(2)}%`);
  console.log(`errors=${errorTotal}`);
  console.log(`welcomeP50=${Math.round(pct(welcomeMs,50))}ms`);
  console.log(`welcomeP95=${Math.round(pct(welcomeMs,95))}ms`);
  console.log(`eventLoopP95=${Math.round(eventLoop.percentile(95)/1e6)}ms`);

  if (welcomeRate >= 0.995 && errorTotal === 0) {
    console.log('PASS: Phase 3A generator completed with >=99.5% welcomes and zero counted errors.');
  } else {
    console.log('REVIEW: Do not increase bot count yet. Inspect errors and Cloudflare metrics.');
    process.exitCode = 2;
  }
}

main()
  .catch(err => {
    console.error('FATAL:', err?.stack || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    eventLoop.disable();
    await deleteAnonymousToken();
  });
