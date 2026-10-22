'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHarness } = require('./harness.cjs');
const config = require('../../src/shared/config.mjs');
const protocol = require('../../src/shared/protocol.mjs');
const movement = require('../../src/shared/movement.mjs');
const { SERVER_WORLD } = require('../../src/worker/world.mjs');

const source = name => fs.readFileSync(path.resolve(__dirname, '../../src/client', name), 'utf8');
const last = (socket, type) => socket.messages(type).at(-1);
const zoneAt = p => `${Math.floor((p.x + 750) / 150)},${Math.floor((p.z + 750) / 150)}`;
function stagingHarness() {
  const projectId = 'rebuild-coin-staging-fixture';
  const workerOrigin = 'https://gpt-voxel-3d-staging-coin-fixture.invalid';
  return createHarness({ workerOrigin, defaultTokenProject: projectId,
    env: { APP_ENV: 'staging', STAGING_WORKER_NAME: 'gpt-voxel-3d-staging-coin-fixture',
      STAGING_WORKER_ORIGIN: workerOrigin, ALLOWED_ORIGIN: workerOrigin,
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_PUBLIC_CONFIG: JSON.stringify({ apiKey: 'synthetic-public-staging-key',
        projectId, authDomain: `${projectId}.firebaseapp.com`, appId: '1:123456:web:abcdef123456' }),
      FIREBASE_APP_CHECK_SITE_KEY: '6L' + 'A'.repeat(38),
      FIREBASE_ONLINE_USER_CHECK: 'false',
      STAGING_AUTH_MODE: 'popup', PAYMENT_MODE: 'provider-neutral-test' } });
}

function vector(x = 0, y = 0, z = 0) {
  return { x, y, z, set(x, y, z) { Object.assign(this, { x, y, z }); },
    copy(p) { this.set(p.x, p.y, p.z); },
    distanceTo(p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z); } };
}

// Run the actual authored browser movement, packet emitters, snapshot and
// pickup handlers. Ports supply only DOM, time and ordered local transport.
function browser(h, connection, { staging = true, flushResult } = {}) {
  const sent = [], pending = [], timers = [], elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { innerText: '', src: '', disabled: false,
      classList: { add() {}, remove() {} }, style: {} });
    return elements.get(id);
  }
  class ClockDate extends Date { static now() { return h.now(); } }
  const socket = { readyState: 1, send(raw) {
    const packet = JSON.parse(raw);
    sent.push(packet);
    if (connection) pending.push(connection.send(packet));
  } };
  const context = vm.createContext({ config, protocol, movement, Date: ClockDate,
    WebSocket: { OPEN: 1 }, console: { warn() {} },
    crypto: { randomUUID: () => `synthetic-coin-${sent.length}` },
    auth: { currentUser: { uid: connection?.attachment().uid || 'synthetic-coin-browser' } },
    state: { isPlaying: true, isPaused: false, score: 0, selectedServerId: 'free1',
      serverPlayerId: connection?.attachment().id || 'synthetic-player', shop: { speedBuffExpires: 0 } },
    playerPos: vector(), playerVel: vector(), playerVelocityY: 0, playerRotation: 0,
    isGrounded: true, playerGroup: null, keys: {}, joystickVec: { x: 0, y: 0 }, cameraYaw: 0,
    buildings: SERVER_WORLD.buildings, trees: SERVER_WORLD.trees,
    coins: Array.from({ length: 200 }, (_, serverId) => ({ serverId, baseY: 1.2,
      active: false, respawnTime: 0, mesh: { visible: false, position: vector(), rotation: { z: 0 } } })),
    luckyBox: null, scene: { add() {}, remove() {} },
    createTreasureChest: () => ({ visible: false, position: vector() }),
    secureGameSocket: socket, secureGameReady: true, secureHandoffInProgress: false,
    secureCurrentZoneId: connection?.attachment().zoneId || '5,4', secureLastMoveSentAt: 0,
    secureLastStablePosition: null, secureHandoffResumeTimer: null,
    secureHandoffResumeResolve: null, secureHandoffResumeReject: null,
    secureNow: () => h.now(), secureSetServerNow() {},
    SECURE_ZONE_GRID_SIZE: 10, SECURE_ZONE_SIZE: 150, MAP_SIZE: 1500,
    secureIntentionalSockets: new WeakSet(), secureRemoteSources: new Map(), secureGhostMembersByZone: new Map(),
    otherPlayers: {}, addOtherPlayer() {}, updateOtherPlayer() {}, removeOtherPlayer() {}, removeAllOtherPlayers() {},
    updateScoreDisplay() {}, updateLeaderboardUI() {},
    document: { hidden: false, getElementById: element, addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
    requestAnimationFrame(fn) { fn(); },
    STAGING_CLIENT_ENABLED: true, STAGING_PUBLIC_CONFIG: { authMode: 'popup' },
    startGame: async () => true, googleProvider: {}, alert() {}
  });
  for (const name of ['secure-snapshots.js', 'secure-socket-handoff.js', 'secure-menu-economy.js'])
    vm.runInContext(source(name), context, { filename: name });
  if (staging) vm.runInContext(source('staging-runtime.js'), context, { filename: 'staging-runtime.js' });
  if (flushResult !== undefined) context.secureFlushMovementForPickup = () => flushResult;
  if (connection) connection.client.addEventListener('message', event => {
    context.secureHandleSocketMessage(JSON.parse(event.data));
  });
  return { context, sent, timers, async settle() { await Promise.all(pending.splice(0)); },
    reset(p) { context.secureResetPrediction(p, { ...p.motion, lastSeq: p.motion?.seq ?? -1 }); },
    snapshot(coins) { context.secureApplyCoinSnapshot(coins, h.now()); } };
}

test('staging normal walking contact flushes prediction before pickup between 200 ms movement ticks', async t => {
  const h = stagingHarness(); t.after(() => h.close());
  const room = h.room(), coin = room.coinSnapshot()[56];
  const player = await h.connect({ uid: 'synthetic-staging-walking-coin', zone: zoneAt(coin) });
  const observer = await h.connect({ uid: 'synthetic-staging-coin-observer', zone: zoneAt(coin) });
  // Only the initial trusted setup is placed. Contact is reached with actual
  // browser input frames and the actual authoritative WebSocket handlers.
  h.place(player, { x: coin.x - 8, y: 0, z: coin.z, r: 0 });
  const f = browser(h, player), other = browser(h, observer);
  f.reset(player.attachment()); other.reset(observer.attachment());
  f.snapshot(room.coinSnapshot()); other.snapshot(room.coinSnapshot());
  assert.equal(f.context.coins.length, 200);
  assert.equal(f.context.coins[coin.id].serverId, coin.id);
  assert.equal(f.context.coins[coin.id].mesh.position.x, coin.x);
  assert.equal(f.context.coins[coin.id].mesh.position.z, coin.z);
  f.context.keys.d = true;
  let pickupAt, sentBeforePickup;
  for (let frame = 0; frame < 100; frame++) {
    await h.advance(1000 / 60);
    f.context.securePredictMovement(1 / 60);
    f.context.syncMyPlayerData();
    await f.settle();
    if (f.context.playerPos.distanceTo(f.context.coins[coin.id].mesh.position) < 2.2) {
      assert.ok(h.now() - f.context.secureLastMoveSentAt < 200,
        'contact falls before the next regular movement transmission');
      sentBeforePickup = f.sent.length;
      pickupAt = h.now();
      f.context.collectCoin(f.context.coins[coin.id]);
      await f.settle();
      break;
    }
  }
  assert.ok(pickupAt, 'normal input reaches the rendered authoritative coin');
  assert.deepEqual(f.sent.slice(sentBeforePickup).map(packet => packet.type), ['move', 'collect']);
  assert.ok(f.sent[sentBeforePickup].frames.length > 0, 'contact flushes the unsent actual prediction frames');
  const collect = f.sent.at(-1);
  assert.deepEqual(Object.keys(collect).sort(), ['id', 'requestId', 'type']);
  assert.equal(last(player, 'coin_collect_result').collected, true);
  assert.equal(room.economy.score(player.attachment().uid), 1);
  assert.equal(f.context.state.score, 1);
  assert.equal(f.context.coins[coin.id].active, false);
  assert.equal(other.context.coins[coin.id].active, false, 'authoritative event removes the coin for every observer');
  assert.equal(other.context.coins[coin.id].mesh.visible, false);
  assert.equal(room.coinSnapshot()[coin.id].respawnAt, pickupAt + 60_000);
  assert.equal(room.coinSnapshot().length, 200);
  await h.advance(150);
  await player.send(collect);
  assert.equal(room.economy.score(player.attachment().uid), 1, 'same successful action cannot award twice');
  await h.advance(59_849);
  const cooldown = room.coinSnapshot()[coin.id];
  assert.ok(cooldown.respawnAt > h.now());
  other.snapshot(room.coinSnapshot());
  assert.equal(other.context.coins[coin.id].active, false);
  await h.advance(1);
  other.snapshot(room.coinSnapshot());
  assert.equal(other.context.coins[coin.id].active, true, 'the server-owned cooldown ends exactly after 60 seconds');
  assert.equal(room.coinSnapshot().length, 200);
});

for (const zone of [undefined, '5,4']) {
  test(`coin throttle acknowledges and bounds retries in actual ${zone ? 'ZoneRoom' : 'GameRoom'}`, async t => {
    const h = stagingHarness(); t.after(() => h.close());
    const player = await h.connect({ uid: `synthetic-staging-coin-throttle-${zone || 'room'}`, zone });
    const coin = h.room().coinSnapshot().find(c => Math.hypot(c.x - player.attachment().x, c.z - player.attachment().z) > 10);
    const f = browser(h, player, { staging: false });
    f.snapshot(h.room().coinSnapshot());
    f.context.collectCoin(f.context.coins[coin.id]); await f.settle();
    const first = last(player, zone ? 'coin_collect_result' : 'coin_state');
    assert.equal(first.retryAfterMs, 150);
    assert.equal(f.context.coins[coin.id].active, true);
    assert.equal(f.context.coins[coin.id].mesh.visible, true, 'a denial promptly restores authoritative visibility');
    const sent = f.sent.length;
    await h.advance(16);
    f.context.collectCoin(f.context.coins[coin.id]); await f.settle();
    assert.equal(f.sent.length, sent, 'the next animation frame respects authoritative backoff');
    const before = player.messages(zone ? 'coin_collect_result' : 'coin_state').length;
    await player.send({ type: 'collect', id: coin.id, requestId: 'synthetic-direct-throttled-retry' });
    assert.equal(player.messages(zone ? 'coin_collect_result' : 'coin_state').length, before + 1,
      'the server never leaves a throttled contact waiting for a lost acknowledgement');
    assert.equal(last(player, zone ? 'coin_collect_result' : 'coin_state').retryAfterMs, 134);
    assert.equal(h.room().economy.score(player.attachment().uid), 0);
    assert.equal(h.room().coinSnapshot()[coin.id].respawnAt, 0);
    assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_economy_actions').toArray()[0].n, 0);
  });
}

test('pickup aborts when the ordered staging movement flush cannot reach authority', () => {
  const h = { now: () => 1_900_000_000_000 };
  const f = browser(h, null, { staging: false, flushResult: false }), coin = f.context.coins[0];
  coin.active = coin.mesh.visible = true;
  f.context.collectCoin(coin);
  assert.equal(f.sent.length, 0);
  assert.equal(coin.active, true);
  assert.equal(coin.mesh.visible, true);
  assert.equal(f.context.state.score, 0);
});

test('coin retry metadata is bounded and cannot erase a known authoritative cooldown', () => {
  const h = { now: () => 1_900_000_000_000 };
  const f = browser(h, null, { staging: false }), coin = f.context.coins[0];
  coin.active = coin.mesh.visible = false;
  coin.respawnTime = h.now() + 60_000;
  f.context.secureHandleSocketMessage({ type: 'coin_collect_result', id: 0, collected: false,
    retryAfterMs: 1_000_000, serverNow: h.now() });
  assert.equal(coin._collectRetryAt, h.now() + 150);
  assert.equal(coin.respawnTime, h.now() + 60_000);
  assert.equal(coin.active, false);
});

test('concurrent authoritative pickup awards once and rejects client-position spoofing', async t => {
  const h = stagingHarness(); t.after(() => h.close());
  const coin = h.room().coinSnapshot()[56];
  const first = await h.connect({ uid: 'synthetic-staging-coin-race-first', zone: zoneAt(coin) });
  const second = await h.connect({ uid: 'synthetic-staging-coin-race-second', zone: zoneAt(coin) });
  const remote = await h.connect({ uid: 'synthetic-staging-coin-remote', zone: zoneAt(coin) });
  h.place(remote, { x: coin.x - 20, y: 0, z: coin.z, r: 0 });
  await remote.send({ type: 'collect', id: coin.id, x: coin.x, y: 0, z: coin.z, r: 0,
    requestId: 'synthetic-untrusted-contact' });
  assert.equal(h.room().economy.score(remote.attachment().uid), 0);
  assert.equal(h.room().coinSnapshot()[coin.id].respawnAt, 0);
  for (const socket of [first, second]) {
    h.place(socket, { x: coin.x - 8, y: 0, z: coin.z, r: 0 });
  }
  const browsers = [browser(h, first), browser(h, second)];
  for (const [index, f] of browsers.entries()) {
    f.reset([first, second][index].attachment()); f.snapshot(h.room().coinSnapshot());
    f.context.keys.d = true;
  }
  let contact = false;
  for (let frame = 0; frame < 100; frame++) {
    await h.advance(1000 / 60);
    for (const f of browsers) { f.context.securePredictMovement(1 / 60); f.context.syncMyPlayerData(); }
    await Promise.all(browsers.map(f => f.settle()));
    if (browsers.every(f => f.context.playerPos.distanceTo(f.context.coins[coin.id].mesh.position) < 2.2)) {
      contact = true;
      for (const f of browsers) f.context.collectCoin(f.context.coins[coin.id]);
      await Promise.all(browsers.map(f => f.settle()));
      break;
    }
  }
  assert.equal(contact, true);
  assert.equal(h.room().economy.score(first.attachment().uid) + h.room().economy.score(second.attachment().uid), 1);
  assert.equal(h.room().sql.exec("SELECT COUNT(*) AS n FROM voxel_economy_actions WHERE kind='coin' AND awarded=1").toArray()[0].n, 1);
  for (const f of browsers) {
    assert.equal(f.context.coins[coin.id].active, false);
    assert.equal(f.context.coins[coin.id].mesh.visible, false);
  }
  assert.equal(h.room().coinSnapshot().length, 200);
});
