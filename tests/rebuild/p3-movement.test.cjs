'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createHarness } = require('./harness.cjs');

// These tests execute the actual bundled Worker, real RSA verification and
// SQLite ownership store. Time and WebSocket delivery remain local fixtures.
const moduleURL = name => pathToFileURL(path.resolve(__dirname, '../../src', name)).href;
const kernel = () => import(moduleURL('shared/movement.mjs'));
const world = () => import(moduleURL('worker/world.mjs'));
const last = (connection, type) => connection.messages(type).at(-1);
const position = player => ({ x: player.x, y: player.y, z: player.z, r: player.r });
const planarDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const idle = () => ({ x: 0, z: 0, jump: false });

function harness(t) {
  const h = createHarness();
  t.after(() => h.close());
  return h;
}

async function authenticate(h, { uid = 'synthetic-p3-player', zone, ...authFields } = {}) {
  const connection = await h.open(zone ? `/play?zone=${encodeURIComponent(zone)}` : '/play');
  await connection.send({ type: 'auth', token: h.token(uid), protocol: zone ? 6 : 4, ...authFields });
  assert.equal(connection.client.closed, false, 'synthetic Firebase identity must authenticate');
  assert.ok(last(connection, 'welcome'));
  return connection;
}

function place(h, connection, value) {
  // Trusted server setup lets tests begin near map borders/actual obstacles.
  // No accepted client message can set any of these authoritative fields.
  h.place(connection, value);
  const player = connection.attachment();
  player.motion = { vx: 0, vz: 0, vy: 0, grounded: player.y === 0, seq: -1, clock: h.now() };
  connection.server.serializeAttachment(player);
}

async function move(h, connection, input, seq, elapsed = 200) {
  await h.advance(elapsed);
  await connection.send({ type: 'move', input, seq });
  return last(connection, 'move');
}

function assertSelfAck(connection, message, seq) {
  assert.ok(message, 'a valid accepted intent returns an authoritative self ACK');
  assert.equal(message.ack, seq);
  assert.equal(message.player.id, connection.attachment().id);
  for (const coordinate of ['x', 'y', 'z', 'r']) {
    assert.equal(message.player[coordinate], connection.attachment()[coordinate]);
    assert.ok(Number.isFinite(message.player[coordinate]));
  }
  for (const axis of ['x', 'y', 'z']) assert.ok(Number.isFinite(message.velocity[axis]));
  assert.equal(typeof message.grounded, 'boolean');
  assert.ok(Number.isFinite(message.serverNow));
}

async function rejectWithoutMutation(h, connection, frame) {
  const before = position(connection.attachment());
  const coins = h.room().coinSnapshot();
  const score = connection.attachment().score;
  for (let attempt = 0; attempt < 3 && !connection.client.closed; attempt++) await connection.send(frame);
  assert.equal(connection.client.closed, true, 'invalid authority/schema must fail closed');
  assert.deepEqual(position(connection.attachment()), before);
  assert.equal(connection.attachment().score, score);
  assert.deepEqual(h.room().coinSnapshot(), coins);
}

test('P3 all four directions are computed on the server and return reconciliation ACKs', async t => {
  const h = harness(t);
  for (const [name, input, axis, sign] of [
    ['east', { x: 1, z: 0, jump: false }, 'x', 1],
    ['west', { x: -1, z: 0, jump: false }, 'x', -1],
    ['south', { x: 0, z: 1, jump: false }, 'z', 1],
    ['north', { x: 0, z: -1, jump: false }, 'z', -1]
  ]) {
    const connection = await authenticate(h, { uid: `synthetic-p3-${name}` });
    place(h, connection, { x: 0, y: 0, z: 0, r: 0 });
    const ack = await move(h, connection, input, 0);
    assertSelfAck(connection, ack, 0);
    const p = connection.attachment();
    assert.ok(p[axis] * sign > 0, `${name} input must move in its requested direction`);
    assert.ok(Math.hypot(p.x, p.z) <= 22 * 0.2 + 1e-9, 'server elapsed time bounds speed');
    assert.equal(p[axis === 'x' ? 'z' : 'x'], 0);
    await connection.close();
  }
});

test('P3 idle is stable, analog input scales motion and diagonal movement cannot exceed speed', async t => {
  const h = harness(t);
  const idlePlayer = await authenticate(h, { uid: 'synthetic-p3-idle' });
  place(h, idlePlayer, { x: 0, y: 0, z: 0, r: 0 });
  assertSelfAck(idlePlayer, await move(h, idlePlayer, idle(), 0), 0);
  assert.deepEqual(position(idlePlayer.attachment()), { x: 0, y: 0, z: 0, r: 0 });
  const distances = [];
  for (const [index, input] of [{ x: 0.5, z: 0, jump: false }, { x: 1, z: 0, jump: false },
    { x: Math.SQRT1_2, z: Math.SQRT1_2, jump: false }].entries()) {
    const connection = await authenticate(h, { uid: `synthetic-p3-input-scale-${index}` });
    place(h, connection, { x: 0, y: 0, z: 0, r: 0 });
    for (let seq = 0; seq < 5; seq++) assertSelfAck(connection, await move(h, connection, input, seq), seq);
    distances.push(Math.hypot(connection.attachment().x, connection.attachment().z));
    assert.ok(distances.at(-1) <= 22 + 1e-8);
  }
  assert.ok(distances[0] > 0 && distances[0] < distances[1], 'analog input must retain useful speed control');
  assert.ok(Math.abs(distances[1] - distances[2]) < 1e-8, 'diagonal normalization preserves the same planar speed');
});

test('P3 jumping uses server gravity and cannot multiply jump velocity in mid-air', async t => {
  const h = harness(t);
  const connection = await authenticate(h, { uid: 'synthetic-p3-jump' });
  place(h, connection, { x: 0, y: 0, z: 0, r: 0 });
  const first = await move(h, connection, { x: 0, z: 0, jump: true }, 0);
  assertSelfAck(connection, first, 0);
  assert.ok(first.player.y > 0);
  assert.equal(first.grounded, false);
  const next = await move(h, connection, { x: 0, z: 0, jump: true }, 1);
  assert.ok(next.velocity.y < first.velocity.y, 'another mid-air jump cannot reset upward velocity');
  for (let seq = 2; seq < 8; seq++) await move(h, connection, idle(), seq);
  assert.equal(connection.attachment().y, 0);
  assert.equal(last(connection, 'move').grounded, true);
  assert.equal(last(connection, 'move').velocity.y, 0);
});

test('P3 doubled movement speed comes only from refreshed authoritative entitlement', async t => {
  const h = harness(t);
  const uid = 'synthetic-p3-server-speed';
  const connection = await authenticate(h, { uid, zone: '4,4' });
  const start = { x: -75, y: 0, z: -75, r: 0 };
  place(h, connection, start);
  for (let seq = 0; seq < 3; seq++) await move(h, connection, { x: 1, z: 0, jump: false }, seq);
  const normalDistance = planarDistance(start, connection.attachment());
  h.setSlipResult({ code: '200000', data: { amount: 10, transRef: 'synthetic-p3-speed-transaction' } });
  const form = new FormData();
  form.append('item', 'speed');
  form.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'synthetic.png', { type: 'image/png' }));
  const payment = await h.request('/verify-slip', { method: 'POST',
    headers: { Authorization: `Bearer ${h.token(uid)}` }, body: form });
  assert.equal(payment.status, 200);
  const entitlement = await payment.json();
  await connection.send({ type: 'auth', protocol: 6, token: h.token(uid) });
  assert.equal(connection.attachment().speedExpires, entitlement.expiresAt);
  place(h, connection, start);
  for (let seq = 3; seq < 6; seq++) await move(h, connection, { x: 1, z: 0, jump: false }, seq);
  const entitledDistance = planarDistance(start, connection.attachment());
  assert.ok(Math.abs(entitledDistance - normalDistance * 2) < 1e-8,
    'only the backend verified buff doubles authoritative speed from 22 to 44');
});

test('P3 authoritative movement clamps every world border', async t => {
  const h = harness(t);
  for (const [index, initial, input] of [
    [{ x: 747.9, y: 0, z: 0, r: 0 }, { x: 1, z: 0, jump: false }],
    [{ x: -747.9, y: 0, z: 0, r: 0 }, { x: -1, z: 0, jump: false }],
    [{ x: 0, y: 0, z: 747.9, r: 0 }, { x: 0, z: 1, jump: false }],
    [{ x: 0, y: 0, z: -747.9, r: 0 }, { x: 0, z: -1, jump: false }]
  ].map((entry, index) => [index, ...entry])) {
    const connection = await authenticate(h, { uid: `synthetic-p3-border-${index}` });
    place(h, connection, initial);
    await move(h, connection, input, 0, 500);
    const p = connection.attachment();
    assert.ok(Math.abs(p.x) <= 748 && Math.abs(p.z) <= 748);
    assert.equal(Math.max(Math.abs(p.x), Math.abs(p.z)), 748);
  }
});

test('P3 actual seeded building collision blocks movement and delayed packets cannot tunnel through walls', async t => {
  const h = harness(t);
  const { SERVER_WORLD } = await world();
  const obstacle = SERVER_WORLD.buildings[0];
  assert.ok(obstacle.maxX - obstacle.minX > 10);
  const connection = await authenticate(h, { uid: 'synthetic-p3-wall' });
  place(h, connection, { x: obstacle.minX - 2, y: 0, z: (obstacle.minZ + obstacle.maxZ) / 2, r: 0 });
  for (let seq = 0; seq < 5; seq++) {
    await move(h, connection, { x: 1, z: 0, jump: false }, seq, 500);
    const p = connection.attachment();
    assert.ok(p.x <= obstacle.minX, 'collision must keep the player outside the building');
    assert.ok(p.x < obstacle.maxX, 'substeps must prevent crossing to the far side of a wall');
  }
});

test('P3 teleport, speed, timestamp, velocity and raw-position authority are rejected', async t => {
  const h = harness(t);
  const invalid = [
    { type: 'move', x: 500, y: 0, z: 500, r: 0 },
    { type: 'move', input: { x: 1, z: 0, jump: false }, seq: 0, x: 500 },
    { type: 'move', input: { x: 1, z: 0, jump: false }, seq: 0, speed: 1000 },
    { type: 'move', input: { x: 1, z: 0, jump: false }, seq: 0, timestamp: h.now() + 1e9 },
    { type: 'move', input: { x: 1, z: 0, jump: false }, seq: 0, velocity: { x: 999, y: 0, z: 999 } }
  ];
  for (const [index, frame] of invalid.entries()) {
    const connection = await authenticate(h, { uid: `synthetic-p3-authority-${index}` });
    await rejectWithoutMutation(h, connection, frame);
  }
});

test('P3 malformed intent ranges and sequence values cannot mutate position or rewards', async t => {
  const h = harness(t);
  const invalid = [
    { input: { x: 1.01, z: 0, jump: false }, seq: 0 },
    { input: { x: 1, z: 1, jump: false }, seq: 0 },
    { input: { x: '1', z: 0, jump: false }, seq: 0 },
    { input: { x: 0, z: 0, jump: 1 }, seq: 0 },
    { input: { x: 0, z: 0, jump: false, y: 999 }, seq: 0 },
    { input: idle(), seq: -1 }, { input: idle(), seq: 1.5 }, { input: idle(), seq: '1' },
    { input: idle(), seq: Number.MAX_SAFE_INTEGER + 1 }, { input: idle() }
  ];
  for (const [index, frame] of invalid.entries()) {
    const connection = await authenticate(h, { uid: `synthetic-p3-schema-${index}` });
    await rejectWithoutMutation(h, connection, { type: 'move', ...frame });
  }
});

test('P3 duplicate, stale and out-of-order intent sequences leave self and nearby peers unchanged', async t => {
  const h = harness(t);
  const mover = await authenticate(h, { uid: 'synthetic-p3-sequence' });
  const peer = await authenticate(h, { uid: 'synthetic-p3-sequence-peer' });
  place(h, mover, { x: 0, y: 0, z: 0, r: 0 });
  place(h, peer, { x: 10, y: 0, z: 0, r: 0 });
  await move(h, mover, { x: 1, z: 0, jump: false }, 10);
  const before = position(mover.attachment());
  const ackCount = mover.messages('move').length;
  const peerCount = peer.messages('move').length;
  for (const seq of [10, 9, 0, 8]) {
    await h.advance(200);
    await mover.send({ type: 'move', input: { x: -1, z: 0, jump: false }, seq });
    assert.deepEqual(position(mover.attachment()), before);
    assert.equal(mover.messages('move').length, ackCount);
    assert.equal(peer.messages('move').length, peerCount);
  }
  assertSelfAck(mover, await move(h, mover, { x: 1, z: 0, jump: false }, 11), 11);
  assert.ok(mover.attachment().x > before.x);
});

test('P3 an early intent ACK preserves the 200ms movement clock and never adds peer fanout', async t => {
  const h = harness(t);
  const mover = await authenticate(h, { uid: 'synthetic-p3-minimum-cadence' });
  const peer = await authenticate(h, { uid: 'synthetic-p3-minimum-cadence-peer' });
  place(h, mover, { x: 0, y: 0, z: 0, r: 0 });
  place(h, peer, { x: 10, y: 0, z: 0, r: 0 });
  await move(h, mover, { x: 1, z: 0, jump: false }, 0);
  const before = position(mover.attachment());
  const clock = mover.attachment().motion.clock;
  const peers = peer.messages('move').length;
  const early = await move(h, mover, { x: 1, z: 0, jump: false }, 1, 199);
  assert.equal(early.ack, 1);
  assert.equal(early.applied, false);
  assert.deepEqual(position(mover.attachment()), before);
  assert.equal(mover.attachment().motion.clock, clock);
  assert.equal(peer.messages('move').length, peers);
  const accepted = await move(h, mover, { x: 1, z: 0, jump: false }, 2, 1);
  assert.equal(accepted.applied, true);
  assert.equal(mover.attachment().motion.clock - clock, 200);
  assert.ok(mover.attachment().x > before.x);
  assert.equal(peer.messages('move').length, peers + 1);
});

test('P3 valid-intent floods cannot advance server time or gain distance and are rate limited', async t => {
  const h = harness(t);
  const connection = await authenticate(h, { uid: 'synthetic-p3-flood' });
  place(h, connection, { x: 0, y: 0, z: 0, r: 0 });
  await move(h, connection, { x: 1, z: 0, jump: false }, 0);
  const before = position(connection.attachment());
  for (let seq = 1; seq < 100 && !connection.client.closed; seq++) {
    await connection.send({ type: 'move', input: { x: 1, z: 0, jump: false }, seq });
  }
  assert.deepEqual(position(connection.attachment()), before);
  assert.equal(connection.client.closed, true);
  assert.equal(connection.client.closeInfo.code, 1008);
});

test('P3 latency, jitter and dropped inputs preserve server-time speed bounds and coherent ACKs', async t => {
  const h = harness(t);
  const connection = await authenticate(h, { uid: 'synthetic-p3-jitter' });
  place(h, connection, { x: 0, y: 0, z: 0, r: 0 });
  const start = position(connection.attachment());
  const at = h.now();
  for (const [seq, elapsed] of [[0, 200], [2, 350], [5, 750], [8, 210], [9, 420]]) {
    assertSelfAck(connection, await move(h, connection, { x: 1, z: 0, jump: false }, seq, elapsed), seq);
    assert.ok(planarDistance(start, connection.attachment()) <= 22 * (h.now() - at) / 1000 + 1e-8);
  }
  const beforePause = position(connection.attachment());
  const ack = await move(h, connection, { x: 1, z: 0, jump: false }, 12, 10_000);
  assertSelfAck(connection, ack, 12);
  assert.ok(planarDistance(beforePause, connection.attachment()) <= 22 * 0.5 + 1e-8,
    'a long delivery pause cannot grant accumulated teleport distance');
});

test('P3 movement fans out to nearby players and excludes distant players', async t => {
  const h = harness(t);
  const mover = await authenticate(h, { uid: 'synthetic-p3-proximity' });
  const near = await authenticate(h, { uid: 'synthetic-p3-proximity-near' });
  const far = await authenticate(h, { uid: 'synthetic-p3-proximity-far' });
  place(h, mover, { x: 0, y: 0, z: 0, r: 0 });
  place(h, near, { x: 100, y: 0, z: 0, r: 0 });
  place(h, far, { x: 300, y: 0, z: 0, r: 0 });
  near.clear(); far.clear();
  for (let seq = 0; seq < 4; seq++) await move(h, mover, { x: 0, z: 1, jump: false }, seq);
  assert.equal(near.messages('move').length, 4);
  assert.ok(near.messages('move').every(message => message.player.id === mover.attachment().id));
  assert.equal(far.messages('move').length, 0);
});

test('P3 collect position hints cannot move the player or grant an out-of-reach reward', async t => {
  const h = harness(t);
  const connection = await authenticate(h, { uid: 'synthetic-p3-collect-hint' });
  const original = position(connection.attachment());
  const coin = h.room().coinSnapshot().find(candidate => planarDistance(candidate, original) > 20);
  assert.ok(coin);
  await connection.send({ type: 'collect', id: coin.id, x: coin.x, y: 0, z: coin.z, r: 0 });
  assert.deepEqual(position(connection.attachment()), original);
  assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', 'synthetic-p3-collect-hint').toArray()[0].score, 0);
  assert.equal(h.room().coinSnapshot()[coin.id].respawnAt, 0);
  assert.equal(h.room().coinSnapshot().length, 200);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_lucky_box').toArray()[0].count, 1);
});

test('P3 reconnect resumes persisted authoritative position with one owner and bounded new motion', async t => {
  const h = harness(t);
  const uid = 'synthetic-p3-reconnect';
  const source = await authenticate(h, { uid });
  const original = last(source, 'welcome');
  for (let seq = 0; seq < 4; seq++) await move(h, source, { x: 1, z: 0, jump: false }, seq);
  const authoritative = position(source.attachment());
  const row = h.room().sql.exec('SELECT * FROM voxel_sessions WHERE uid=?', uid).toArray()[0];
  assert.equal(row.x, authoritative.x);
  assert.equal(row.z, authoritative.z);
  await source.close();
  await h.advance(2000);
  const target = await authenticate(h, { uid, resumeToken: original.session.resumeToken });
  assert.equal(last(target, 'welcome').id, original.id);
  assert.deepEqual(position(target.attachment()), authoritative);
  assert.equal(h.room().count(), 1);
  assertSelfAck(target, await move(h, target, { x: 1, z: 0, jump: false }, 0), 0);
  assert.ok(planarDistance(authoritative, target.attachment()) <= 22 * 0.2 + 1e-8);
});

async function beginHandoff(h, uid) {
  const source = await authenticate(h, { uid, zone: '4,4' });
  place(h, source, { x: -0.1, y: 0, z: -75, r: 0 });
  await move(h, source, { x: 1, z: 0, jump: false }, 0);
  const change = last(source, 'zone_change');
  assert.ok(change?.handoffToken, 'authoritative border crossing must produce a handoff ticket');
  assert.equal(change.zone, '5,4');
  return { source, change };
}

test('P3 border handoff transfers exactly one owner and uses the authoritative ticket position', async t => {
  const h = harness(t);
  const uid = 'synthetic-p3-handoff';
  const { source, change } = await beginHandoff(h, uid);
  const target = await authenticate(h, { uid, zone: change.zone, handoffToken: change.handoffToken });
  const anchor = position(target.attachment());
  assert.equal(h.zone('4,4').count(), 1);
  assert.equal(h.zone('5,4').count(), 0, 'provisional target is not an active owner');
  await target.send({ type: 'handoff_resume', input: idle(), seq: 1 });
  assert.ok(last(target, 'handoff_resumed'));
  assert.deepEqual(position(target.attachment()), anchor);
  assert.equal(source.client.closed, true);
  assert.equal(target.client.closed, false);
  assert.equal(h.zone('4,4').count(), 0);
  assert.equal(h.zone('5,4').count(), 1);
  assert.equal(h.room().sql.exec('SELECT owner FROM voxel_sessions WHERE uid=?', uid).toArray()[0].owner, 'zone:5,4');
});

test('P3 target coordinate spoof cannot change the handoff anchor or duplicate ownership', async t => {
  const h = harness(t);
  const uid = 'synthetic-p3-handoff-spoof';
  const { source, change } = await beginHandoff(h, uid);
  const target = await authenticate(h, { uid, zone: change.zone, handoffToken: change.handoffToken });
  const anchor = position(target.attachment());
  await target.send({ type: 'handoff_resume', x: anchor.x + 20, y: anchor.y, z: anchor.z, r: anchor.r });
  assert.equal(target.messages('handoff_resumed').length, 0);
  assert.deepEqual(position(target.attachment()), anchor);
  assert.equal(h.zone('5,4').count(), 0);
  assert.equal(h.room().sql.exec('SELECT owner FROM voxel_sessions WHERE uid=?', uid).toArray()[0].owner, 'zone:4,4');
  assert.equal(source.client.closed, false);
});

test('P3 expired transfer and late resume fail closed without creating target ownership', async t => {
  const h = harness(t);
  const uid = 'synthetic-p3-late-handoff';
  const { source, change } = await beginHandoff(h, uid);
  const target = await authenticate(h, { uid, zone: change.zone, handoffToken: change.handoffToken });
  await h.advance(9001);
  await target.send({ type: 'handoff_resume', input: idle(), seq: 1 });
  assert.equal(target.messages('handoff_resumed').length, 0);
  assert.equal(h.zone('5,4').count(), 0);
  assert.equal(h.room().sql.exec('SELECT owner FROM voxel_sessions WHERE uid=?', uid).toArray()[0].owner, 'zone:4,4');
  assert.equal(source.client.closed, false);
  const replay = await h.open(`/play?zone=${change.zone}`);
  await replay.send({ type: 'auth', token: h.token(uid), protocol: 6, handoffToken: change.handoffToken });
  assert.equal(replay.client.closed, true);
  assert.equal(replay.messages('welcome').length, 0);
});

test('P3 cancel restores the source snapshot and fences a consumed target ticket against a late ACK', async t => {
  const h = harness(t);
  const uid = 'synthetic-p3-cancelled-handoff';
  const { source, change } = await beginHandoff(h, uid);
  const target = await authenticate(h, { uid, zone: change.zone, handoffToken: change.handoffToken });
  const anchor = position(target.attachment());
  assert.equal(h.zone('5,4').count(), 0);
  await source.send({ type: 'handoff_cancel' });
  assert.ok(last(source, 'handoff_cancelled'));
  assert.deepEqual(position(source.attachment()), { x: -0.1, y: 0, z: -75, r: 0 },
    'cancellation must restore the server pre-crossing snapshot, never client coordinates');
  assert.equal(source.client.closed, false);
  assert.equal(h.zone('4,4').count(), 1);
  await move(h, source, { x: -1, z: 0, jump: false }, 1);
  const continued = position(source.attachment());
  assert.ok(continued.x < -0.1);
  // Keep the already authenticated provisional target open. Its consumed
  // ticket must remain fenced even after the source resumes valid movement.
  if (!target.client.closed) await target.send({ type: 'handoff_resume', input: idle(), seq: 1 });
  assert.equal(target.messages('handoff_resumed').length, 0);
  assert.deepEqual(position(target.attachment()), anchor);
  assert.deepEqual(position(source.attachment()), continued);
  assert.equal(h.zone('5,4').count(), 0);
  assert.equal(h.zone('4,4').count(), 1);
  assert.equal(h.room().sql.exec('SELECT owner FROM voxel_sessions WHERE uid=?', uid).toArray()[0].owner, 'zone:4,4');
});

test('P3 shared physics deterministically resolves obstacle substeps and finite bounded state', async () => {
  const { integrateMovement } = await kernel();
  const initial = { x: 0, y: 0, z: 0, r: 0, vx: 0, vz: 0, vy: 0, grounded: true };
  const obstacles = [{ minX: 2, maxX: 3, minZ: -2, maxZ: 2 }];
  const input = { x: 1, z: 0, jump: false };
  const first = integrateMovement(initial, input, 0.5, { speed: 22, bounds: 748, obstacles });
  const second = integrateMovement(initial, input, 0.5, { speed: 22, bounds: 748, obstacles });
  assert.deepEqual(first, second);
  assert.deepEqual(initial, { x: 0, y: 0, z: 0, r: 0, vx: 0, vz: 0, vy: 0, grounded: true },
    'physics kernel must not mutate the input state shared with prediction/replay');
  assert.ok(first.x < 2);
  assert.ok(first.x >= 0);
  for (const key of ['x', 'y', 'z', 'r', 'vx', 'vz', 'vy']) assert.ok(Number.isFinite(first[key]));
});
