'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');
const { stagingClientFixture, imported } = require('./staging-client-fixture.cjs');

const right = { x: 1, z: 0, jump: false };
const idle = { x: 0, z: 0, jump: false };
const frame = (delta, input = right) => ({ input, delta });
const packet = (seq, frames) => ({ type: 'move', seq, input: frames.at(-1).input, frames });
const pose = p => Object.fromEntries(['x', 'y', 'z', 'r'].map(key => [key, p[key]]));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('staging frame schema rejects coordinates, extra fields, malformed intent and unbounded claimed intervals', async () => {
  const { validMovementFrames } = await imported('shared/movement.mjs');
  const { parseFrame } = await imported('worker/security.mjs');
  const valid = [frame(.1), frame(.1), frame(.1), frame(.1), frame(.1)];
  assert.equal(validMovementFrames(valid), true);
  assert.equal(parseFrame(JSON.stringify(packet(0, valid)), {}, 6).ok, true);
  const invalid = [[], Array.from({ length: 65 }, () => frame(0)), [frame(.10001)],
    [frame(-.01)], [frame(NaN)], [frame(Infinity)], [...valid, frame(.001)],
    [{ ...frame(.1), x: 123 }], [{ delta: .1, input: { ...right, speed: 99 } }],
    [{ delta: .1, input: { x: 1, z: 1, jump: false } }], [{ input: right }]];
  for (const frames of invalid) assert.equal(validMovementFrames(frames), false);
  for (const frames of invalid.filter(value => value.length && Number.isFinite(value[0]?.delta))) {
    assert.equal(parseFrame(JSON.stringify(packet(0, frames)), {}, 6).ok, false);
  }
});

test('staging authoritative batches integrate actual ordered input changes with server collision geometry', async () => {
  const { applyMovementIntent, initializeMotion } = await imported('worker/movement.mjs');
  const { integrateMovement } = await imported('shared/movement.mjs');
  const { SERVER_WORLD } = await imported('worker/world.mjs');
  const player = { x: 75, y: 0, z: 75, r: 0, at: 1000, last: 0 };
  initializeMotion(player, 1000);
  const frames = Array.from({ length: 12 }, (_, index) => frame(1 / 60,
    index < 6 ? right : { x: -1, z: 0, jump: false }));
  let expected = { ...player, ...player.motion };
  for (const segment of frames) expected = integrateMovement(expected, segment.input, segment.delta,
    { speed: 22, obstacles: [...SERVER_WORLD.buildings, ...SERVER_WORLD.trees], bounds: 748 });
  assert.equal(applyMovementIntent(player, packet(0, frames), 22, 1200), true);
  assert.deepEqual(pose(player), pose(expected));
  assert.equal(player.motion.vx, expected.vx);
  assert.ok(player.motion.credit >= 0 && player.motion.credit < 1e-9);
  const accepted = structuredClone(player);
  assert.equal(applyMovementIntent(player, packet(0, frames), 22, 1400), false);
  assert.deepEqual(player, accepted, 'replayed sequence cannot spend another interval');
});

test('staging server clock caps backlog, clamps malicious time inflation and prevents mixed-format double spending', async () => {
  const { applyMovementIntent, initializeMotion } = await imported('worker/movement.mjs');
  const player = { x: 75, y: 0, z: 75, r: 0, at: 1000, last: 0 };
  initializeMotion(player, 1000);
  assert.equal(applyMovementIntent(player, packet(0, [frame(.1)]), 22, 2000), true);
  assert.ok(Math.abs(player.motion.credit - .4) < 1e-9, 'long idle time earns at most half a second');
  assert.equal(applyMovementIntent(player, { type: 'move', seq: 1, input: right }, 22, 2200), true);
  assert.equal(player.motion.credit, 0, 'legacy wall-time integration drops the earlier unspent credit');
  const prior = pose(player);
  assert.equal(applyMovementIntent(player, packet(2, [frame(.1)]), 22, 2200), true);
  assert.deepEqual(pose(player), prior, 'switching back at the same server timestamp cannot reuse credit');
  for (let seq = 3; seq < 33; seq++) {
    assert.equal(applyMovementIntent(player, packet(seq, Array.from({ length: 5 }, () => frame(.1))), 22, 2200), true);
  }
  assert.deepEqual(pose(player), prior, 'claimed frame durations never mint simulation time');
  assert.equal(applyMovementIntent(player, packet(33, Array.from({ length: 5 }, () => frame(.1))), 22, 2210), true);
  assert.ok(distance(prior, player) <= 22 * .01 + 1e-8, 'only ten real milliseconds are affordable');
  assert.equal(player.motion.credit, 0);
});

test('staging batches reject backwards and non-finite server clocks without changing position, credit or sequence', async () => {
  const { applyMovementIntent, initializeMotion } = await imported('worker/movement.mjs');
  const player = { x: 75, y: 0, z: 75, r: 0, at: 1000, last: 0 };
  initializeMotion(player, 1000);
  assert.equal(applyMovementIntent(player, packet(0, [frame(.1)]), 22, 1200), true);
  const accepted = structuredClone(player);
  for (const now of [1100, NaN, Infinity, -Infinity]) {
    assert.equal(applyMovementIntent(player, packet(1, [frame(.1)]), 22, now), false);
    assert.deepEqual(player, accepted, 'rejected clock cannot alter any authoritative movement state');
  }
  assert.equal(applyMovementIntent(player, packet(1, [frame(.1)]), 22, 1200), true);
  assert.equal(player.motion.credit, 0, 'only the existing tenth of a second remains affordable');
  const spent = pose(player);
  assert.equal(applyMovementIntent(player, packet(2, [frame(.1)]), 22, 1200), true);
  assert.deepEqual(pose(player), spent, 'a rejected regression cannot duplicate the previously elapsed interval');
});

async function liveFixture(t, serverId = 'free1') {
  const h = createHarness();
  t.after(() => h.close());
  const connection = await h.open(serverId === 'legacy' ? '/play' : '/play?zone=5,5');
  await connection.send({ type: 'auth', token: h.token('synthetic-staging-movement'), protocol: serverId === 'legacy' ? 4 : 6 });
  const welcome = connection.messages('welcome').at(-1);
  assert.ok(welcome, 'actual Worker must authenticate the synthetic session');
  const world = await imported('worker/world.mjs');
  const client = await stagingClientFixture({ now: h.now(), playerId: welcome.id,
    obstacles: [...world.SERVER_WORLD.buildings, ...world.SERVER_WORLD.trees] });
  client.reset(welcome.spawn, welcome.movement);
  return { h, connection, client };
}

async function exerciseTransport(t, { latency = () => 0, turn = false, serverId = 'free1', fps = 60, renderFrames = 180 } = {}) {
  const { h, connection, client } = await liveFixture(t, serverId);
  const inbound = [], outbound = [], corrections = [];
  let sentCount = 0, ackCount = 0, inboundDue = 0;
  for (let renderFrame = 1; renderFrame <= renderFrames; renderFrame++) {
    await h.advance(1000 / fps);
    client.setTime(h.now());
    client.context.keys = turn
      ? { d: renderFrame % 24 < 12, a: renderFrame % 24 >= 12 }
      : { d: true };
    client.context.securePredictMovement(1 / fps);
    client.context.syncMyPlayerData();
    for (const message of client.sent.slice(sentCount)) {
      const delay = latency(message.seq);
      inboundDue = Math.max(inboundDue, h.now() + delay);
      inbound.push({ at: inboundDue, message });
    }
    sentCount = client.sent.length;
    while (inbound[0]?.at <= h.now()) {
      const message = inbound.shift().message;
      await connection.send(message);
      const acks = connection.messages('move');
      for (const ack of acks.slice(ackCount)) outbound.push({ at: h.now() + latency(-1), ack });
      ackCount = acks.length;
    }
    while (outbound[0]?.at <= h.now()) {
      const before = client.state();
      const ack = outbound.shift().ack;
      assert.equal(ack.applied, true, 'valid batches are not dropped by the legacy 200ms interval gate');
      client.context.secureHandleSocketMessage(ack);
      corrections.push(distance(before, client.state()));
    }
  }
  assert.equal(connection.client.closed, false);
  assert.ok(corrections.length >= 8);
  return { corrections, client, connection };
}

test('staging actual client and ZoneRoom preserve rapid per-frame direction changes without hard corrections', async t => {
  const { corrections } = await exerciseTransport(t, { turn: true });
  t.diagnostic(`maximum authoritative correction: ${Math.max(...corrections)} units`);
  assert.ok(Math.max(...corrections) < 1e-6, `ordered prediction must match authority, correction=${Math.max(...corrections)}`);
});

test('staging ordered 250ms network jitter does not double-predict inbound flight time', async t => {
  const { corrections } = await exerciseTransport(t, { latency: seq => seq >= 0 && seq % 3 === 1 ? 250 : 20 });
  t.diagnostic(`maximum authoritative correction: ${Math.max(...corrections)} units`);
  assert.ok(Math.max(...corrections) < 1e-6, `affordable prediction windows must match, correction=${Math.max(...corrections)}`);
});

test('staging ordered 350ms backlog remains server-bounded without repeated teleport corrections', async t => {
  const { corrections } = await exerciseTransport(t, { latency: seq => seq >= 0 && seq % 3 === 1 ? 350 : 20 });
  t.diagnostic(`maximum authoritative correction: ${Math.max(...corrections)} units`);
  assert.ok(Math.max(...corrections) < 4, `bounded backlog corrections cannot trigger hard snaps, correction=${Math.max(...corrections)}`);
});

test('staging actual free GameRoom accepts isolated frame batches and reconciles rapid input changes', async t => {
  const { corrections } = await exerciseTransport(t, { turn: true, serverId: 'legacy' });
  assert.ok(Math.max(...corrections) < 1e-6);
});

test('staging actual 360Hz render batches bypass the legacy cadence without gaining server time', async t => {
  const { corrections, client } = await exerciseTransport(t, { fps: 360, renderFrames: 480 });
  assert.ok(Math.max(...corrections) < 1e-6);
  assert.ok(client.sent.every(message => message.frames.length <= 48 && client.movement.validMovementFrames(message.frames)));
});

test('staging slow render frames never overflow the half-second frame budget', async () => {
  const client = await stagingClientFixture();
  client.reset();
  client.context.keys.d = true;
  for (const delta of [.1, .087, .099, .085, .083, .1, .1, .1, .1, .1, .1]) {
    client.advance(delta * 1000);
    client.context.securePredictMovement(delta);
  }
  client.context.secureFlushMovementForPickup();
  assert.ok(client.sent.length >= 2);
  assert.ok(client.sent.every(message => client.movement.validMovementFrames(message.frames)));
  assert.ok(client.sent.every(message => message.frames.reduce((total, entry) => total + entry.delta, 0) <= .5 + 1e-9));
});

test('staging prediction resets omit stale render time and high-FPS batches stay ordered, bounded and unique', async () => {
  const client = await stagingClientFixture();
  assert.equal(client.reset(), true);
  client.context.keys.d = true;
  client.advance(1000);
  client.context.securePredictMovement(.1);
  assert.equal(client.state().x, 0, 'the first render after reset cannot use a pre-authentication delta');
  for (let index = 0; index < 120; index++) {
    client.advance(1000 / 360);
    client.context.securePredictMovement(1 / 360);
    client.context.syncMyPlayerData();
  }
  client.context.secureFlushMovementForPickup();
  const frames = client.sent.flatMap(message => message.frames);
  assert.equal(frames.length, 121, 'every predicted frame occurs in exactly one sequence batch');
  assert.deepEqual(client.sent.map(message => message.seq), client.sent.map((_, index) => index));
  assert.ok(client.sent.every(message => message.frames.length <= 48 && client.movement.validMovementFrames(message.frames)));
  assert.ok(Math.abs(frames.reduce((total, entry) => total + entry.delta, 0) - 1 / 3) < 1e-9);
  const count = client.sent.length;
  assert.equal(client.context.secureFlushMovementForPickup(), true);
  assert.equal(client.sent.length, count, 'a pickup cannot resend an already sent prediction interval');
  client.reset({ x: 10, y: 0, z: 10, r: 0 }, { lastSeq: 90 });
  client.context.securePredictMovement(.1);
  assert.deepEqual(pose(client.state()), { x: 10, y: 0, z: 10, r: 0 });
  assert.equal(client.context.secureFlushMovementForPickup(), true);
  assert.equal(client.sent.at(-1).seq, 91);
  assert.equal(client.sent.at(-1).frames.reduce((total, entry) => total + entry.delta, 0), 0);
});

for (const serverId of ['legacy', 'free1'])
test(`D015 ${serverId} authority preserves pre-pause frames and delayed ACK cannot erase a fresh jump`, async t => {
  const { h, connection, client } = await liveFixture(t, serverId);
  const c = client.context;
  const fs = require('node:fs'), vm = require('node:vm'), acorn = require('acorn');
  const element = () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {} });
  c.document.getElementById = () => element();
  c.updateShopUI = () => {};
  vm.runInContext(fs.readFileSync('src/client/controls.js', 'utf8'), c);
  c.setupControls();
  const menu = fs.readFileSync('src/client/menu-shop.js', 'utf8');
  for (const node of acorn.parse(menu, { ecmaVersion: 'latest' }).body) {
    if (['openShopModal', 'closeShopModal'].includes(node.id?.name)) vm.runInContext(menu.slice(node.start, node.end), c);
  }
  const predict = async delta => {
    await h.advance(delta * 1000); client.setTime(h.now()); c.securePredictMovement(delta);
  };
  const send = async () => {
    assert.equal(c.syncMyPlayerData(true), true);
    const message = client.sent.at(-1);
    await connection.send(message);
    const ack = connection.messages('move').at(-1);
    assert.equal(ack.ack, message.seq); assert.equal(ack.applied, true);
    assert.ok(distance(ack.player, client.state()) < 1e-6, 'server integrates the same elapsed input frames');
    return ack;
  };
  c.securePredictMovement(0); // Discard pre-session render time.
  c.keys.d = true; c.secureQueueJump();
  await predict(.1);
  const delayed = await send();
  await predict(.1); // Already elapsed but not yet sent when the modal opens.
  const beforePause = client.read('securePendingFrames');
  c.openShopModal();
  assert.equal(c.state.isPaused, true);
  assert.deepEqual(client.read('securePendingFrames'), beforePause);
  await send();
  assert.deepEqual(client.sent.at(-1).input, idle);
  assert.equal(client.sent.at(-1).frames[0].input.jump, true, 'elapsed pre-pause jump is retained');
  c.closeShopModal();
  let latest;
  for (let index = 0; index < 20; index++) {
    await predict(.1); latest = await send();
    assert.ok(client.sent.at(-1).frames.every(entry => !entry.input.jump && entry.input.x === 0 && entry.input.z === 0));
  }
  assert.equal(client.state().grounded, true, 'released jump does not auto-repeat after landing');
  c.secureQueueJump();
  assert.equal(c.secureReconcileMovement(delayed), true);
  assert.equal(client.read('secureJumpIntent'), true, 'old jump ACK must preserve the fresh generation');
  assert.equal(c.secureReconcileMovement(latest), true);
  assert.equal(client.read('secureJumpIntent'), true);
  assert.equal(client.read('securePendingFrames.length'), 0);
  assert.equal(client.read('securePendingInputs.length'), 0);
  await predict(.1);
  const fresh = await send();
  assert.equal(client.sent.at(-1).input.jump, true);
  assert.ok(fresh.player.y > 0, 'authority accepts the new jump after landing');
  assert.equal(c.secureReconcileMovement(fresh), true);
  assert.equal(client.read('secureJumpIntent'), false);
  const finalState = client.state();
  assert.equal(c.secureReconcileMovement(delayed), false);
  assert.deepEqual(client.state(), finalState, 'stale ACK cannot rewind the fresh jump');
  assert.equal(connection.client.closed, false);
});
