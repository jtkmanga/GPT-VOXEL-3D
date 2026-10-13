'use strict';

// Offline transport only: this executes the actual bundled Worker, RSA verifier,
// SQLite, ZoneRoom and GameRoom. No Cloudflare account or deployed URL is used.
const fs = require('node:fs');
const readline = require('node:readline');
const { createHarness } = require('./harness.cjs');
const { buildStagingClient } = require('../../scripts/rebuild/build-staging-client.cjs');
const ORIGIN = 'https://gpt-voxel-3d-staging-gameplay-fixture.invalid';
const PROJECT = 'voxel-staging-gameplay-fixture';
const PUBLIC = { environment: 'staging', workerName: 'gpt-voxel-3d-staging-gameplay-fixture', workerOrigin: ORIGIN,
  firebase: { apiKey: 'synthetic-public-staging-key', authDomain: `${PROJECT}.firebaseapp.com`,
    projectId: PROJECT, appId: '1:123456789:web:abcdef1234567890' }, authMode: 'popup' };
const NOW = 1_900_000_000_000;
const PLAYER = 'synthetic-staging-gameplay-player';
const sockets = new Map();
let h, fixture, observer;
const zone = p => `${Math.floor((p.x + 750) / 150)},${Math.floor((p.z + 750) / 150)}`;
const plain = value => JSON.parse(JSON.stringify(value));

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
  const coin = coins.find(c => zone({ x: c.x - 12, z: c.z }) === zone(c) &&
    zone({ x: c.x + 24, z: c.z }) === zone(c) && Math.abs(c.x) < 700 && Math.abs(c.z) < 700 &&
    !obstacles.some(o => c.z > o.minZ - 2 && c.z < o.maxZ + 2 && c.x + 20 > o.minX - 2 && c.x - 8 < o.maxX + 2) &&
    !coins.some(other => other.id !== c.id && Math.abs(other.z - c.z) < 5 && other.x > c.x - 12 && other.x < c.x + 24));
  if (!coin) throw Error('No unobstructed actual server coin trajectory');
  fixture = { coin: plain(coin), spawn: { x: coin.x - 8, y: 0, z: coin.z, r: 0 }, zone: zone(coin), now: NOW };
  observer = await h.connect({ uid: 'synthetic-staging-gameplay-observer', zone: fixture.zone });
  h.place(observer, { x: coin.x, y: 0, z: coin.z + 3, r: 0 });
}

function drain() {
  const packets = [];
  for (const [id, connection] of sockets) {
    for (const message of connection.messages()) packets.push({ id, message });
    connection.clear();
  }
  return packets;
}

async function command(value) {
  if (value.now !== undefined) await h.setTime(value.now);
  if (value.op === 'open') {
    const parsed = new URL(value.url);
    if (parsed.origin !== ORIGIN.replace('https:', 'wss:') || parsed.pathname !== '/play' ||
        parsed.searchParams.get('zone') !== fixture.zone || parsed.searchParams.has('server')) throw Error('Transport escaped staging Free fixture');
    const connection = await h.open(parsed.pathname + parsed.search);
    const id = sockets.size + 1;
    sockets.set(id, connection);
    return { id, fixture, packets: drain() };
  }
  if (value.op === 'send') {
    const connection = sockets.get(value.id);
    if (!connection) throw Error('Unknown local socket');
    const packet = value.packet;
    if (packet.type === 'auth') {
      if (packet.token !== 'synthetic-staging-gameplay-browser-token') throw Error('Wrong synthetic SDK identity');
      packet.token = h.token(PLAYER);
    }
    await connection.send(packet);
    if (packet.type === 'auth') {
      // Trusted initial server fixture only. Normal browser controls and the
      // actual server kernel must cover the full eight-unit pickup approach.
      h.place(connection, fixture.spawn);
      for (let i = 0; i < connection.client.inbox.length; i++) {
        const message = JSON.parse(connection.client.inbox[i]);
        if (message.type !== 'welcome') continue;
        message.spawn = fixture.spawn;
        connection.client.inbox[i] = JSON.stringify(message);
      }
    }
    return { packets: drain() };
  }
  if (value.op === 'advance') return { packets: drain() };
  if (value.op === 'snapshotObserver') {
    const late = await h.connect({ uid: 'synthetic-staging-gameplay-late-observer', zone: fixture.zone });
    return { welcome: late.messages('welcome').at(-1), packets: drain() };
  }
  if (value.op === 'state') {
    const connection = [...sockets.values()][0];
    return { now: h.now(), player: plain(connection.attachment()), score: h.room().economy.score(PLAYER),
      coins: plain(h.room().coinSnapshot()), observer: observer.messages(),
      closed: connection.client.closed, routes: h.records.routes.map(r => ({ binding: r.binding, name: r.name })),
      unexpectedFetches: h.records.fetches.filter(f => !f.url.startsWith('https://www.googleapis.com/robot/v1/metadata/x509/')) };
  }
  if (value.op === 'close') { await h.close(); return { closed: true }; }
  throw Error('Unknown offline bridge operation');
}

async function main() {
  if (process.argv.includes('--build')) {
    fs.writeSync(1, await buildStagingClient(PUBLIC, { allowTest: true }));
    return;
  }
  await initialize();
  fs.writeSync(1, JSON.stringify({ ready: true, fixture }) + '\n');
  let chain = Promise.resolve();
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', line => {
    chain = chain.then(async () => {
      try { fs.writeSync(1, JSON.stringify({ ok: true, result: await command(JSON.parse(line)) }) + '\n'); }
      catch (error) { fs.writeSync(1, JSON.stringify({ ok: false, error: error.message }) + '\n'); }
    });
  });
  input.on('close', () => { chain.then(() => h.close()).catch(() => { process.exitCode = 1; }); });
}
main().catch(error => { fs.writeSync(2, `FAIL offline staging gameplay bridge initialization: ${error.message}\n`); process.exitCode = 1; });
