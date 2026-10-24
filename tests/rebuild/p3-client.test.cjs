'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const { pathToFileURL } = require('node:url');
const { createHarness } = require('./harness.cjs');

const sourcePath = name => path.resolve(__dirname, '../../src', name);
const imported = name => import(pathToFileURL(sourcePath(name)).href);
const clone = value => JSON.parse(JSON.stringify(value));
const last = (connection, type) => connection.messages(type).at(-1);

async function clientFixture(options = {}) {
  const movement = await imported('shared/movement.mjs');
  const protocol = await imported('shared/protocol.mjs');
  const config = await imported('shared/config.mjs');
  let currentTime = options.now ?? 1_900_000_000_000;
  const sent = [], pendingTransport = [], remoteUpdates = [];
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const playerPos = { x: 0, y: 0, z: 0,
    set(x, y, z) { Object.assign(this, { x, y, z }); },
    copy(other) { this.set(other.x, other.y, other.z); } };
  const otherPlayers = {};
  class LocalWebSocket {}
  LocalWebSocket.OPEN = 1;
  const socket = { readyState: 1, send(raw) {
    const message = JSON.parse(raw);
    sent.push(message);
    if (options.send) pendingTransport.push(options.send(message));
  } };
  const context = vm.createContext({
    movement, protocol, config, Date: ClockDate, WebSocket: LocalWebSocket,
    document: { hidden: false },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame() {},
    console, playerPos, playerVel: { x: 0, z: 0 }, playerVelocityY: 0,
    playerRotation: 0, isGrounded: true, playerGroup: null,
    keys: {}, joystickVec: { x: 0, y: 0 }, cameraYaw: 0,
    buildings: options.obstacles ?? [], trees: [],
    state: { isPlaying: true, isPaused: false, serverPlayerId: options.playerId ?? 'synthetic-local-player',
      score: 0, shop: { speedBuffExpires: 0 }, selectedServerId: 'free1', playerName: 'Synthetic predictor' },
    auth: { currentUser: { uid: 'synthetic-p3-client' } },
    secureGameSocket: socket, secureGameReady: true, secureHandoffInProgress: false,
    secureCurrentZoneId: '5,5', secureLastStablePosition: null, secureLastMoveSentAt: 0,
    secureHandoffResumeTimer: null, secureHandoffResumeResolve: null, secureHandoffResumeReject: null,
    secureNow: () => currentTime, secureSetServerNow() {},
    SECURE_ZONE_GRID_SIZE: 10, SECURE_ZONE_SIZE: 150, MAP_SIZE: 1500,
    secureIntentionalSockets: new WeakSet(), secureRemoteSources: new Map(), secureGhostMembersByZone: new Map(),
    otherPlayers, coins: [],
    addOtherPlayer(id, position) { otherPlayers[id] = position; remoteUpdates.push({ id, position }); },
    updateOtherPlayer(id, position) { remoteUpdates.push({ id, position }); },
    removeOtherPlayer(id) { delete otherPlayers[id]; }, removeAllOtherPlayers() {},
    audio: { playJump() {} }
  });
  // Execute real authored classic fragments, rather than copies of the
  // prediction/reconciliation implementation or source-pattern assertions.
  for (const fragment of ['secure-snapshots.js', 'secure-socket-handoff.js', 'secure-menu-economy.js']) {
    vm.runInContext(fs.readFileSync(sourcePath(`client/${fragment}`), 'utf8'), context, { filename: fragment });
  }
  const controls = fs.readFileSync(sourcePath('client/controls.js'), 'utf8');
  const ast = acorn.parse(controls, { ecmaVersion: 'latest', sourceType: 'script' });
  const jump = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'triggerJump');
  assert.ok(jump, 'the authored jump control must exist');
  vm.runInContext(controls.slice(jump.start, jump.end), context, { filename: 'controls.js' });
  return { context, movement, sent, remoteUpdates,
    read: expression => clone(vm.runInContext(expression, context)),
    setTime(value) { currentTime = value; }, advance(ms) { currentTime += ms; },
    async flush() { await Promise.all(pendingTransport.splice(0)); },
    state: () => clone(context.secureMovementState()),
    reset(position = { x: 0, y: 0, z: 0, r: 0 }, motion = {}) {
      assert.equal(context.secureResetPrediction(position, motion), true);
    }
  };
}

function approximately(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) <= 1e-8, `${message}: ${actual} versus ${expected}`);
}

function sameMovement(actual, expected) {
  for (const key of ['x', 'y', 'z', 'r', 'vx', 'vz', 'vy']) approximately(actual[key], expected[key], key);
  assert.equal(actual.grounded, expected.grounded);
}

async function runtimeClient(t, uid) {
  const h = createHarness();
  t.after(() => h.close());
  const connection = await h.open();
  await connection.send({ type: 'auth', token: h.token(uid), protocol: 4 });
  const welcome = last(connection, 'welcome');
  assert.ok(welcome);
  const fixture = await clientFixture({ now: h.now(), playerId: welcome.id,
    send: packet => connection.send(packet) });
  fixture.reset(welcome.spawn, welcome.movement);
  return { h, connection, fixture };
}

test('P3 client camera-relative four-direction and diagonal intent preserves baseline control semantics', async () => {
  const fixture = await clientFixture();
  for (const [key, x, z] of [['d', 1, 0], ['a', -1, 0], ['s', 0, 1], ['w', 0, -1]]) {
    fixture.context.keys = { [key]: true };
    const input = fixture.context.secureMovementIntent();
    approximately(input.x, x, key);
    approximately(input.z, z, key);
    assert.equal(input.jump, false);
  }
  fixture.context.keys = { w: true, d: true };
  const diagonal = fixture.context.secureMovementIntent();
  approximately(Math.hypot(diagonal.x, diagonal.z), 1, 'diagonal magnitude');
  fixture.context.keys = { w: true };
  fixture.context.cameraYaw = Math.PI / 2;
  const cameraRelative = fixture.context.secureMovementIntent();
  approximately(cameraRelative.x, -1, 'camera-relative x');
  approximately(cameraRelative.z, 0, 'camera-relative z');
  fixture.context.keys = {};
  fixture.context.cameraYaw = 0;
  fixture.context.joystickVec = { x: 0.5, y: 0 };
  // The pinned P2 client multiplies normalized joystick components by inputMag;
  // sub-unit joystick magnitude therefore retains its original squared response.
  approximately(fixture.context.secureMovementIntent().x, 0.25, 'baseline analog response');
});

test('P3 actual client sends intent and sequence only at the preserved 200ms cadence', async () => {
  const fixture = await clientFixture();
  fixture.context.keys.d = true;
  fixture.context.playerPos.set(300, 99, 500);
  fixture.context.playerVel.x = 999;
  fixture.context.syncMyPlayerData();
  assert.equal(fixture.sent.length, 1);
  assert.deepEqual(Object.keys(fixture.sent[0]).sort(), ['input', 'seq', 'type']);
  assert.deepEqual(fixture.sent[0], { type: 'move', input: { x: 1, z: 0, jump: false }, seq: 0 });
  fixture.advance(199);
  fixture.context.syncMyPlayerData();
  assert.equal(fixture.sent.length, 1);
  fixture.advance(1);
  fixture.context.syncMyPlayerData();
  assert.equal(fixture.sent.length, 2);
  assert.equal(fixture.sent[1].seq, 1);
  fixture.context.state.isPaused = true;
  fixture.advance(200);
  fixture.context.syncMyPlayerData();
  assert.deepEqual(fixture.sent.at(-1).input, { x: 0, z: 0, jump: false });
});

test('P3 prediction executes the shared physics kernel and remains bounded during a stalled connection', async () => {
  const fixture = await clientFixture();
  fixture.reset();
  fixture.context.keys.d = true;
  const before = fixture.state();
  const expected = fixture.movement.integrateMovement(before, { x: 1, z: 0, jump: false }, 0.05,
    { speed: 22, obstacles: [], bounds: 748 });
  fixture.context.securePredictMovement(0.05);
  sameMovement(fixture.state(), expected);
  for (let frame = 0; frame < 400; frame++) fixture.context.securePredictMovement(0.016);
  assert.equal(fixture.read('securePendingFrames.length'), 256);
  assert.ok(Math.abs(fixture.state().x) <= 748);
  assert.ok(Number.isFinite(fixture.state().vx));
});

test('P3 real server ACK reconciles position and replays only unacknowledged client prediction', async t => {
  const { h, connection, fixture } = await runtimeClient(t, 'synthetic-p3-client-reconcile');
  fixture.context.keys.d = true;
  for (let frame = 0; frame < 4; frame++) fixture.context.securePredictMovement(0.05);
  await h.advance(200);
  fixture.setTime(h.now());
  fixture.context.syncMyPlayerData(true);
  await fixture.flush();
  const ack = last(connection, 'move');
  assert.equal(ack.ack, 0);
  for (let frame = 0; frame < 2; frame++) fixture.context.securePredictMovement(0.05);
  const pending = fixture.read('securePendingFrames.filter(frame => frame.seq > 0)');
  assert.equal(pending.length, 2);
  let expected = { ...ack.player, ...ack.movement };
  for (const frame of pending) expected = fixture.movement.integrateMovement(expected, frame.input, frame.delta,
    { speed: frame.speed, obstacles: [], bounds: 748 });
  fixture.context.playerPos.x += 0.5;
  fixture.context.secureHandleSocketMessage(ack);
  sameMovement(fixture.state(), expected);
  assert.equal(fixture.read('secureLastAcknowledgedSequence'), 0);
  assert.equal(fixture.read('securePendingFrames.length'), 2);
  assert.equal(fixture.read('securePendingInputs.length'), 0);
  assert.ok(fixture.read('Math.abs(securePredictionCorrection.x)') > 0,
    'small visual smoothing must leave the logical state reconciled to server authority');
});

test('P3 dropped and reordered ACK delivery cannot rewind prediction or replay acknowledged inputs', async t => {
  const { h, connection, fixture } = await runtimeClient(t, 'synthetic-p3-client-reordered');
  fixture.context.keys.w = true;
  const held = [];
  for (let seq = 0; seq < 2; seq++) {
    for (let frame = 0; frame < 4; frame++) fixture.context.securePredictMovement(0.05);
    await h.advance(200);
    fixture.setTime(h.now());
    fixture.context.syncMyPlayerData(true);
    await fixture.flush();
    held.push(last(connection, 'move'));
  }
  fixture.context.secureHandleSocketMessage(held[1]);
  const latest = fixture.state();
  assert.equal(fixture.read('secureLastAcknowledgedSequence'), 1);
  assert.equal(fixture.read('securePendingFrames.length'), 0);
  fixture.context.secureHandleSocketMessage(held[0]);
  assert.deepEqual(fixture.state(), latest);
  assert.equal(fixture.read('secureLastAcknowledgedSequence'), 1);
  assert.equal(fixture.context.secureReconcileMovement({ ...held[1], ack: 999 }), false);
  assert.deepEqual(fixture.state(), latest);
});

test('P3 an actual nearby player movement message cannot reconcile the local player', async t => {
  const { h, connection, fixture } = await runtimeClient(t, 'synthetic-p3-client-local-owner');
  const peer = await h.open();
  await peer.send({ type: 'auth', token: h.token('synthetic-p3-client-peer-owner'), protocol: 4 });
  fixture.context.keys.d = true;
  fixture.context.securePredictMovement(0.05);
  const ownPrediction = fixture.state();
  const pending = fixture.read('securePendingFrames.length');
  await h.advance(200);
  await peer.send({ type: 'move', input: { x: 0, z: 1, jump: false }, seq: 0 });
  const nearbyMessage = connection.messages('move').find(message => message.player.id === peer.attachment().id);
  assert.ok(nearbyMessage, 'nearby movement must arrive from the actual Worker');
  fixture.context.secureHandleSocketMessage(nearbyMessage);
  assert.deepEqual(fixture.state(), ownPrediction);
  assert.equal(fixture.read('securePendingFrames.length'), pending);
  assert.equal(fixture.read('secureLastAcknowledgedSequence'), -1);
  assert.equal(fixture.remoteUpdates.at(-1).id, peer.attachment().id);
});

test('P3 early unapplied ACK retains jump intent until the actual server accepts it', async t => {
  const { h, connection, fixture } = await runtimeClient(t, 'synthetic-p3-client-jump');
  await h.advance(200);
  fixture.setTime(h.now());
  fixture.context.syncMyPlayerData(true);
  await fixture.flush();
  fixture.context.secureHandleSocketMessage(last(connection, 'move'));
  fixture.context.triggerJump();
  assert.equal(fixture.context.playerVelocityY, 16);
  await h.advance(100);
  fixture.setTime(h.now());
  fixture.context.syncMyPlayerData(true);
  await fixture.flush();
  const early = last(connection, 'move');
  assert.equal(early.applied, false);
  fixture.context.secureHandleSocketMessage(early);
  assert.equal(fixture.read('secureJumpIntent'), true);
  await h.advance(100);
  fixture.setTime(h.now());
  fixture.context.syncMyPlayerData(true);
  assert.equal(fixture.sent.at(-1).input.jump, true);
  await fixture.flush();
  const accepted = last(connection, 'move');
  assert.equal(accepted.applied, true);
  assert.ok(accepted.player.y > 0);
  fixture.context.secureHandleSocketMessage(accepted);
  assert.equal(fixture.read('secureJumpIntent'), false);
  assert.equal(fixture.state().grounded, false);
  approximately(fixture.state().y, connection.attachment().y, 'reconciled jump height');
});

test('P3 handoff or lost connection freezes intent/prediction until authority resumes', async () => {
  const fixture = await clientFixture();
  fixture.context.keys.d = true;
  const original = fixture.state();
  fixture.context.secureHandoffInProgress = true;
  fixture.context.securePredictMovement(0.1);
  fixture.context.syncMyPlayerData(true);
  assert.deepEqual(fixture.state(), original);
  assert.equal(fixture.sent.length, 0);
  fixture.context.secureHandoffInProgress = false;
  fixture.context.secureGameSocket.readyState = 3;
  fixture.context.securePredictMovement(0.1);
  fixture.context.syncMyPlayerData(true);
  assert.deepEqual(fixture.state(), original);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.read('securePendingFrames.length'), 0);
});

test('P3 reconnect reset uses authoritative state and clears stale prediction, sequences and jump', async () => {
  const fixture = await clientFixture();
  fixture.context.keys.d = true;
  fixture.context.secureQueueJump();
  fixture.context.securePredictMovement(0.05);
  fixture.context.syncMyPlayerData(true);
  const authoritative = { x: 12, y: 0, z: 18, r: 1 };
  fixture.reset(authoritative, { vx: 0, vz: 0, vy: 0, grounded: true, lastSeq: 17 });
  assert.deepEqual(fixture.state(), { ...authoritative, vx: 0, vz: 0, vy: 0, grounded: true, jumpHeld: false });
  assert.equal(fixture.read('secureInputSequence'), 18);
  assert.equal(fixture.read('secureLastAcknowledgedSequence'), 17);
  assert.equal(fixture.read('securePendingInputs.length + securePendingFrames.length'), 0);
  assert.equal(fixture.read('secureJumpIntent'), false);
  fixture.context.syncMyPlayerData(true);
  assert.equal(fixture.sent.at(-1).seq, 18);
  assert.equal(fixture.sent.at(-1).input.jump, false);
});

async function crossedZone(t, uid) {
  const h = createHarness();
  t.after(() => h.close());
  const source = await h.open('/play?zone=4,4');
  await source.send({ type: 'auth', token: h.token(uid), protocol: 6 });
  h.place(source, { x: -0.1, y: 0, z: -75, r: 0 });
  const attachment = source.attachment();
  attachment.motion = { vx: 0, vz: 0, vy: 0, grounded: true, seq: -1, clock: h.now() };
  source.server.serializeAttachment(attachment);
  const fixture = await clientFixture({ now: h.now(), playerId: attachment.id,
    send: packet => source.send(packet) });
  fixture.context.secureCurrentZoneId = '4,4';
  fixture.reset({ x: -0.1, y: 0, z: -75, r: 0 });
  fixture.context.keys.d = true;
  for (let frame = 0; frame < 4; frame++) fixture.context.securePredictMovement(0.05);
  await h.advance(200);
  fixture.setTime(h.now());
  fixture.context.syncMyPlayerData(true);
  await fixture.flush();
  const change = last(source, 'zone_change');
  assert.equal(change.zone, '5,4');
  assert.ok(change.handoffToken);
  return { h, source, fixture, change };
}

test('P3 actual handoff cancellation restores client state from the server and preserves monotonic intent', async t => {
  const { h, source, fixture } = await crossedZone(t, 'synthetic-p3-client-cancel');
  fixture.context.secureHandoffInProgress = true;
  await source.send({ type: 'handoff_cancel' });
  const cancelled = last(source, 'handoff_cancelled');
  assert.ok(cancelled.position);
  fixture.context.secureHandleSocketMessage(cancelled);
  assert.deepEqual({ x: fixture.state().x, y: fixture.state().y, z: fixture.state().z, r: fixture.state().r },
    cancelled.position);
  assert.equal(fixture.read('securePendingFrames.length + securePendingInputs.length'), 0);
  assert.ok(fixture.read('secureInputSequence') >= 1);
  fixture.context.secureHandoffInProgress = false;
  fixture.context.keys = { a: true };
  await h.advance(200);
  fixture.setTime(h.now());
  fixture.context.syncMyPlayerData(true);
  await fixture.flush();
  assert.ok(fixture.sent.at(-1).seq >= 1);
  assert.ok(source.attachment().x < -0.1);
  assert.equal(h.zone('4,4').count(), 1);
  assert.equal(h.zone('5,4').count(), 0);
});

test('P3 delayed real target ACK cannot revive an expired or absent client handoff waiter', async t => {
  const uid = 'synthetic-p3-client-late-ack';
  const { h, source, fixture, change } = await crossedZone(t, uid);
  const target = await h.open('/play?zone=5,4');
  await target.send({ type: 'auth', token: h.token(uid), protocol: 6, handoffToken: change.handoffToken });
  await target.send({ type: 'handoff_resume', input: { x: 0, z: 0, jump: false }, seq: 1 });
  const delayedAck = last(target, 'handoff_resumed');
  assert.ok(delayedAck);
  assert.equal(source.client.closed, true);
  const prior = fixture.state();
  const sequence = fixture.read('secureInputSequence');
  // Delay only transport delivery of the genuine ACK. The actual server's
  // transfer and ownership transaction already ran without any replacement.
  fixture.context.secureHandoffInProgress = false;
  fixture.context.secureHandleSocketMessage(delayedAck);
  assert.deepEqual(fixture.state(), prior);
  assert.equal(fixture.read('secureInputSequence'), sequence);
  fixture.context.secureHandoffInProgress = true;
  fixture.context.secureHandoffResumeResolve = null;
  fixture.context.secureHandleSocketMessage(delayedAck);
  assert.deepEqual(fixture.state(), prior);
  assert.equal(fixture.read('secureInputSequence'), sequence);
  assert.equal(h.zone('4,4').count(), 0);
  assert.equal(h.zone('5,4').count(), 1);
});

test('P3 client collection contains only resource and idempotency identifiers and never mutates score', async () => {
  const fixture = await clientFixture();
  const coin = { serverId: 3, active: true, mesh: { visible: true }, position: { x: 999, y: 0, z: 999 } };
  fixture.context.state.score = 7;
  fixture.context.collectCoin(coin);
  assert.deepEqual(Object.keys(fixture.sent[0]).sort(), ['id', 'requestId', 'type']);
  assert.equal(fixture.sent[0].type, 'collect');
  assert.equal(fixture.sent[0].id, 3);
  assert.match(fixture.sent[0].requestId, /^coin:[^\s\x00-\x1f\x7f]+$/);
  assert.ok(fixture.sent[0].requestId.length <= 128);
  assert.equal(coin._collectActionRequestId, fixture.sent[0].requestId);
  assert.equal(fixture.context.state.score, 7);
  assert.equal(coin.active, false);
  fixture.context.collectCoin(coin);
  assert.equal(fixture.sent.length, 1, 'pending collection retries cannot emit duplicate requests');
});
