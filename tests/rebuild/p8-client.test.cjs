'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const THREE = require('three');
const { createHarness } = require('./harness.cjs');
const protocol = require('../../src/shared/protocol.mjs');
const config = require('../../src/shared/config.mjs');
const catalog = require('../../src/shared/catalog.mjs');
const movement = require('../../src/shared/movement.mjs');
const source = name => fs.readFileSync(path.resolve(__dirname, '../../src/client', name), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const FOUR_HOURS = 14_400_000;

function declarations(file, names) {
  const text = source(file), ast = acorn.parse(text, { ecmaVersion: 'latest' });
  return names.map(name => {
    const node = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
    assert.ok(node, `Actual client function ${name} exists`); return text.slice(node.start, node.end);
  }).join('\n');
}

function fixture(options = {}) {
  let localNow = options.now ?? 1_900_000_000_000, writes = 0;
  let monotonicNow = localNow;
  const elements = new Map(), sent = [], transport = [], frames = [], timers = [], bodyChildren = [];
  const mesh = () => { const object = new THREE.Object3D(); object.visible = false; return object; };
  function element() {
    const classes = new Set(), label = { innerText: '' };
    return { style: {}, innerText: '', innerHTML: '',
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      querySelector(selector) { assert.equal(selector, 'span'); return label; }, label };
  }
  function getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }
  const body = { appendChild(child) { bodyChildren.push(child); child.parentNode = body; },
    removeChild(child) { bodyChildren.splice(bodyChildren.indexOf(child), 1); child.parentNode = null; } };
  const socket = { readyState: 1, secureServerId: 'free1', send(raw) {
    const packet = JSON.parse(raw); sent.push(packet);
    if (options.send) transport.push(options.send(packet));
  }, close() { this.readyState = 3; } };
  class ClockDate extends Date { static now() { return localNow; } }
  const context = vm.createContext({ protocol, config, catalog, movement, THREE, Date: ClockDate,
    WebSocket: { OPEN: 1 }, console: { warn() {}, error() {} },
    auth: { currentUser: { uid: options.uid ?? 'synthetic-p8-client', async getIdToken() { return 'synthetic-p8-client-token'; } } },
    state: { isPlaying: true, isPaused: false, score: 0, playerName: 'Player', selectedServerId: 'free1',
      userVipSubscriptions: {}, vipServers: { vip1: { count: 0, max: 100 } }, shop: { speedBuffExpires: 0, coinBuffExpires: 0 } },
    document: { getElementById, createElement: element, body },
    scene: new THREE.Scene(), createTreasureChest: mesh, otherPlayers: {},
    coins: Array.from({ length: 200 }, (_, id) => ({ serverId: id, baseY: .75, active: false, respawnTime: 0, mesh: mesh() })),
    playerPos: new THREE.Vector3(), playerVel: { x: 0, z: 0 }, playerVelocityY: 0, playerRotation: 0,
    isGrounded: true, playerGroup: null, MAP_SIZE: 1500, luckyBox: null, luckyBoxServerRef: null,
    keys: {}, joystickVec: { x: 0, y: 0 }, cameraYaw: 0,
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {}, clearInterval() {},
    requestAnimationFrame: fn => frames.push(fn), performance: { now: () => monotonicNow },
    updateShopUI() {}, renderServersUI() {}, updateScoreDisplay() {}, updateLeaderboardUI() {},
    audio: { playBoxHit() {}, playWheelTick() {}, playReward() {} }, drawLuckyWheel() {},
    WHEEL_ITEMS: catalog.WHEEL_ITEMS, currentWheelAngle: 0,
    localStorage: { removeItem() { writes++; }, setItem() { writes++; } },
    fetch() { throw Error('Unexpected external I/O'); }, alert() {}, __socket: socket
  });
  for (const file of ['secure-entitlements-payment.js', 'secure-snapshots.js', 'secure-socket-handoff.js', 'secure-menu-economy.js'])
    vm.runInContext(source(file), context, { filename: file });
  vm.runInContext(declarations('firebase-multiplayer.js', ['addOtherPlayer', 'updateOtherPlayer', 'removeOtherPlayer',
    'removeAllOtherPlayers', 'escapeHtml']), context);
  vm.runInContext(declarations('secure-wheel-startup.js', ['secureAnimateWheelToReward']), context);
  vm.runInContext('secureGameSocket = __socket; secureGameReady = true;', context);
  const evaluate = expression => vm.runInContext(expression, context);
  return { context, socket, sent, frames, timers, bodyChildren, element: getElementById,
    writes: () => writes, now: () => localNow, serverNow: () => context.secureNow(),
    advance(ms) { localNow += ms; monotonicNow += ms; },
    jumpWallClock(ms) { localNow += ms; }, evaluate,
    async flush() { await Promise.all(transport.splice(0)); },
    applyBox(box, serverNow = context.secureNow()) { context.secureHandleSocketMessage({ type: 'box_state', box, serverNow }); }
  };
}

test('P8 Lucky Box cooldown cannot be erased, extended or clock-bypassed by same-cycle stale snapshots', () => {
  const f = fixture(), deadline = f.serverNow() + FOUR_HOURS;
  const authoritative = { cycle: 5, x: 20, z: 30, nextSpawnAt: deadline, active: false, claimed: false };
  f.applyBox(authoritative); assert.equal(f.element('hud-box-timer').innerText, '04:00:00');
  for (const incoming of [0, deadline - 1, deadline + FOUR_HOURS]) {
    f.applyBox({ ...authoritative, x: 999, z: 999, active: true, nextSpawnAt: incoming }, deadline + FOUR_HOURS);
    assert.equal(f.context.luckyBox.nextSpawnTimestamp, deadline);
    assert.equal(f.context.luckyBox.mesh.position.x, 20); assert.equal(f.context.luckyBox.active, false);
    assert.equal(f.element('hud-box-timer').innerText, '04:00:00');
    assert.equal(f.serverNow(), f.now(), 'Rejected packet time cannot bypass an already known cooldown');
  }
  f.advance(FOUR_HOURS); f.context.secureUpdateLuckyBoxTimer();
  assert.equal(f.context.luckyBox.active, false, 'The clock alone never spawns a reward');
  f.applyBox({ ...authoritative, active: true });
  assert.equal(f.context.luckyBox.active, true, 'Trusted same-cycle activation at the deadline is permitted');
  assert.equal(f.element('hud-box-timer').innerText, 'พร้อมเปิด!');
  f.applyBox({ ...authoritative, cycle: 6, x: 40, nextSpawnAt: f.serverNow() + FOUR_HOURS, active: false });
  assert.equal(f.context.luckyBox.spawnCycle, 6); assert.equal(f.context.luckyBox.mesh.position.x, 40);
  assert.equal(f.context.luckyBox.active, false);
});

test('P8 Lucky Box snapshot permits current server activation when the local synchronized clock is slightly behind', () => {
  const f = fixture(), deadline = f.serverNow() + FOUR_HOURS;
  f.applyBox({ cycle: 1, x: 20, z: 30, active: false, claimed: false, nextSpawnAt: deadline });
  f.advance(FOUR_HOURS - 500);
  f.applyBox({ cycle: 1, x: 25, z: 35, active: true, claimed: false, nextSpawnAt: deadline }, deadline);
  assert.equal(f.context.luckyBox.active, true); assert.equal(f.serverNow(), deadline);
  assert.equal(f.context.luckyBox.mesh.position.x, 25);
});

test('P8 actual collected Lucky Box countdown remains global across device skew, reconnect and room restart', async t => {
  const h = createHarness(); t.after(() => h.close());
  let player = await h.connect({ uid: 'synthetic-p8-client-restart' });
  const before = clone(h.room().boxSnapshot()); h.place(player, { x: before.x, y: 0, z: before.z, r: 0 });
  await player.send({ type: 'collect_box', requestId: 'p8-client-collected-global' });
  const collected = clone(player.messages('box_state').at(-1).box), serverNow = h.now();
  assert.equal(collected.nextSpawnAt, serverNow + FOUR_HOURS);
  const clients = [fixture({ now: serverNow - 86_400_000 }), fixture({ now: serverNow + 86_400_000 })];
  for (const client of clients) {
    client.applyBox(collected, serverNow); assert.equal(client.element('hud-box-timer').innerText, '04:00:00');
    client.applyBox(before, serverNow + 1000);
    assert.equal(client.context.luckyBox.spawnCycle, collected.cycle); assert.equal(client.context.luckyBox.active, false);
    assert.equal(client.element('hud-box-timer').innerText, '04:00:00');
  }
  await player.close(); await h.advance(20_000); h.restartRoom(); await h.room().ready;
  player = await h.connect({ uid: 'synthetic-p8-client-restart' });
  const restored = player.messages('welcome').at(-1).luckyBox;
  const reconnect = fixture({ now: h.now() + 86_400_000 }); reconnect.applyBox(restored, h.now());
  assert.equal(reconnect.element('hud-box-timer').innerText, '03:59:40');
  assert.equal(reconnect.context.luckyBox.nextSpawnTimestamp, collected.nextSpawnAt);
  assert.equal(reconnect.context.luckyBox.active, false);
  for (const client of clients) {
    client.advance(20_000); client.applyBox(restored, h.now());
    assert.equal(client.element('hud-box-timer').innerText, reconnect.element('hud-box-timer').innerText);
  }
});

test('P8 actual authoritative coin snapshot survives restart and stale packets cannot revive a collected coin', async t => {
  const h = createHarness(); t.after(() => h.close());
  let player = await h.connect({ uid: 'synthetic-p8-client-coin-restart' });
  const original = clone(h.room().coinSnapshot());
  h.place(player, { x: original[0].x, y: 0, z: original[0].z, r: 0 });
  await player.send({ type: 'collect', id: 0, requestId: 'p8-client-coin-restart' });
  const event = clone(player.messages('coin_collected').at(-1));
  assert.equal(event.respawnAt, h.now() + 60_000);
  await player.close(); await h.advance(10_000); h.restartRoom(); await h.room().ready;
  player = await h.connect({ uid: 'synthetic-p8-client-coin-restart' });
  const current = clone(player.messages('welcome').at(-1).coins), f = fixture({ now: h.now() });
  f.context.secureApplyCoinSnapshot(current, h.now()); f.context.secureApplyCoinSnapshot(original, h.now() - 10_000);
  f.context.secureHandleSocketMessage({ ...event, cycle: event.cycle - 1, respawnAt: 0 });
  assert.equal(f.context.coins.length, 200); assert.equal(f.context.coins[0].active, false);
  assert.equal(f.context.coins[0].serverCycle, event.cycle);
  assert.equal(f.context.coins[0].respawnTime, event.respawnAt);
  assert.equal(f.context.coins[0].mesh.position.x, current[0].x);
  assert.equal(f.element('hud-box-timer').innerText, '', 'Coin state never creates a countdown UI');
});

test('P8 forged local balances, VIP flags and inventory never enter the actual resource request or authoritative saved ledger', async t => {
  const h = createHarness(); t.after(() => h.close());
  const uid = 'synthetic-p8-client-forged-state', player = await h.connect({ uid });
  const f = fixture({ now: h.now(), uid, send: packet => player.send(packet) });
  const snapshot = h.room().coinSnapshot(); h.place(player, { x: snapshot[0].x, y: 0, z: snapshot[0].z, r: 0 });
  f.context.secureApplyCoinSnapshot(snapshot, h.now());
  f.context.state.score = 999999; f.context.state.balance = 999999; f.context.state.inventory = ['admin'];
  f.context.state.userVipSubscriptions = { vip1: { expireTime: Infinity } };
  f.context.collectCoin(f.context.coins[0]); await f.flush();
  assert.deepEqual(Object.keys(f.sent[0]).sort(), ['id', 'requestId', 'type']);
  assert.equal(h.room().economy.score(uid), 1);
  assert.equal(h.room().vip.entitlement(uid).active, false);
  const saved = h.room().sessions.row(uid);
  assert.ok(saved); assert.equal(Object.hasOwn(saved, 'inventory'), false); assert.equal(Object.hasOwn(saved, 'balance'), false);
  const prior = f.context.state.score;
  f.context.addScore(1000000); f.context.resetHighScore(); assert.equal(f.context.grantPurchasedItem(), false);
  assert.equal(f.context.state.score, prior); assert.equal(f.writes(), 0);
});

test('P8 actual remote-name creation/update escapes markup and returning to menu removes every world nameplate', () => {
  const f = fixture(), payload = '<img src=x onerror="window.injected=1"><script>bad()</script>';
  f.context.secureTrackRemotePlayer('synthetic-name', 'local', { id: 'synthetic-name', x: 1, y: 0, z: -5, name: payload });
  const remote = f.context.otherPlayers['synthetic-name']; assert.ok(remote);
  assert.equal(remote.nameTagEl.innerHTML, `<span>${f.context.escapeHtml(payload)}</span>`);
  assert.doesNotMatch(remote.nameTagEl.innerHTML, /<(img|script)\b/i);
  f.context.updateOtherPlayer('synthetic-name', { x: 2, y: 0, z: -4, name: '<svg onload="bad()">' });
  assert.equal(remote.nameTagEl.label.innerText, '<svg onload="bad()">');
  f.element('player-nametag').style.display = 'block';
  f.context.secureReturnToMenu();
  assert.equal(f.bodyChildren.length, 0); assert.deepEqual(Object.keys(f.context.otherPlayers), []);
  assert.equal(f.evaluate('secureRemoteSources.size'), 0); assert.equal(f.socket.readyState, 3);
  assert.equal(f.context.state.isPlaying, false); assert.equal(f.element('player-nametag').classList.contains('hidden'), true);
});

test('P8 global clock rejects older/duplicate server samples and device wall-clock jumps cannot change box cooldown',()=>{
  const f=fixture(), sampled=f.now(), deadline=sampled+FOUR_HOURS;
  f.applyBox({cycle:2,x:10,z:20,nextSpawnAt:deadline,active:false,claimed:false},sampled);
  f.advance(60000); f.context.secureUpdateLuckyBoxTimer();
  assert.equal(f.element('hud-box-timer').innerText,'03:59:00');
  for(const timestamp of [sampled-1,sampled]) {
    f.context.secureSetServerNow(timestamp); f.context.secureUpdateLuckyBoxTimer();
    assert.equal(f.serverNow(),sampled+60000);
    assert.equal(f.element('hud-box-timer').innerText,'03:59:00');
  }
  for(const jump of [86400000,-172800000,86400000]) {
    f.jumpWallClock(jump); f.context.secureUpdateLuckyBoxTimer();
    assert.equal(f.serverNow(),sampled+60000);
    assert.equal(f.element('hud-box-timer').innerText,'03:59:00');
  }
});

test('P8 delayed same-cycle box cooldown cannot hide an already authoritative respawn or restore old position',()=>{
  const f=fixture(), collected=f.now(), deadline=collected+FOUR_HOURS;
  const cooling={cycle:3,x:10,z:20,nextSpawnAt:deadline,active:false,claimed:true,claimExpiresAt:collected+90000};
  f.applyBox(cooling,collected); f.advance(FOUR_HOURS);
  f.applyBox({...cooling,x:30,z:40,active:true,claimed:false,claimExpiresAt:0},deadline);
  assert.equal(f.context.luckyBox.active,true);
  f.applyBox(cooling,collected);
  assert.equal(f.context.luckyBox.active,true);
  assert.equal(f.context.luckyBox.claimed,false);
  assert.equal(f.context.luckyBox.mesh.position.x,30);
  assert.equal(f.context.luckyBox.mesh.position.z,40);
});

test('P8 old full coin snapshot uses the current trusted clock and cannot re-hide a respawned current-cycle coin',()=>{
  const f=fixture(), sampled=f.now();
  const snapshot=[{id:0,cycle:1,x:10,z:20,respawnAt:sampled+60000}];
  f.context.secureApplyCoinSnapshot(snapshot,sampled);
  assert.equal(f.context.coins[0].active,false);
  f.advance(60000); f.context.secureApplyCoinSnapshot(snapshot,sampled+60000);
  assert.equal(f.context.coins[0].active,true);
  f.context.secureApplyCoinSnapshot(snapshot,sampled);
  assert.equal(f.context.coins[0].active,true);
  assert.equal(f.serverNow(),sampled+60000);
});
