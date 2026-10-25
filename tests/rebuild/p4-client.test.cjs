'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const { pathToFileURL } = require('node:url');
const { createHarness } = require('./harness.cjs');

const source = fragment => fs.readFileSync(path.resolve(__dirname, '../../src/client', fragment), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const loadShared = name => import(pathToFileURL(path.resolve(__dirname, '../../src/shared', `${name}.mjs`)).href);

async function fixture(options = {}) {
  const [protocol, catalog, config, movement] = await Promise.all(
    ['protocol', 'catalog', 'config', 'movement'].map(loadShared));
  let localNow = options.now ?? 1_900_000_000_000, offset = options.offset ?? 0;
  const sent = [], timers = [], frames = [], elements = new Map(), transport = [];
  let rewardSounds = 0, writes = 0;
  const mesh = () => ({ visible: false, position: { x: 0, y: 0, z: 0,
    set(x, y, z) { Object.assign(this, { x, y, z }); } }, rotation: { z: 0 } });
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { innerText: '', innerHTML: '', style: {},
        classList: { add: value => classes.add(value), remove: value => classes.delete(value),
          contains: value => classes.has(value) } });
    }
    return elements.get(id);
  };
  class ClockDate extends Date { static now() { return localNow; } }
  const context = vm.createContext({ protocol, catalog, config, movement, Date: ClockDate,
    console: { warn() {} }, WebSocket: { OPEN: 1 },
    auth: { currentUser: { uid: options.uid ?? 'synthetic-p4-client' } },
    state: { score: 17, wheelSpinning: false, wheelReward: null, isPlaying: true,
      isPaused: false, shop: { speedBuffExpires: 0 } },
    secureGameReady: true, secureHandoffInProgress: false,
    secureGameSocket: { readyState: 1, send(raw) {
      if (options.transportFailure) throw Error('Synthetic transport failure');
      const packet = JSON.parse(raw);
      sent.push(packet);
      if (options.send) transport.push(options.send(packet));
    } },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
    requestAnimationFrame: fn => frames.push(fn), performance: { now: () => localNow },
    secureNow: () => localNow + offset,
    secureSetServerNow: serverNow => { offset = Number(serverNow) - localNow; },
    document: { getElementById: element }, updateScoreDisplay() {},
    scene: { add() {}, remove() {} }, createTreasureChest: mesh,
    luckyBox: null, luckyBoxServerRef: null,
    coins: Array.from({ length: 200 }, (_, serverId) => ({ serverId, baseY: .75,
      active: false, respawnTime: 0, mesh: mesh(), rotSpeed: 1 })),
    playerPos: { x: 999, y: 7, z: 999, distanceTo: () => Infinity }, playerRotation: 1000,
    audio: { playBoxHit() {}, playWheelTick() {}, playReward() { rewardSounds++; } },
    drawLuckyWheel() {}, WHEEL_ITEMS: catalog.WHEEL_ITEMS, currentWheelAngle: 0,
    localStorage: { setItem() { writes++; }, removeItem() { writes++; } },
    alert() {}
  });
  // Real authored handlers run in one classic lexical environment. The fixture
  // supplies browser transport, clock and DOM ports, not replacement economy.
  for (const name of ['secure-snapshots.js', 'secure-socket-handoff.js', 'secure-menu-economy.js'])
    vm.runInContext(source(name), context, { filename: name });
  const startup = source('secure-wheel-startup.js');
  const animator = acorn.parse(startup, { ecmaVersion: 'latest' }).body
    .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'secureAnimateWheelToReward');
  vm.runInContext(startup.slice(animator.start, animator.end), context, { filename: 'secure-wheel-startup.js' });
  return { context, sent, timers, frames, element, mesh,
    now: () => localNow, serverNow: () => localNow + offset,
    advance(ms) { localNow += ms; }, setOffset(value) { offset = value; },
    rewardSounds: () => rewardSounds, writes: () => writes,
    async flush() { await Promise.all(transport.splice(0)); },
    runTimers(delay) { for (const timer of timers.splice(0)) if (timer.delay === delay) timer.fn(); },
    snapshot(cycle = 0, extra = {}) {
      context.secureApplyLuckyBoxState({ x: 20, z: 30, cycle, active: true,
        claimed: false, claimExpiresAt: 0, nextSpawnAt: 0, ...extra }, localNow + offset);
    }
  };
}

test('P4 client coin retry keeps one request ID through a lost ACK and never authors position or score', async () => {
  const f = await fixture(), coin = f.context.coins[0];
  f.context.secureUpdateCoinState({ id: 0, cycle: 0, x: 10, z: 20, respawnAt: 0, serverNow: f.serverNow() });
  f.context.collectCoin(coin);
  const first = f.sent[0];
  assert.deepEqual(Object.keys(first).sort(), ['id', 'requestId', 'type']);
  assert.equal(first.type, 'collect'); assert.equal(first.id, 0);
  assert.match(first.requestId, /^coin:/); assert.ok(first.requestId.length <= 128);
  assert.equal(f.context.state.score, 17);
  f.context.collectCoin(coin);
  assert.equal(f.sent.length, 1, 'An in-flight visual contact cannot duplicate the action');
  f.advance(2700); f.runTimers(2700); f.context.collectCoin(coin);
  assert.equal(f.sent[1].requestId, first.requestId, 'A timeout retries the original durable action');
  f.context.secureUpdateCoinState({ id: 0, cycle: 1, x: 11, z: 21, respawnAt: 0 });
  f.context.collectCoin(coin);
  assert.notEqual(f.sent[2].requestId, first.requestId, 'A confirmed new resource cycle starts a new action');
  assert.equal(f.context.state.score, 17);
});

test('P4 client request IDs change when the authenticated account changes', async () => {
  const f = await fixture(), coin = f.context.coins[1];
  coin.active = true; f.context.collectCoin(coin);
  f.advance(2700); f.runTimers(2700);
  f.context.auth.currentUser = { uid: 'synthetic-p4-other-account' };
  f.context.collectCoin(coin);
  assert.notEqual(f.sent[0].requestId, f.sent[1].requestId);
  assert.equal(f.context.state.score, 17);
});

test('P4 client coin events suppress stale cycles and publish the same global cooldown to every peer', async () => {
  const first = await fixture(), second = await fixture();
  for (const f of [first, second]) {
    f.context.secureUpdateCoinState({ id: 2, cycle: 2, x: 10, z: 20,
      respawnAt: f.serverNow() + 60_000, serverNow: f.serverNow() });
    assert.equal(f.context.coins[2].active, false);
    assert.equal(f.context.coins[2].mesh.visible, false);
    f.context.secureUpdateCoinState({ id: 2, cycle: 1, x: 999, z: 999, respawnAt: 0 });
    assert.equal(f.context.coins[2].serverCycle, 2);
    assert.equal(f.context.coins[2].mesh.position.x, 10);
    assert.equal(f.context.coins[2].active, false);
  }
  assert.equal(first.context.coins[2].respawnTime, second.context.coins[2].respawnTime);
});

test('P4 client full snapshot keeps 200 resources, retains same-cycle retry identity and rejects older snapshots', async () => {
  const f = await fixture({ offset: -86_400_000 });
  const coins = Array.from({ length: 200 }, (_, id) => ({ id, x: id, z: -id,
    cycle: 2, respawnAt: id === 0 ? f.serverNow() + 60_000 : 0 }));
  f.context.secureApplyCoinSnapshot(coins, f.serverNow());
  assert.equal(f.context.coins.length, 200);
  assert.equal(f.context.coins.filter(coin => coin.active).length, 199);
  const coin = f.context.coins[1];
  f.context.collectCoin(coin); const requestId = f.sent[0].requestId;
  f.context.secureApplyCoinSnapshot(coins, f.serverNow());
  assert.equal(coin._collectActionRequestId, requestId);
  f.context.secureApplyCoinSnapshot([{ id: 1, cycle: 1, x: 999, z: 999, respawnAt: 0 }], f.serverNow());
  assert.equal(coin.serverCycle, 2); assert.equal(coin.mesh.position.x, 1);
  assert.equal(coin._collectActionRequestId, requestId);
  assert.equal(f.context.coins[2].active, false, 'Missing resources remain absent from a full snapshot');
});

test('P4 client a delayed older coin receipt cannot clear a new pending contact or regress score', async () => {
  const f = await fixture(), coin = f.context.coins[0];
  coin.active = true; f.context.collectCoin(coin);
  const previous = f.sent[0].requestId;
  f.context.secureUpdateCoinState({ id: 0, cycle: 1, x: 0, z: 0, respawnAt: 0 });
  f.context.collectCoin(coin); const current = f.sent[1].requestId;
  const pendingUntil = coin._collectPendingUntil;
  f.context.secureHandleSocketMessage({ type: 'coin_collect_result', id: 0,
    requestId: previous, collected: true, score: 1, event: { id: 0, cycle: 0, respawnAt: 0 } });
  assert.equal(coin._collectPendingUntil, pendingUntil);
  assert.equal(coin._collectActionRequestId, current);
  assert.equal(f.context.state.score, 17);
  f.context.secureHandleSocketMessage({ type: 'score', score: 3 });
  assert.equal(f.context.state.score, 17, 'Delayed authoritative totals cannot roll back a newer total');
  f.context.secureHandleSocketMessage({ type: 'score', score: 18 });
  assert.equal(f.context.state.score, 18);
});

test('P4 client definitive rejected contact starts a new action once the authoritative server position reaches the coin', async t => {
  const h = createHarness(); t.after(() => h.close());
  const uid = 'synthetic-p4-client-contact-retry';
  const connection = await h.connect({ uid });
  const f = await fixture({ now: h.now(), uid, send: packet => connection.send(packet) });
  f.context.state.score = 0;
  f.context.secureApplyCoinSnapshot(h.room().coinSnapshot(), h.now());
  const remote = h.room().coinSnapshot().find(coin =>
    Math.hypot(coin.x - connection.attachment().x, coin.z - connection.attachment().z) > 10);
  const coin = f.context.coins[remote.id];
  f.context.collectCoin(coin); await f.flush();
  const firstId = f.sent[0].requestId;
  const rejected = connection.messages('coin_state').at(-1);
  assert.equal(rejected.requestId, firstId);
  f.context.secureHandleSocketMessage(rejected);
  assert.equal(coin._collectActionRequestId, null);
  assert.equal(coin.active, true);
  assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, 0);
  h.place(connection, { x: remote.x, y: 0, z: remote.z, r: 0 });
  await h.advance(200); f.advance(200);
  f.context.collectCoin(coin); await f.flush();
  assert.notEqual(f.sent[1].requestId, firstId);
  const awarded = connection.messages('score').at(-1);
  f.context.secureHandleSocketMessage(awarded);
  assert.equal(f.context.state.score, 1);
  assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, 1);
});

test('P4 client stale coin denial cannot clear a newer pending request or revive an advanced cycle', async () => {
  const f = await fixture(), coin = f.context.coins[0]; coin.active = true;
  f.context.collectCoin(coin); const oldId = f.sent[0].requestId;
  f.context.secureUpdateCoinState({ id: 0, cycle: 1, x: 5, z: 5, respawnAt: 0 });
  f.context.collectCoin(coin); const newId = f.sent[1].requestId;
  const pending = coin._collectPendingUntil;
  f.context.secureHandleSocketMessage({ type: 'coin_state', id: 0, cycle: 0,
    respawnAt: 0, requestId: oldId });
  assert.equal(coin._collectActionRequestId, newId);
  assert.equal(coin._collectPendingUntil, pending);
  assert.equal(coin.active, false);
  assert.equal(coin.serverCycle, 1);
});

test('P4 client Lucky Box stays hidden without an authoritative spawn, including after countdown and claim expiry', async () => {
  const f = await fixture();
  f.context.spawnLuckyBoxes(); f.context.secureUpdateLuckyBoxTimer();
  assert.equal(f.context.luckyBox.active, false);
  f.snapshot(0, { active: false, nextSpawnAt: f.serverNow() + 4 * 60 * 60_000 });
  assert.equal(f.element('hud-box-timer').innerText, '04:00:00');
  f.advance(4 * 60 * 60_000); f.context.secureUpdateLuckyBoxTimer();
  assert.equal(f.context.luckyBox.active, false, 'A device timer cannot create a new server spawn');
  f.snapshot(1); assert.equal(f.context.luckyBox.active, true);
  f.snapshot(1, { active: false, claimed: true, claimExpiresAt: f.serverNow() + 90_000 });
  f.advance(90_000); f.context.secureUpdateLuckyBoxTimer();
  assert.equal(f.context.luckyBox.active, false, 'Only the server releases an expired claim');
  f.snapshot(1); assert.equal(f.context.luckyBox.active, true);
});

test('P4 client Lucky Box ignores an older cycle without moving its authoritative position', async () => {
  const f = await fixture();
  f.snapshot(3, { active: false, nextSpawnAt: f.serverNow() + 60_000 });
  f.snapshot(2, { x: 999, z: 999 });
  assert.equal(f.context.luckyBox.spawnCycle, 3);
  assert.equal(f.context.luckyBox.mesh.position.x, 20);
  assert.equal(f.context.luckyBox.active, false);
});

test('P4/P8 client claim expiry retains collection cooldown and only a new authoritative cycle permits another claim', async () => {
  const f = await fixture(); f.snapshot(0);
  f.context.secureRequestLuckyBoxCollect(); const oldId = f.sent[0].requestId;
  const collectedAt = f.serverNow(), nextSpawnAt = collectedAt + 4 * 60 * 60_000;
  f.snapshot(1, { active: false, claimed: true, claimExpiresAt: collectedAt + 90_000, nextSpawnAt });
  assert.equal(f.element('hud-box-timer').innerText, '04:00:00');
  f.advance(90_000);
  f.snapshot(1, { active: false, nextSpawnAt });
  f.context.secureRequestLuckyBoxCollect();
  assert.equal(f.sent.length, 1, 'an expired spin claim cannot bypass the global cooldown');
  assert.equal(f.element('hud-box-timer').innerText, '03:58:30');
  f.advance(4 * 60 * 60_000 - 90_000);
  f.context.secureUpdateLuckyBoxTimer();
  f.context.secureRequestLuckyBoxCollect();
  assert.equal(f.sent.length, 1, 'the device timer cannot create an authoritative spawn');
  f.snapshot(1, { nextSpawnAt });
  f.context.secureRequestLuckyBoxCollect();
  assert.notEqual(f.sent[1].requestId, oldId);
  assert.equal(f.context.luckyBox.spawnCycle, 1);
});

test('P4 client identified claim denial clears only its completed action, while unknown timeout keeps its ID', async () => {
  const f = await fixture(); f.snapshot(0);
  f.context.secureRequestLuckyBoxCollect(); const oldId = f.sent[0].requestId;
  f.context.secureHandleSocketMessage({ type: 'box_state', requestId: oldId, claimed: false,
    box: { cycle: 0, x: 20, z: 30, active: true, claimed: false, claimExpiresAt: 0, nextSpawnAt: 0 } });
  f.context.secureRequestLuckyBoxCollect();
  assert.notEqual(f.sent[1].requestId, oldId);
  const currentId = f.sent[1].requestId;
  f.context.secureHandleSocketMessage({ type: 'box_state', requestId: oldId, claimed: false,
    box: { cycle: 0, x: 20, z: 30, active: true, claimed: false, claimExpiresAt: 0, nextSpawnAt: 0 } });
  assert.equal(f.context.luckyBox._claimActionRequestId, currentId);
  f.advance(1200); f.runTimers(1200); f.context.secureRequestLuckyBoxCollect();
  assert.equal(f.sent.at(-1).requestId, currentId);
});

test('P4 client Lucky Box claim and spin each retain distinct IDs across transport retries', async () => {
  const f = await fixture(); f.snapshot(0);
  f.context.secureRequestLuckyBoxCollect(); const claim = f.sent[0];
  f.context.secureRequestLuckyBoxCollect(); assert.equal(f.sent.length, 1);
  f.advance(1200); f.runTimers(1200); f.context.secureRequestLuckyBoxCollect();
  assert.equal(f.sent[1].requestId, claim.requestId);
  f.context.spinWheel(); const spin = f.sent[2];
  assert.equal(spin.type, 'spin_box'); assert.notEqual(spin.requestId, claim.requestId);
  f.context.spinWheel(); assert.equal(f.sent.length, 3);
  f.advance(2700); f.runTimers(2700); f.context.spinWheel();
  assert.equal(f.sent[3].requestId, spin.requestId);
  assert.equal(f.context.state.score, 17);
});

test('P4 client Lucky Box confirmed new cycle creates a new claim and spin action', async () => {
  const f = await fixture(); f.snapshot(0);
  f.context.secureRequestLuckyBoxCollect(); f.context.spinWheel();
  const firstClaim = f.sent[0].requestId, firstSpin = f.sent[1].requestId;
  f.context.state.wheelSpinning = false; f.snapshot(1);
  f.context.secureRequestLuckyBoxCollect(); f.context.spinWheel();
  assert.notEqual(f.sent[2].requestId, firstClaim);
  assert.notEqual(f.sent[3].requestId, firstSpin);
});

test('P4 client Lucky Box transport or server failure exposes a retry without granting score', async () => {
  const transport = await fixture({ transportFailure: true }); transport.snapshot(0);
  transport.context.secureRequestLuckyBoxCollect();
  assert.equal(transport.context.luckyBox.collecting, false);
  transport.context.spinWheel();
  assert.equal(transport.context.state.wheelSpinning, false);
  assert.equal(transport.element('btn-spin-wheel').classList.contains('hidden'), false);
  assert.equal(transport.context.state.score, 17);
  const f = await fixture(); f.snapshot(0); f.context.spinWheel();
  const requestId = f.sent[0].requestId;
  f.context.secureHandleSocketMessage({ type: 'box_error', requestId, message: 'Storage unavailable' });
  assert.equal(f.context.state.wheelSpinning, false);
  f.context.spinWheel(); assert.equal(f.sent[1].requestId, requestId);
  assert.equal(f.context.state.score, 17);
});

test('P4 client one authoritative Lucky Box receipt animates once and preserves its returned total', async () => {
  const f = await fixture(); f.snapshot(0); f.context.spinWheel();
  const requestId = f.sent[0].requestId;
  const reward = { type: 'box_reward', requestId, receipt: 'synthetic-p4-receipt', reward: 100, score: 117 };
  f.context.secureHandleSocketMessage(reward);
  assert.equal(f.frames.length, 1); assert.equal(f.context.state.score, 117);
  f.advance(2700); f.runTimers(2700);
  assert.equal(f.context.state.wheelSpinning, true, 'A received result cannot be retried during its animation');
  f.context.secureHandleSocketMessage({ ...reward, replayed: true });
  assert.equal(f.frames.length, 1, 'The same persisted receipt cannot start a second visual reward');
  f.advance(1300); f.frames.shift()(f.now());
  assert.equal(f.context.state.wheelSpinning, false);
  assert.equal(f.rewardSounds(), 1);
  assert.equal(f.context.state.score, 117, 'The animation never adds the reward locally');
  assert.match(f.element('wheel-result-msg').innerHTML, /100/);
});

test('P4 client delayed spin results cannot replace the current cycle animation or lower its score', async () => {
  const f = await fixture(); f.snapshot(0); f.context.secureRequestLuckyBoxCollect(); f.context.spinWheel();
  const oldSpin = f.sent[1].requestId;
  f.context.state.wheelSpinning = false; f.snapshot(1);
  f.context.secureRequestLuckyBoxCollect(); f.context.spinWheel();
  const current = f.context.luckyBox._spinPendingRequestId;
  f.context.secureHandleSocketMessage({ type: 'box_reward', requestId: oldSpin,
    receipt: 'synthetic-old-receipt', reward: 100, score: 10 });
  assert.equal(f.frames.length, 0);
  assert.equal(f.context.luckyBox._spinPendingRequestId, current);
  assert.equal(f.context.state.score, 17);
});

test('P4 client blocked/disconnected/handoff economy emits no mutation requests', async () => {
  const f = await fixture(); f.snapshot(0); const coin = f.context.coins[0]; coin.active = true;
  for (const key of ['secureGameReady', 'secureHandoffInProgress']) {
    f.context[key] = key === 'secureHandoffInProgress';
    f.context.collectCoin(coin); f.context.secureRequestLuckyBoxCollect(); f.context.spinWheel();
    f.context[key] = key !== 'secureHandoffInProgress';
  }
  f.context.secureGameSocket.readyState = 3;
  f.context.collectCoin(coin); f.context.secureRequestLuckyBoxCollect(); f.context.spinWheel();
  assert.equal(f.sent.length, 0); assert.equal(f.context.state.score, 17);
});

test('P4 client coin cooldown rendering uses server time even when device time is one day ahead', async () => {
  const f = await fixture({ offset: -86_400_000 }), coin = f.context.coins[0];
  f.context.secureUpdateCoinState({ id: 0, cycle: 1, x: 1, z: 2,
    respawnAt: f.serverNow() + 60_000, serverNow: f.serverNow() });
  const loop = acorn.parse(source('wheel-frame.js'), { ecmaVersion: 'latest' }).body
    .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'gameLoop');
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' &&
        node.expression.callee.type === 'MemberExpression' && node.expression.callee.object.name === 'coins' &&
        node.expression.callee.property.name === 'forEach') return node;
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) { for (const item of child) { const found = walk(item); if (found) return found; } }
      else if (child && typeof child === 'object') { const found = walk(child); if (found) return found; }
    }
  };
  const actualCoins = walk(loop); assert.ok(actualCoins);
  const execute = () => {
    f.context.nowMs = f.now(); f.context.delta = .05;
    vm.runInContext(source('wheel-frame.js').slice(actualCoins.start, actualCoins.end), f.context);
  };
  execute(); assert.equal(coin.active, false);
  f.advance(59_999); execute(); assert.equal(coin.active, false);
  f.advance(1); execute(); assert.equal(coin.active, true);
  assert.equal(f.context.state.score, 17);
});

test('P4 client legacy score mutation entrypoints remain blocked', async () => {
  const f = await fixture(), authored = source('secure-entitlements-payment.js');
  const statements = acorn.parse(authored, { ecmaVersion: 'latest' }).body.filter(node =>
    node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' &&
    ['addScore', 'resetHighScore'].includes(node.expression.left.name));
  assert.equal(statements.length, 2);
  for (const statement of statements) vm.runInContext(authored.slice(statement.start, statement.end), f.context);
  f.context.addScore(999999); f.context.resetHighScore();
  assert.equal(f.context.state.score, 17); assert.equal(f.writes(), 0);
});
