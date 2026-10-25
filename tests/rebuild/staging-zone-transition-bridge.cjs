'use strict';

// Offline boundary transport for the real Worker/ZoneRoom/GameRoom graph.
// All credentials and identities are synthesized by the existing local harness.
const fs = require('node:fs');
const readline = require('node:readline');
const { createHarness } = require('./harness.cjs');
const { buildStagingClient } = require('../../scripts/rebuild/build-staging-client.cjs');
const ORIGIN = 'https://gpt-voxel-3d-staging-zone-fixture.invalid';
const PROJECT = 'voxel-staging-zone-fixture';
const PUBLIC = { environment: 'staging', workerName: 'gpt-voxel-3d-staging-zone-fixture', workerOrigin: ORIGIN,
  firebase: { apiKey: 'synthetic-public-staging-key', authDomain: `${PROJECT}.firebaseapp.com`,
    projectId: PROJECT, appId: '1:123456789:web:abcdef1234567890' }, authMode: 'popup' };
const NOW = 1_900_000_000_000;
const UID = 'synthetic-staging-zone-player';
const zoneAt = p => `${Math.floor((p.x + 750) / 150)},${Math.floor((p.z + 750) / 150)}`;
const plain = value => JSON.parse(JSON.stringify(value));
const sockets = new Map();
let h, fixture, firstPlaced = false;
const membershipHistory = [];

// Large histories exceed the kernel pipe buffer. Complete every byte even
// when this executor's nonblocking stdout pipe accepts only a prefix.
async function writeOutput(value) {
  const bytes=Buffer.from(value);
  let offset=0;
  while (offset<bytes.length) {
    try {
      const written=fs.writeSync(1,bytes,offset,bytes.length-offset);
      offset+=written;
      if (!written) await new Promise(resolve=>setImmediate(resolve));
    } catch (error) {
      if (error.code!=='EAGAIN' && error.code!=='EWOULDBLOCK') throw error;
      await new Promise(resolve=>setImmediate(resolve));
    }
  }
}

async function initialize() {
  h = createHarness({ now: NOW, workerOrigin: ORIGIN, defaultTokenProject: PROJECT,
    env: { APP_ENV: 'staging', STAGING_WORKER_NAME: PUBLIC.workerName, STAGING_WORKER_ORIGIN: ORIGIN,
      ALLOWED_ORIGIN: ORIGIN, FIREBASE_PROJECT_ID: PROJECT, FIREBASE_PUBLIC_CONFIG: JSON.stringify(PUBLIC.firebase),
      STAGING_AUTH_MODE: 'popup', PAYMENT_MODE: 'provider-neutral-test',
      SLIP2GO_API_SECRET: undefined, PAYMENT_WEBHOOK_SECRET: undefined } });
  await h.room().ready;
  const { SERVER_WORLD } = await import('../../src/worker/world.mjs');
  const obstacles = [...SERVER_WORLD.buildings, ...SERVER_WORLD.trees];
  const coins = h.room().coinSnapshot();
  let pair;
  for (const before of coins) {
    const boundary = (Math.floor((before.x + 750) / 150) + 1) * 150 - 750;
    if (!(before.x > boundary - 25 && before.x < boundary - 3)) continue;
    const after = coins.find(c => c.x > boundary + 3 && c.x < boundary + 30 && Math.abs(c.z - before.z) < 12 &&
      Math.floor((c.z + 750) / 150) === Math.floor((before.z + 750) / 150));
    if (!after) continue;
    const bounds = { minX: before.x - 85, maxX: after.x + 70,
      minZ: Math.min(before.z, after.z) - 12, maxZ: Math.max(before.z, after.z) + 12 };
    if (obstacles.some(o => o.minX < bounds.maxX && o.maxX > bounds.minX && o.minZ < bounds.maxZ && o.maxZ > bounds.minZ)) continue;
    pair = { before: plain(before), after: plain(after), boundary };
    break;
  }
  if (!pair) throw Error('No clear real-coin boundary trajectory');
  const spawn = { x: process.argv.includes('--near-border') ? pair.boundary - 4 : pair.before.x - 8,
    y: 0, z: pair.before.z, r: 0 };
  fixture = { ...pair, spawn, sourceZone: zoneAt(spawn),
    targetZone: zoneAt({ x: pair.boundary + 1, z: spawn.z }), now: NOW };
}

function memberships() {
  const members = [];
  const names = new Set(h.records.routes.filter(r => r.binding === 'ZONE').map(r => r.name));
  for (const name of names) {
    const instance = h.env.ZONE.object(name).instance;
    for (const socket of instance.sockets()) {
      const player = instance.player(socket);
      if (player?.uid !== UID || !instance.activePlayer(player)) continue;
      members.push({ zone: instance.currentZoneId(), id: player.id, x: player.x, y: player.y, z: player.z,
        motion: plain(player.motion), pending: Boolean(player.handoffPending), provisional: Boolean(player.handoffResume) });
    }
  }
  const row = h.room().sessions.row(UID);
  const snapshot = { now: h.now(), members, owner: row?.owner || null,
    checkpoint: row ? { x: row.x, y: row.y, z: row.z, r: row.r, id: row.player_id,
      revision: row.checkpoint_revision, leaseExpires: row.lease_expires } : null };
  membershipHistory.push(snapshot);
  return snapshot;
}

function drain() {
  const events = [];
  for (const [id, entry] of sockets) {
    for (const message of entry.connection.messages()) events.push({ id, kind: 'message', message });
    entry.connection.clear();
    if (entry.connection.client.closed && !entry.closeDelivered) {
      entry.closeDelivered = true;
      events.push({ id, kind: 'close', code: entry.connection.client.closeInfo?.code || 1006 });
    }
  }
  return events;
}

async function command(value) {
  if (value.now !== undefined) await h.setTime(value.now);
  let result = {};
  if (value.op === 'open') {
    const parsed = new URL(value.url);
    if (parsed.origin !== ORIGIN.replace('https:', 'wss:') || parsed.pathname !== '/play' ||
        !parsed.searchParams.has('zone') || parsed.searchParams.has('server')) throw Error('Transport escaped isolated Free zone fixture');
    const connection = await h.open(parsed.pathname + parsed.search);
    const id = sockets.size + 1;
    sockets.set(id, { connection, closeDelivered: false });
    result.id = id;
  } else if (value.op === 'send') {
    const connection = sockets.get(value.id)?.connection;
    if (!connection) throw Error('Unknown local zone socket');
    if (!connection.client.closed) {
      const packet = value.packet;
      if (packet.type === 'auth') {
        if (packet.token !== 'synthetic-staging-zone-browser-token') throw Error('Wrong synthetic SDK identity');
        packet.token = h.token(UID);
      }
      await connection.send(packet);
      if (packet.type === 'auth' && !packet.handoffToken && !firstPlaced) {
        firstPlaced = true;
        // Trusted initial fixture remains eight units before the real coin.
        // All boundary travel thereafter uses normal browser/server physics.
        h.place(connection, fixture.spawn);
        for (let i = 0; i < connection.client.inbox.length; i++) {
          const message = JSON.parse(connection.client.inbox[i]);
          if (message.type !== 'welcome') continue;
          message.spawn = fixture.spawn;
          connection.client.inbox[i] = JSON.stringify(message);
        }
      }
    }
  } else if (value.op === 'close') {
    const connection = sockets.get(value.id)?.connection;
    if (connection && !connection.client.closed) {
      connection.client.close(value.code || 1000, 'Offline browser transport closed');
      await connection.instance.webSocketClose(connection.server, value.code || 1000, 'Offline browser transport closed', true);
      await h.settle();
    }
  } else if (value.op === 'state') {
    result.score = h.room().economy.score(UID);
    result.coins = plain(h.room().coinSnapshot());
    result.membershipHistory = membershipHistory;
    result.socketCount = sockets.size;
    result.unexpectedFetches = h.records.fetches.filter(f => !f.url.startsWith('https://www.googleapis.com/robot/v1/metadata/x509/'));
  } else if (value.op !== 'advance') throw Error('Unknown offline zone transport operation');
  result.events = drain();
  result.membership = memberships();
  return result;
}

async function main() {
  if (process.argv.includes('--build')) {
    await writeOutput(await buildStagingClient(PUBLIC, { allowTest: true }));
    return;
  }
  await initialize();
  await writeOutput(JSON.stringify({ ready: true, fixture }) + '\n');
  let chain = Promise.resolve();
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    chain = chain.then(async () => {
      try { await writeOutput(JSON.stringify({ ok: true, result: await command(JSON.parse(line)) }) + '\n'); }
      catch (error) { await writeOutput(JSON.stringify({ ok: false, error: error.message }) + '\n'); }
    });
  });
  input.on('close', () => { chain.then(() => h.close()).catch(() => { process.exitCode = 1; }); });
}
main().catch(error => { process.stderr.write(`FAIL offline staging zone bridge: ${error.message}\n`); process.exitCode = 1; });
