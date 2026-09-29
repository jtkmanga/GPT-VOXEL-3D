#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const TARGET = process.env.WS_URL || 'wss://voxel-run-v2-demo.hjinffv5426.workers.dev/play';
const BOT_COUNT = Math.max(1, Number(process.env.BOT_COUNT || 50));
const DURATION_SEC = Math.max(5, Number(process.env.DURATION_SEC || 30));
const CONNECT_STAGGER_MS = Math.max(0, Number(process.env.CONNECT_STAGGER_MS || 50));
const MOVE_INTERVAL_MS = Math.max(200, Number(process.env.MOVE_INTERVAL_MS || 210));
const FIREBASE_API_KEY = String(process.env.FIREBASE_API_KEY || '').trim();
let TOKEN = String(process.env.FIREBASE_ID_TOKEN || '').trim();

const sockets = new Set();
const moveTimers = new Map();
const welcomeLatencies = [];
let anonymousTokenCreated = false;

const stats = {
  started: 0,
  opened: 0,
  welcomed: 0,
  authErrors: 0,
  connectionErrors: 0,
  handshakeRejected: 0,
  closed: 0,
  messages: 0,
  movesSent: 0,
  serverMovesReceived: 0,
  joinsReceived: 0,
  leavesReceived: 0,
  serverErrors: 0,
};
const handshakeStatuses = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a,b)=>a-b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p/100)*s.length)-1));
  return s[i];
}

async function createAnonymousFirebaseToken() {
  if (!FIREBASE_API_KEY) return null;
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({returnSecureToken:true}),
  });
  const body = await response.json().catch(()=>({}));
  if (!response.ok || !body.idToken) {
    throw new Error(`Firebase anonymous sign-in failed (${response.status}): ${body?.error?.message || 'unknown error'}`);
  }
  anonymousTokenCreated = true;
  return body.idToken;
}

async function deleteAnonymousFirebaseUser() {
  if (!anonymousTokenCreated || !TOKEN || !FIREBASE_API_KEY) return;
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({idToken:TOKEN}),
      }
    );
    if (response.ok) console.log('Temporary anonymous Firebase test user deleted.');
    else console.log(`Warning: could not delete temporary anonymous test user (${response.status}).`);
  } catch (_) {
    console.log('Warning: could not delete temporary anonymous test user.');
  }
}

function snapshot(label='STAT') {
  const p50 = percentile(welcomeLatencies, 50);
  const p95 = percentile(welcomeLatencies, 95);
  const active = [...sockets].filter(ws => ws.readyState === WebSocket.OPEN).length;
  const statusText = [...handshakeStatuses.entries()].map(([k,v])=>`${k}:${v}`).join(',');
  console.log(
    `[${label}] started=${stats.started}/${BOT_COUNT} open=${stats.opened} active=${active} ` +
    `welcome=${stats.welcomed} authErr=${stats.authErrors} connErr=${stats.connectionErrors} ` +
    `rejected=${stats.handshakeRejected}${statusText ? `(${statusText})` : ''} closed=${stats.closed} ` +
    `movesSent=${stats.movesSent} recv=${stats.messages} serverMoves=${stats.serverMovesReceived}` +
    (p50 === null ? '' : ` welcomeMs(p50/p95)=${p50}/${p95}`)
  );
}

function stopMove(ws) {
  const t = moveTimers.get(ws);
  if (t) clearInterval(t);
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
  let vx = Math.cos(angle) * 3.5;
  let vz = Math.sin(angle) * 3.5;
  const radius = 6;

  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const dt = MOVE_INTERVAL_MS / 1000;

    let nx = x + vx * dt;
    let nz = z + vz * dt;

    if (Math.abs(nx-originX) > radius) {
      vx *= -1;
      nx = x + vx*dt;
    }
    if (Math.abs(nz-originZ) > radius) {
      vz *= -1;
      nz = z + vz*dt;
    }

    x = nx;
    z = nz;
    r += 0.025;

    try {
      ws.send(JSON.stringify({type:'move',x,y,z,r}));
      stats.movesSent++;
    } catch (_) {}
  }, MOVE_INTERVAL_MS);

  moveTimers.set(ws, timer);
}

function startBot(i) {
  return new Promise(resolve => {
    stats.started++;
    const createdAt = Date.now();
    let settled = false;
    let welcomed = false;

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
      try {
        ws.send(JSON.stringify({type:'auth', token:TOKEN}));
      } catch (_) {}
    });

    ws.on('unexpected-response', (_req, res) => {
      stats.handshakeRejected++;
      const status = Number(res.statusCode) || 0;
      handshakeStatuses.set(status, (handshakeStatuses.get(status)||0)+1);
      res.resume();
      settle();
    });

    ws.on('message', raw => {
      stats.messages++;
      let m;
      try { m = JSON.parse(String(raw)); } catch (_) { return; }

      if (m?.type === 'welcome') {
        if (!welcomed) {
          welcomed = true;
          stats.welcomed++;
          welcomeLatencies.push(Date.now()-createdAt);
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
  if (!TOKEN) {
    if (!FIREBASE_API_KEY) {
      console.error('ERROR: Set FIREBASE_API_KEY (Anonymous Auth) or FIREBASE_ID_TOKEN.');
      process.exit(2);
    }
    console.log('Creating one temporary anonymous Firebase test account...');
    TOKEN = await createAnonymousFirebaseToken();
  }

  console.log('=== VOXEL RUN Phase 1 Authenticated Movement Load Test ===');
  console.log(`Target: ${TARGET}`);
  console.log(`Bots: ${BOT_COUNT}`);
  console.log(`Duration: ${DURATION_SEC}s`);
  console.log(`Connect stagger: ${CONNECT_STAGGER_MS}ms`);
  console.log(`Movement: about ${(1000/MOVE_INTERVAL_MS).toFixed(2)} Hz`);
  console.log('The same short-lived TEST token is reused across bot sockets; each socket still gets its own player id.');
  console.log('');

  const starters = [];
  for (let i=0; i<BOT_COUNT; i++) {
    starters.push(startBot(i));
    if (CONNECT_STAGGER_MS) await sleep(CONNECT_STAGGER_MS);
  }

  const statTimer = setInterval(()=>snapshot(), 5000);
  await Promise.allSettled(starters);
  snapshot('CONNECTED');

  await sleep(DURATION_SEC*1000);

  clearInterval(statTimer);
  snapshot('BEFORE-CLOSE');

  for (const ws of sockets) {
    stopMove(ws);
    try { ws.close(1000,'load test finished'); } catch (_) {}
  }
  await sleep(2500);
  snapshot('FINAL');

  await deleteAnonymousFirebaseUser();

  console.log('');
  const expectedMoves = stats.welcomed * Math.floor((DURATION_SEC*1000)/MOVE_INTERVAL_MS);
  console.log(`Approx expected sent moves after welcome: <= ${expectedMoves}`);
  if (stats.authErrors || stats.connectionErrors || stats.handshakeRejected) {
    console.log('RESULT: investigate errors before increasing bot count.');
  } else if (stats.welcomed !== BOT_COUNT) {
    console.log('RESULT: not all bots reached welcome; investigate before increasing bot count.');
  } else {
    console.log('RESULT: authenticated movement test completed with all bots welcomed.');
  }
}

process.on('SIGINT', async () => {
  for (const ws of sockets) {
    stopMove(ws);
    try { ws.close(); } catch (_) {}
  }
  await deleteAnonymousFirebaseUser();
  process.exit(130);
});

main().catch(async err => {
  console.error(err?.stack || err);
  await deleteAnonymousFirebaseUser();
  process.exit(1);
});
