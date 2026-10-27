'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, CERTS_URL } = require('./harness.cjs');
const { integrateMovement, MOVEMENT } = require('../../src/shared/movement.mjs');
const { SERVER_WORLD } = require('../../src/worker/world.mjs');

// These tests execute the staged Worker, real Firebase RSA verification,
// per-socket queue, ZoneRoom physics and SQLite session/handoff authority.
// Only the transport, time and external identity certificate are synthetic.
const last = (connection, type) => connection.messages(type).at(-1);
const plain = value => JSON.parse(JSON.stringify(value));
const pose = player => Object.fromEntries(['x', 'y', 'z', 'r'].map(axis => [axis, player[axis]]));
const idle = { x: 0, z: 0, jump: false };
const right = { x: 1, z: 0, jump: false };
const forward = { x: 0, z: 1, jump: false };
const framePacket = (seq, input, intervals = 2, delta = .1) => ({ type: 'move', seq, input,
  frames: Array.from({ length: intervals }, () => ({ input, delta })) });
const session = (h, uid) => h.room().sessions.row(uid);

function fixture(t, staging = true) {
  const projectId = 'zone-handoff-staging-fixture';
  const workerName = 'gpt-voxel-3d-staging-zone-transition-fixture';
  const workerOrigin = `https://${workerName}.invalid`;
  const h = createHarness(staging ? { workerOrigin, defaultTokenProject: projectId,
    env: { APP_ENV: 'staging', STAGING_WORKER_NAME: workerName,
      STAGING_WORKER_ORIGIN: workerOrigin, ALLOWED_ORIGIN: workerOrigin,
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_PUBLIC_CONFIG: JSON.stringify({ apiKey: 'synthetic-public-staging-key',
        projectId, authDomain: `${projectId}.firebaseapp.com`, appId: '1:123456:web:abcdef123456' }),
      FIREBASE_APP_CHECK_SITE_KEY: '6L' + 'A'.repeat(38),
      FIREBASE_ONLINE_USER_CHECK: 'false',
      STAGING_AUTH_MODE: 'popup', PAYMENT_MODE: 'provider-neutral-test',
      PAYMENT_WEBHOOK_SECRET: undefined, SLIP2GO_API_SECRET: undefined } } :
    { env: { APP_ENV: 'production' } });
  t.after(() => h.close());
  return h;
}

async function authenticate(h, uid, zone, extra = {}) {
  const connection = await h.open(`/play?zone=${encodeURIComponent(zone)}`);
  await connection.send({ type: 'auth', protocol: 6, token: h.token(uid), ...extra });
  return connection;
}

async function admitted(h, uid, zone, extra = {}) {
  const connection = await authenticate(h, uid, zone, extra);
  assert.ok(last(connection, 'welcome'), 'the actual Firebase verifier admits the synthetic identity');
  assert.equal(connection.client.closed, false);
  return connection;
}

function assertOneOwner(h, uid, zone, zones = ['4,4', '5,4']) {
  assert.equal(session(h, uid).owner, `zone:${zone}`);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_sessions WHERE uid=?', uid).toArray()[0].n, 1);
  assert.equal(zones.reduce((count, zoneId) => {
    const room = h.zone(zoneId);
    return count + room.sockets().filter(socket => {
      const player = room.player(socket);
      return player?.uid === uid && room.activePlayer(player);
    }).length;
  }, 0), 1,
    'only the durable owner participates as an active player');
}

function assertIsolated(h) {
  assert.ok(h.records.fetches.every(entry => entry.url === CERTS_URL),
    'only the isolated synthetic Firebase certificate fixture is contacted');
  assert.ok(h.records.routes.every(entry => entry.binding === 'ROOM' ? entry.name === 'free-v2-demo' :
    /^free-zone-[0-9],[0-9]$/.test(entry.name)),
  'the actual staged Worker reaches only the local fixture namespaces');
}

// Hold the real response after processing it. The target has begun real auth,
// but its welcome is delayed while the source's separate socket queue runs.
function holdNextRoomResponse(h, pathname) {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  const get = h.env.ROOM.getByName;
  let held = false;
  h.env.ROOM.getByName = name => {
    const stub = get(name);
    return { async fetch(request) {
      const response = await stub.fetch(request);
      if (!held && new URL(request.url).pathname === pathname) {
        held = true;
        entered();
        await blocked;
      }
      return response;
    } };
  };
  return { release, entered: seen };
}

async function applyAndCheck(h, connection, seq, input, intervals = 2) {
  const before = connection.attachment();
  let expected = { ...before, ...before.motion };
  await h.advance(intervals * 100);
  for (let index = 0; index < intervals; index++) expected = integrateMovement(expected, input, .1,
    { speed: MOVEMENT.speed, obstacles: [...SERVER_WORLD.buildings, ...SERVER_WORLD.trees], bounds: MOVEMENT.bounds });
  await connection.send(framePacket(seq, input, intervals));
  const accepted = connection.attachment();
  assert.deepEqual(pose(accepted), pose(expected), 'the real owning server integrates every affordable ordered frame');
  for (const field of ['vx', 'vy', 'vz', 'grounded', 'jumpHeld']) assert.equal(accepted.motion[field], expected[field]);
  assert.equal(accepted.motion.seq, seq);
  assert.equal(last(connection, 'move').ack, seq);
  assert.equal(accepted.motion.clock, h.now());
  assert.ok(accepted.motion.credit < 1e-9);
  return accepted;
}

async function continuousCrossing(h, uid) {
  const source = await admitted(h, uid, '4,4', { continuousHandoff: true });
  // Initial placement is a trusted server fixture. Warmup, crossing, turns,
  // jumps and all later positions come from actual client intent handlers.
  h.place(source, { x: -6, y: 0, z: -75, r: 0 });
  await applyAndCheck(h, source, 0, right);
  assert.equal(source.attachment().handoffPending, null);
  await applyAndCheck(h, source, 1, right, 3);
  const ticket = last(source, 'zone_change');
  assert.ok(ticket?.handoffToken);
  assert.equal(ticket.zone, '5,4');
  assert.ok(source.attachment().x > 0);
  return { source, ticket };
}

test('staging continuous handoff integrates turns and jumping through delayed target auth and transfers latest motion exactly', async t => {
  const h = fixture(t), uid = 'synthetic-continuous-delayed-welcome';
  const { source, ticket } = await continuousCrossing(h, uid);
  const originalAnchor = plain(ticket.position);
  const id = source.attachment().id, sessionId = source.attachment().sessionId;
  const target = await h.open('/play?zone=5,4');
  const hold = holdNextRoomResponse(h, '/_internal/zone-bootstrap');
  const pendingAuth = target.send({ type: 'auth', protocol: 6, token: h.token(uid),
    handoffToken: ticket.handoffToken, continuousHandoff: true });
  await hold.entered;
  const start = h.now();
  let seq = 1;
  try {
    for (let index = 0; index < 6; index++) await applyAndCheck(h, source, ++seq, right);
    for (let index = 0; index < 5; index++) await applyAndCheck(h, source, ++seq, forward);
    await applyAndCheck(h, source, ++seq, { ...forward, jump: true });
    assert.ok(h.now() - start > 2000, 'welcome latency exceeds the reported transition freeze');
    assert.equal(target.messages('welcome').length, 0);
    assert.ok(source.attachment().y > 0);
    assert.ok(source.attachment().motion.vy > 0);
    assert.ok(source.attachment().motion.vz > 20);
    assert.ok(source.attachment().z > originalAnchor.z + 10, 'turning source movement continues while the ticket is pending');
    assert.notDeepEqual(pose(source.attachment()), originalAnchor);
    assert.equal(target.instance.count(), 0, 'the waiting target cannot become a second active owner');
    assertOneOwner(h, uid, '4,4');
  } finally {
    hold.release();
    await pendingAuth;
  }
  assert.ok(last(target, 'welcome')?.handoff);
  assert.equal(last(target, 'welcome').continuousHandoff, true);
  assert.equal(target.instance.count(), 0);

  // Retain genuine, unspent server time and an airborne velocity. A transfer
  // must neither erase that time nor mint more time at the same clock.
  const movingPose = pose(source.attachment());
  await h.advance(300);
  await source.send(framePacket(++seq, { ...forward, jump: true }, 1, 0));
  const latest = source.attachment();
  assert.deepEqual(pose(latest), movingPose);
  assert.ok(Math.abs(latest.motion.credit - .3) < 1e-9);

  let inspectedAck = false;
  target.client.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.type !== 'handoff_resumed') return;
    inspectedAck = true;
    assert.equal(message.continuousHandoff, true);
    assert.equal(message.ack, seq, 'resume acknowledges the last authoritative source movement');
    assert.equal(source.client.closed, false, 'source transport closes only after the target ACK is sent');
    assertOneOwner(h, uid, '5,4');
  });
  await target.send({ type: 'handoff_resume', seq: seq + 1 });
  assert.equal(inspectedAck, true);
  const transferred = target.attachment(), ack = last(target, 'handoff_resumed');
  assert.deepEqual(pose(transferred), pose(latest), 'the final source snapshot replaces the old ticket anchor');
  assert.deepEqual(transferred.motion, latest.motion, 'velocity, jump state, sequence, credit and clock survive the ownership transfer');
  assert.equal(transferred.lastSequence, seq, 'the target client cannot choose the transferred sequence fence');
  assert.equal(transferred.id, id);
  assert.equal(transferred.sessionId, sessionId);
  assert.equal(ack.movement.lastSeq, seq);
  assert.equal(source.client.closed, true);
  assertOneOwner(h, uid, '5,4');
  assert.deepEqual(pose(session(h, uid)), pose(latest), 'the CAS persists the latest server-authored pose');

  const beforeReplay = target.attachment(), rowBeforeReplay = plain(session(h, uid));
  await target.send(framePacket(seq, right, 5));
  const afterReplay = target.attachment();
  assert.deepEqual(pose(afterReplay), pose(beforeReplay), 'a transferred source sequence cannot move the target again');
  assert.deepEqual(afterReplay.motion, beforeReplay.motion, 'replay cannot spend or mint simulation time');
  assert.equal(afterReplay.lastSequence, beforeReplay.lastSequence);
  assert.equal(afterReplay.checkpointRevision, beforeReplay.checkpointRevision);
  assert.equal(afterReplay.security.packetTokens, beforeReplay.security.packetTokens - 1,
    'replay still spends its normal packet-rate budget');
  assert.deepEqual(plain(session(h, uid)), rowBeforeReplay);
  await source.instance.webSocketMessage(source.server, JSON.stringify(framePacket(seq + 50, right, 5)));
  await h.settle();
  assert.deepEqual(pose(target.attachment()), pose(beforeReplay));
  assert.deepEqual(plain(session(h, uid)), rowBeforeReplay, 'a late source frame cannot mutate the committed successor');

  await target.send(framePacket(seq + 1, forward, 3));
  assert.equal(last(target, 'move').ack, seq + 1);
  assert.ok(target.attachment().z > beforeReplay.z, 'the first sequence after the ACK spends the preserved legitimate credit');
  assert.ok(target.attachment().motion.credit < 1e-9);
  const spent = pose(target.attachment());
  await target.send(framePacket(seq + 2, forward, 5));
  assert.deepEqual(pose(target.attachment()), spent, 'time spent on the target cannot be spent twice at the same server clock');
  assert.equal(target.attachment().motion.credit, 0);
  assertOneOwner(h, uid, '5,4');
  t.diagnostic('Simulated target-auth latency: 2400 ms; source accepted all 12 movement batches during warmup; cutover added no simulated clock delay.');
  assertIsolated(h);
});

test('staging continuous cancellation keeps latest source pose and never refunds spent or retained credit', async t => {
  const h = fixture(t), uid = 'synthetic-continuous-cancel';
  const { source, ticket } = await continuousCrossing(h, uid);
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  await applyAndCheck(h, source, 2, right);
  await applyAndCheck(h, source, 3, { ...forward, jump: true });
  await h.advance(300);
  await source.send(framePacket(4, { ...forward, jump: true }, 1, 0));
  const latest = source.attachment();
  assert.ok(Math.abs(latest.motion.credit - .3) < 1e-9);
  assert.notDeepEqual(pose(latest), plain(ticket.position));
  await source.send({ type: 'handoff_cancel', seq: 5 });
  const cancelled = source.attachment();
  assert.deepEqual(pose(cancelled), pose(latest), 'continuous mode never rolls back legitimate movement while auth was pending');
  for (const field of ['vx', 'vy', 'vz', 'grounded', 'jumpHeld', 'seq']) assert.equal(cancelled.motion[field], latest.motion[field]);
  assert.equal(cancelled.motion.credit, 0);
  assert.equal(cancelled.motion.clock, h.now());
  assert.equal(cancelled.handoffPending, null);
  assert.equal(last(source, 'handoff_cancelled').nextSequence, 6);
  assert.deepEqual(pose(session(h, uid)), pose(latest));
  assertOneOwner(h, uid, '4,4');

  await target.send({ type: 'handoff_resume' });
  assert.equal(target.messages('handoff_resumed').length, 0, 'a cancelled grant cannot acquire ownership later');
  assert.equal(target.client.closed, true);
  await source.send(framePacket(4, right, 5));
  assert.deepEqual(pose(source.attachment()), pose(latest));
  assert.equal(source.attachment().lastSequence, 5);
  await source.send(framePacket(6, right, 5));
  assert.deepEqual(pose(source.attachment()), pose(latest), 'a fresh packet also cannot spend cancelled credit');
  assert.equal(source.attachment().motion.credit, 0);
  assertOneOwner(h, uid, '4,4');
  assertIsolated(h);
});

test('staging source seal waits for earlier queued movement before transferring its authoritative snapshot', async t => {
  const h = fixture(t), uid = 'synthetic-continuous-serialized-seal';
  const { source, ticket } = await continuousCrossing(h, uid);
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  let release, enteredValidation, enteredSeal;
  const blocked = new Promise(resolve => { release = resolve; });
  const validationSeen = new Promise(resolve => { enteredValidation = resolve; });
  const sealSeen = new Promise(resolve => { enteredSeal = resolve; });
  const call = source.instance.sessionCall.bind(source.instance);
  let held = false;
  source.instance.sessionCall = async (action, payload) => {
    const response = await call(action, payload);
    if (!held && action === 'validate') {
      held = true;
      enteredValidation();
      await blocked;
    }
    return response;
  };
  const get = h.env.ZONE.getByName;
  h.env.ZONE.getByName = name => {
    const stub = get(name);
    return { async fetch(request) {
      if (new URL(request.url).pathname === '/_internal/staging-handoff-seal') enteredSeal();
      return stub.fetch(request);
    } };
  };
  await h.advance(200);
  const pendingSource = source.send(framePacket(2, { ...forward, jump: true }));
  await validationSeen;
  const before = source.attachment();
  const pendingResume = target.send({ type: 'handoff_resume' });
  try {
    await sealSeen;
    assert.equal(target.messages('handoff_resumed').length, 0);
    assert.deepEqual(pose(source.attachment()), pose(before), 'the earlier source frame is still awaiting authority');
    assertOneOwner(h, uid, '4,4');
  } finally {
    release();
    await Promise.all([pendingSource, pendingResume]);
  }
  assert.equal(last(target, 'handoff_resumed').ack, 2);
  assert.ok(target.attachment().y > 0, 'the queued jump was included before sealing');
  assert.ok(target.attachment().z > before.z, 'the queued turn was included before sealing');
  assert.deepEqual(pose(target.attachment()), pose(source.attachment()));
  assert.deepEqual(target.attachment().motion, source.attachment().motion);
  assert.deepEqual(pose(session(h, uid)), pose(target.attachment()));
  assertOneOwner(h, uid, '5,4');
  assertIsolated(h);
});

test('staging continuous grant rejects account and mode mismatches without surrendering the source owner', async t => {
  const h = fixture(t), uid = 'synthetic-continuous-mode-fence';
  const { source, ticket } = await continuousCrossing(h, uid);
  const before = plain(session(h, uid));
  const wrongAccount = await authenticate(h, 'synthetic-other-account', '5,4', {
    handoffToken: ticket.handoffToken, continuousHandoff: true });
  assert.equal(wrongAccount.messages('welcome').length, 0);
  assert.equal(wrongAccount.client.closed, true);
  const wrongMode = await authenticate(h, uid, '5,4', { handoffToken: ticket.handoffToken });
  assert.equal(wrongMode.messages('welcome').length, 0);
  assert.equal(wrongMode.client.closed, true);
  assert.deepEqual(plain(session(h, uid)), before);
  assert.equal(source.client.closed, false);
  assertOneOwner(h, uid, '4,4');
  const accepted = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  await accepted.send({ type: 'handoff_resume' });
  assert.ok(last(accepted, 'handoff_resumed'));
  assertOneOwner(h, uid, '5,4');
  assertIsolated(h);
});

test('staging clients without ordered frame opt-in retain the legacy frozen-anchor handoff', async t => {
  const h = fixture(t), uid = 'synthetic-staging-legacy-transition';
  const source = await admitted(h, uid, '4,4');
  h.place(source, { x: -.1, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await source.send({ type: 'move', seq: 0, input: right });
  const ticket = last(source, 'zone_change');
  assert.ok(ticket?.handoffToken);
  const anchor = pose(source.attachment());
  await h.advance(2200);
  await source.send({ type: 'move', seq: 1, input: { ...forward, jump: true } });
  assert.deepEqual(pose(source.attachment()), anchor);
  const wrongMode = await authenticate(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  assert.equal(wrongMode.messages('welcome').length, 0);
  assert.equal(wrongMode.client.closed, true);
  assertOneOwner(h, uid, '4,4');
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken });
  assert.notEqual(last(target, 'welcome').continuousHandoff, true);
  await target.send({ type: 'handoff_resume', seq: 2 });
  assert.deepEqual(pose(target.attachment()), plain(ticket.position));
  assert.notEqual(last(target, 'handoff_resumed').continuousHandoff, true);
  assert.equal(target.attachment().motion.credit, 0);
  assertOneOwner(h, uid, '5,4');
  assertIsolated(h);
});

test('production Free ordered movement keeps source authority live until continuous target cutover', async t => {
  const h = fixture(t, false), uid = 'synthetic-production-continuous-transition';
  const { source, ticket } = await continuousCrossing(h, uid);
  assert.equal(ticket.continuousHandoff, true);
  const anchor = pose(source.attachment());
  await applyAndCheck(h, source, 2, right, 3);
  await applyAndCheck(h, source, 3, forward, 2);
  const latest = pose(source.attachment());
  assert.notDeepEqual(latest, anchor, 'production source keeps accepting authoritative movement during target warmup');
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  assert.equal(last(target, 'welcome').continuousHandoff, true);
  await target.send({ type: 'handoff_resume', seq: 4 });
  const resumed = last(target, 'handoff_resumed');
  assert.equal(resumed.continuousHandoff, true);
  assert.deepEqual(pose(target.attachment()), latest);
  assert.equal(source.client.closed, true);
  assertOneOwner(h, uid, '5,4');
  assertIsolated(h);
});

test('staging ordered frames without AUTH opt-in keep the legacy ownership contract', async t => {
  const h = fixture(t), uid = 'synthetic-staging-unselected-continuity';
  const source = await admitted(h, uid, '4,4');
  h.place(source, { x: -.1, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await source.send(framePacket(0, right));
  const ticket = last(source, 'zone_change');
  assert.ok(ticket?.handoffToken);
  const anchor = pose(source.attachment());
  await h.advance(2200);
  await source.send(framePacket(1, { ...forward, jump: true }));
  assert.deepEqual(pose(source.attachment()), anchor);
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken });
  await target.send({ type: 'handoff_resume', seq: 2 });
  assert.deepEqual(pose(target.attachment()), plain(ticket.position));
  assert.notEqual(last(target, 'handoff_resumed').continuousHandoff, true);
  assertOneOwner(h, uid, '5,4');
  assertIsolated(h);
});

test('twelve rapid back-and-forth Zone crossings preserve every input, momentum, durable identity and unique membership', async t => {
  const h = fixture(t), uid = 'synthetic-repeated-zone-boundary';
  let source = await admitted(h, uid, '4,4', { continuousHandoff: true });
  h.place(source, { x: -6, y: 0, z: -75, r: 0 });
  const identity = { id: source.attachment().id, sessionId: source.attachment().sessionId };
  const latencies = [];
  let seq = -1, acceptedFrames = 0;
  for (let crossing = 0; crossing < 12; crossing++) {
    const from = source.attachment().zoneId;
    const to = from === '4,4' ? '5,4' : '4,4';
    const input = { ...right, x: from === '4,4' ? 1 : -1 };
    let ticket;
    for (let batch = 0; batch < 8 && !ticket; batch++) {
      const before = pose(source.attachment());
      await applyAndCheck(h, source, ++seq, input);
      acceptedFrames += 2;
      assert.ok(Math.hypot(source.attachment().x - before.x, source.attachment().z - before.z) <= 4.4 + 1e-9,
        'normal source speed remains bounded at every crossing');
      ticket = last(source, 'zone_change');
      assertOneOwner(h, uid, from);
    }
    assert.equal(ticket?.zone, to, `crossing ${crossing + 1} creates the adjacent Zone ticket from actual movement`);
    assert.equal(ticket.continuousHandoff, true);
    const target = await admitted(h, uid, to, { handoffToken: ticket.handoffToken, continuousHandoff: true });
    assert.equal(target.instance.count(), 0);
    assertOneOwner(h, uid, from);
    // A warm target does not stop the source from accepting the next input.
    await applyAndCheck(h, source, ++seq, input, 1);
    acceptedFrames++;
    const latest = source.attachment();
    const wallStart = performance.now(), serverStart = h.now();
    await target.send({ type: 'handoff_resume', seq: 1_000_000 + crossing });
    latencies.push(performance.now() - wallStart);
    assert.equal(h.now(), serverStart, 'handoff has no multi-second server-side waiting timer');
    assert.deepEqual(pose(target.attachment()), pose(latest));
    assert.deepEqual(target.attachment().motion, latest.motion);
    assert.equal(last(target, 'handoff_resumed').ack, seq);
    assert.equal(target.attachment().lastSequence, seq, 'a client-selected resume sequence cannot replace the source replay fence');
    for (const field of ['id', 'sessionId']) assert.equal(target.attachment()[field], identity[field]);
    assert.equal(source.client.closed, true);
    assertOneOwner(h, uid, to);
    source = target;
  }
  assert.ok(latencies.every(ms => ms < 1000), 'measured local cutover latency stays below one second on all twelve crossings');
  assert.ok(acceptedFrames >= 48, 'the round trips exercise sustained movement rather than teleport fixtures');
  t.diagnostic(`12 real authoritative cutovers; ${acceptedFrames} accepted movement frames; maximum measured local cutover ${Math.max(...latencies).toFixed(2)} ms.`);
  assertIsolated(h);
});

test('turning back across the boundary before target commit cancels safely and remains ready for repeated crossings', async t => {
  const h = fixture(t), uid = 'synthetic-repeated-return-before-commit';
  let source = await admitted(h, uid, '4,4', { continuousHandoff: true });
  h.place(source, { x: -6, y: 0, z: -75, r: 0 });
  let seq = -1;
  for (let attempt = 0; attempt < 4; attempt++) {
    source.clear();
    for (let batch = 0; batch < 8 && !last(source, 'zone_change'); batch++)
      await applyAndCheck(h, source, ++seq, right);
    const ticket = last(source, 'zone_change');
    assert.equal(ticket?.zone, '5,4');
    const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
    for (let batch = 0; batch < 8 && source.attachment().x >= 0; batch++)
      await applyAndCheck(h, source, ++seq, { ...right, x: -1 });
    assert.ok(source.attachment().x < 0, 'actual turning input returns to the source side while target auth is ready');
    const latest = source.attachment();
    await target.send({ type: 'handoff_resume', seq: seq + 1 });
    const rejected = last(target, 'handoff_resume_error');
    assert.equal(rejected?.continuousHandoff, true);
    assert.equal(rejected.cancelledToSource, true);
    assert.equal(target.messages('handoff_resumed').length, 0);
    assert.equal(target.client.closed, true);
    assert.equal(source.client.closed, false);
    assert.deepEqual(pose(source.attachment()), pose(latest), 'route cancellation cannot rewind legitimate returning movement');
    assert.equal(source.attachment().handoffPending, null);
    assert.equal(source.attachment().motion.seq, seq);
    assert.equal(source.attachment().motion.credit, 0);
    assertOneOwner(h, uid, '4,4');
  }
  source.clear();
  for (let batch = 0; batch < 8 && !last(source, 'zone_change'); batch++)
    await applyAndCheck(h, source, ++seq, right);
  const ticket = last(source, 'zone_change');
  const successor = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  await successor.send({ type: 'handoff_resume' });
  assert.equal(last(successor, 'handoff_resumed').ack, seq);
  assertOneOwner(h, uid, '5,4');
  assertIsolated(h);
});

test('jump held through a Zone crossing lands once and can jump again only after release', async t => {
  const h = fixture(t), uid = 'synthetic-jump-through-zone-boundary';
  const source = await admitted(h, uid, '4,4', { continuousHandoff: true });
  h.place(source, { x: -1.5, y: 0, z: -75, r: 0 });
  let seq = 0;
  await applyAndCheck(h, source, seq, { ...right, jump: true });
  const ticket = last(source, 'zone_change');
  assert.equal(ticket?.zone, '5,4');
  assert.ok(source.attachment().y > 0);
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  await target.send({ type: 'handoff_resume' });
  assert.deepEqual(target.attachment().motion, source.attachment().motion);
  for (let batch = 0; batch < 5; batch++) await applyAndCheck(h, target, ++seq, { ...right, jump: true });
  assert.equal(target.attachment().y, 0);
  assert.equal(target.attachment().motion.grounded, true);
  assert.equal(target.attachment().motion.jumpHeld, true);
  await applyAndCheck(h, target, ++seq, { ...right, jump: true });
  assert.equal(target.attachment().y, 0, 'a held jump cannot become an extra jump during transfer or after landing');
  await applyAndCheck(h, target, ++seq, right, 1);
  await applyAndCheck(h, target, ++seq, { ...right, jump: true }, 1);
  assert.ok(target.attachment().y > 0, 'a new legitimate jump edge remains available after the handoff');
  assertOneOwner(h, uid, '5,4');
  assertIsolated(h);
});

for (const when of ['before', 'after']) {
  test(`actual generated coin pickup immediately ${when} a Zone crossing remains atomic, global and on a 60-second cooldown`, async t => {
    const h = fixture(t), uid = `synthetic-coin-${when}-zone-crossing`;
    const from = when === 'before' ? '4,4' : '4,3', to = when === 'before' ? '4,3' : '4,4';
    const source = await admitted(h, uid, from, { continuousHandoff: true });
    const observers = await Promise.all([from, to].map(zone => admitted(h, `synthetic-observer-${when}-${zone}`, zone)));
    const room = h.room(), coin = room.coinSnapshot()[125];
    assert.ok(coin.z > -150 && coin.z < -148, 'the actual seeded coin is adjacent to the tested boundary');
    h.place(source, { x: coin.x, y: 0, z: when === 'before' ? coin.z + 1.5 : -151.5, r: 0 });
    const input = { ...forward, z: when === 'before' ? -1 : 1 };
    const collect = { type: 'collect', id: coin.id, requestId: `synthetic-pickup-${when}-boundary` };
    let seq = 0, collectedAt;
    if (when === 'before') {
      await applyAndCheck(h, source, seq, input, 1);
      assert.equal(source.attachment().handoffPending, null);
      await source.send(collect);
      collectedAt = h.now();
      assert.equal(last(source, 'coin_collect_result').collected, true);
      await applyAndCheck(h, source, ++seq, input);
    } else {
      await applyAndCheck(h, source, seq, input);
    }
    const ticket = last(source, 'zone_change');
    assert.equal(ticket?.zone, to);
    const target = await admitted(h, uid, to, { handoffToken: ticket.handoffToken, continuousHandoff: true });
    const latest = source.attachment();
    await target.send({ type: 'handoff_resume' });
    assert.deepEqual(pose(target.attachment()), pose(latest));
    assertOneOwner(h, uid, to, [from, to]);
    if (when === 'after') {
      assert.ok(Math.hypot(target.attachment().x - coin.x, target.attachment().z - coin.z) < 2.35,
        'the target authoritative state is at the real rendered coin without a placement during transfer');
      await target.send(collect);
      collectedAt = h.now();
      assert.equal(last(target, 'coin_collect_result').collected, true);
    } else {
      assert.equal(last(target, 'coin_state').coins[coin.id].respawnAt, collectedAt + 60_000,
        'the target receives the collection that occurred before target ownership');
    }
    assert.equal(room.economy.score(uid), 1);
    assert.equal(room.sql.exec('SELECT COUNT(*) AS n FROM voxel_economy_actions WHERE uid=? AND kind=?', uid, 'coin').toArray()[0].n, 1);
    for (const observer of observers) assert.ok(observer.messages('coin_collected').some(event =>
      event.id === coin.id && event.respawnAt === collectedAt + 60_000), 'both Zone observers receive the authoritative coin removal');
    assert.equal(room.coinSnapshot().length, 200);
    assert.equal(room.coinSnapshot()[coin.id].respawnAt, collectedAt + 60_000);
    await h.advance(150);
    await target.send(collect);
    assert.equal(room.economy.score(uid), 1, 'a successful request replay across ownership cannot award twice');
    await h.advance(collectedAt + 59_999 - h.now());
    assert.equal(room.coinSnapshot()[coin.id].respawnAt > h.now(), true);
    await h.advance(1);
    assert.equal(room.coinSnapshot()[coin.id].respawnAt <= h.now(), true, 'the shared coin is available precisely after 60 seconds');
    assert.equal(room.coinSnapshot().length, 200);
    assertIsolated(h);
  });
}

test('expired continuous tickets fail closed without accepting movement or surrendering authority', async t => {
  const h = fixture(t), uid = 'synthetic-expired-continuous-ticket';
  const { source, ticket } = await continuousCrossing(h, uid);
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  const before = source.attachment(), oldOwner = session(h, uid).owner;
  await h.advance(ticket.expiresAt - h.now() + 1);
  await source.send(framePacket(2, right));
  assert.equal(source.client.closed, true);
  assert.deepEqual(pose(source.attachment()), pose(before));
  assert.deepEqual(source.attachment().motion, before.motion);
  await target.send({ type: 'handoff_resume' });
  assert.equal(target.messages('handoff_resumed').length, 0);
  assert.equal(target.client.closed, true);
  assert.equal(session(h, uid).owner, oldOwner);
  assert.equal(h.zone('4,4').count() + h.zone('5,4').count(), 0, 'no expired/provisional transport becomes a duplicate owner');
  assertIsolated(h);
});

test('public routes and malformed opt-in cannot manufacture a private handoff snapshot', async t => {
  const h = fixture(t), uid = 'synthetic-public-continuity-fence';
  const source = await admitted(h, uid, '4,4', { continuousHandoff: true });
  const before = plain(session(h, uid));
  for (const path of ['/_internal/staging-handoff-seal', '/_internal/staging-handoff-unseal']) {
    const response = await h.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, sessionId: before.session_id, x: 500, z: 500, motion: { credit: .5 } }) });
    assert.equal(response.status, 404);
  }
  const wrongSchema = await authenticate(h, 'synthetic-invalid-handoff-mode', '4,4', { continuousHandoff: 'true' });
  assert.equal(wrongSchema.messages('welcome').length, 0);
  assert.deepEqual(plain(session(h, uid)), before);
  assert.equal(source.client.closed, false);
  assertOneOwner(h, uid, '4,4');
  assertIsolated(h);
});

test('a rejected cutover before CAS unseals the owning source without rolling back movement or creating extra time', async t => {
  const h = fixture(t), uid = 'synthetic-rejected-zone-cutover';
  const { source, ticket } = await continuousCrossing(h, uid);
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  await applyAndCheck(h, source, 2, right);
  const before = source.attachment();
  const get = h.env.ROOM.getByName;
  let rejected = false;
  h.env.ROOM.getByName = name => {
    const stub = get(name);
    return { async fetch(request) {
      if (!rejected && new URL(request.url).pathname === '/_internal/staging-handoff-commit') {
        rejected = true;
        return Response.json({ ok: false, error: 'Synthetic unavailable commit' }, { status: 503 });
      }
      return stub.fetch(request);
    } };
  };
  await target.send({ type: 'handoff_resume' });
  assert.equal(rejected, true);
  assert.equal(target.messages('handoff_resumed').length, 0);
  assert.equal(target.client.closed, true);
  assert.equal(source.client.closed, false);
  assert.equal(source.attachment().handoffPending.sealed, false);
  assert.deepEqual(pose(source.attachment()), pose(before));
  assert.deepEqual(source.attachment().motion, before.motion);
  assertOneOwner(h, uid, '4,4');
  await source.send(framePacket(3, right, 5));
  assert.deepEqual(pose(source.attachment()), pose(before), 'failed cutover does not provide another movement budget at the same clock');
  assert.equal(source.attachment().motion.credit, 0);
  await applyAndCheck(h, source, 4, { ...forward, jump: true });
  assert.ok(source.attachment().y > 0, 'new valid input remains available after unseal');
  assertOneOwner(h, uid, '4,4');
  assertIsolated(h);
});

test('a lost response after committed CAS cannot unseal a stale source or create a second authority', async t => {
  const h = fixture(t), uid = 'synthetic-ambiguous-committed-cutover';
  const { source, ticket } = await continuousCrossing(h, uid);
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  await applyAndCheck(h, source, 2, right);
  const before = source.attachment(), get = h.env.ROOM.getByName;
  let lost = false;
  h.env.ROOM.getByName = name => {
    const stub = get(name);
    return { async fetch(request) {
      const response = await stub.fetch(request);
      if (!lost && new URL(request.url).pathname === '/_internal/staging-handoff-commit') {
        lost = true;
        assert.equal(response.ok, true, 'the authority commits before the simulated transport loss');
        throw Error('Synthetic committed response transport loss');
      }
      return response;
    } };
  };
  await target.send({ type: 'handoff_resume' });
  assert.equal(lost, true);
  assert.equal(session(h, uid).owner, 'zone:5,4');
  assert.deepEqual(pose(session(h, uid)), pose(before));
  assert.equal(target.messages('handoff_resumed').length, 0);
  assert.equal(target.client.closed, true);
  assert.equal(source.attachment().handoffPending.sealed, true, 'ownership validation prevents ambiguous rollback from reactivating the source');
  assert.equal(h.zone('4,4').count() + h.zone('5,4').count(), 0, 'the ambiguous transport failure stops gameplay safely');
  const row = plain(session(h, uid));
  await source.send(framePacket(3, right, 5));
  assert.equal(last(source, 'move').applied, false);
  assert.equal(last(source, 'move').ack, 2);
  assert.deepEqual(pose(source.attachment()), pose(before));
  assert.deepEqual(plain(session(h, uid)), row, 'a sealed predecessor cannot checkpoint over its committed successor');
  await h.advance(1000);
  assert.equal(source.client.closed, true, 'the coordinator durably retries the sealed-source eviction');
  assert.equal(session(h, uid).owner, 'zone:5,4');
  assertIsolated(h);
});

test('a target that expires while the seal response is delayed cannot acquire authority', async t => {
  const h = fixture(t), uid = 'synthetic-target-expired-before-commit';
  const { source, ticket } = await continuousCrossing(h, uid);
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  const get = h.env.ZONE.getByName;
  let held = false;
  h.env.ZONE.getByName = name => {
    const stub = get(name);
    return { async fetch(request) {
      const response = await stub.fetch(request);
      if (!held && new URL(request.url).pathname === '/_internal/staging-handoff-seal') {
        held = true;
        entered();
        await blocked;
      }
      return response;
    } };
  };
  const pending = target.send({ type: 'handoff_resume' });
  try {
    await seen;
    assert.equal(source.attachment().handoffPending.sealed, true);
    await h.advance(9001);
    assert.equal(target.messages('handoff_resumed').length, 0);
  } finally {
    release();
    await pending;
  }
  assert.equal(target.client.closed, true);
  assert.equal(target.messages('handoff_resumed').length, 0);
  assert.equal(source.client.closed, false);
  assert.equal(source.attachment().handoffPending.sealed, false);
  assertOneOwner(h, uid, '4,4');
  await source.send(framePacket(2, right, 5));
  assert.equal(last(source, 'move').applied, true);
  assert.ok(source.attachment().x - ticket.position.x <= MOVEMENT.speed * .5 + 1e-9,
    'long expired target latency still cannot bypass the half-second authoritative time cap');
  assertOneOwner(h, uid, '4,4');
  assertIsolated(h);
});

test('a delayed old-source eviction cannot revoke a rapid returning owner with the same durable session', async t => {
  const h = fixture(t), uid = 'synthetic-delayed-source-eviction-return';
  const { source, ticket } = await continuousCrossing(h, uid);
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { entered = resolve; });
  const get = h.env.ZONE.getByName;
  let held = false;
  h.env.ZONE.getByName = name => {
    const stub = get(name);
    return { async fetch(request) {
      if (!held && name === 'free-zone-4,4' && new URL(request.url).pathname === '/_internal/session-revoke') {
        const body = await request.clone().json();
        if (body.handoffToken === ticket.handoffToken) {
          held = true;
          entered();
          await blocked;
        }
      }
      return stub.fetch(request);
    } };
  };
  const sendRaw = (connection, packet) => connection.instance.webSocketMessage(connection.server, JSON.stringify(packet));
  let returned;
  try {
    await sendRaw(target, { type: 'handoff_resume' });
    await seen;
    assert.equal(source.client.closed, false, 'the intentionally delayed predecessor transport is still open');
    assert.equal(source.attachment().handoffPending.sealed, true);
    assertOneOwner(h, uid, '5,4');
    // Raw transports allow the deliberately pending background eviction to
    // coexist with genuine target inputs; the normal helper drains waitUntil.
    let seq = 1;
    for (let batch = 0; batch < 4 && !last(target, 'zone_change'); batch++) {
      await h.advance(200);
      await sendRaw(target, framePacket(++seq, { ...right, x: -1 }));
      assert.equal(last(target, 'move').ack, seq);
      assertOneOwner(h, uid, '5,4');
    }
    const returnTicket = last(target, 'zone_change');
    assert.equal(returnTicket?.zone, '4,4');
    returned = await h.open('/play?zone=4,4');
    await sendRaw(returned, { type: 'auth', protocol: 6, token: h.token(uid),
      handoffToken: returnTicket.handoffToken, continuousHandoff: true });
    assert.ok(last(returned, 'welcome'));
    await sendRaw(returned, { type: 'handoff_resume' });
    assert.equal(last(returned, 'handoff_resumed').ack, seq);
    assert.equal(returned.attachment().sessionId, source.attachment().sessionId);
    assertOneOwner(h, uid, '4,4');
  } finally {
    release();
    await h.settle();
  }
  assert.equal(source.client.closed, true, 'the old ticket-scoped eviction still retires its matching predecessor');
  assert.equal(target.client.closed, true);
  assert.equal(returned.client.closed, false, 'the returning source-zone transport survives the old eviction');
  assertOneOwner(h, uid, '4,4');
  await applyAndCheck(h, returned, returned.attachment().motion.seq + 1, { ...right, x: -1 });
  assertOneOwner(h, uid, '4,4');
  assertIsolated(h);
});

test('an excessively delayed target cannot leave its source owning a nonadjacent map region', async t => {
  const h = fixture(t), uid = 'synthetic-delayed-target-adjacency-fence';
  const { source, ticket } = await continuousCrossing(h, uid);
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
  let seq = 1, accepted = 0;
  for (let batch = 0; batch < 40 && !source.client.closed; batch++) {
    await h.advance(200);
    await source.send(framePacket(++seq, right));
    if (!source.client.closed) {
      accepted++;
      assert.equal(last(source, 'move').ack, seq);
      assertOneOwner(h, uid, '4,4');
    }
  }
  assert.ok(accepted >= 30, 'the fence is reached by sustained legitimate server simulation, not by forged coordinates');
  assert.equal(source.client.closed, true);
  assert.equal(last(source, 'handoff_error').message, 'Zone transition exceeded adjacent ownership');
  assert.equal(last(source, 'move').ack, seq - 1, 'the nonadjacent movement is not acknowledged as valid ownership');
  assert.ok(Number(session(h, uid).lease_expires) <= h.now(), 'the abandoned source authority is durably released');
  await target.send({ type: 'handoff_resume' });
  assert.equal(target.messages('handoff_resumed').length, 0);
  assert.equal(target.client.closed, true);
  assert.equal(h.zone('4,4').count() + h.zone('5,4').count() + h.zone('6,4').count(), 0);
  assertIsolated(h);
});

for (const cancellation of ['explicit', 'route reversal']) {
  test(`${cancellation} continuous cancellation preserves elapsed server time backing unacknowledged movement without refunding old credit`, async t => {
    const h = fixture(t), uid = `synthetic-cancel-unacknowledged-${cancellation.replaceAll(' ', '-')}`;
    const { source, ticket } = await continuousCrossing(h, uid);
    const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken, continuousHandoff: true });
    const left = { ...right, x: -1 };
    await applyAndCheck(h, source, 2, left);
    await applyAndCheck(h, source, 3, left);
    assert.ok(source.attachment().x < 0, 'real turning input returns to the source side before cancellation');
    await h.advance(300);
    await source.send(framePacket(4, left, 1, 0));
    const before = source.attachment();
    assert.ok(Math.abs(before.motion.credit - .3) < 1e-9, 'the source has retained old legitimate credit that cancellation must discard');
    // These are genuine newly generated client frames. The source has not
    // received them yet when cancellation completes, so no server handler has
    // integrated the next 100 ms or acknowledged its movement sequence.
    const queued = framePacket(5, left, 1);
    await h.advance(100);
    if (cancellation === 'explicit') {
      await source.send({ type: 'handoff_cancel' });
      assert.equal(last(source, 'handoff_cancelled').nextSequence, queued.seq);
      assert.equal(last(source, 'handoff_cancelled').movement.lastSeq, before.motion.seq);
    } else {
      await target.send({ type: 'handoff_resume' });
      assert.equal(last(target, 'handoff_resume_error').cancelledToSource, true);
      assert.equal(last(target, 'handoff_resume_error').ack, before.motion.seq);
    }
    const cancelled = source.attachment();
    assert.deepEqual(pose(cancelled), pose(before), 'cancellation cannot integrate or rewind the unsent input');
    assert.equal(cancelled.motion.clock, before.motion.clock,
      'cancellation is not a simulation step and cannot consume the elapsed interval backing unsent frames');
    assert.equal(h.now() - cancelled.motion.clock, 100);
    assert.equal(cancelled.motion.credit, 0, 'stored credit is dropped rather than refunded');
    assert.equal(cancelled.motion.seq, before.motion.seq);
    assert.equal(cancelled.handoffPending, null);
    assertOneOwner(h, uid, '4,4');

    const expected = integrateMovement({ ...before, ...before.motion }, left, .1,
      { speed: MOVEMENT.speed, obstacles: [...SERVER_WORLD.buildings, ...SERVER_WORLD.trees], bounds: MOVEMENT.bounds });
    await source.send(queued);
    const accepted = source.attachment();
    assert.deepEqual(pose(accepted), pose(expected), 'all newly elapsed authoritative input is accepted after cancellation');
    assert.equal(last(source, 'move').ack, queued.seq);
    assert.equal(accepted.motion.clock, h.now());
    assert.equal(accepted.motion.credit, 0, 'only the new 100 ms is spent; discarded 300 ms never reappears');
    const row = plain(session(h, uid));
    await source.send(queued);
    assert.deepEqual(pose(source.attachment()), pose(accepted), 'replayed unacknowledged frames cannot be integrated twice');
    assert.deepEqual(plain(session(h, uid)), row);
    await source.send(framePacket(6, left, 1));
    assert.deepEqual(pose(source.attachment()), pose(accepted), 'a new sequence cannot spend the same elapsed interval twice');
    assert.equal(source.attachment().motion.credit, 0);
    assertOneOwner(h, uid, '4,4');
    assertIsolated(h);
  });
}

for (const restartCoordinator of [false, true]) {
  test(`staging reconnect after committed continuous handoff preserves destination checkpoint (restart=${restartCoordinator})`, async t => {
    const h = fixture(t), uid = `synthetic-cutover-reconnect-${restartCoordinator}`;
    const { source, ticket } = await continuousCrossing(h, uid);
    const originalId = source.attachment().id;
    const target = await admitted(h, uid, '5,4', {
      handoffToken: ticket.handoffToken, continuousHandoff: true
    });
    await target.send({ type: 'handoff_resume' });
    assert.ok(last(target, 'handoff_resumed'));
    assertOneOwner(h, uid, '5,4');
    const saved = pose(target.attachment());
    const priorSession = target.attachment().sessionId;
    const savedRevision = session(h, uid).save_revision;
    await target.close();
    await h.advance(120001);
    if (restartCoordinator) {
      h.restartRoom();
      await h.room().ready;
    }
    const before = session(h, uid);
    const wrongZone = await authenticate(h, uid, '4,4', { continuousHandoff: true });
    assert.equal(last(wrongZone, 'auth_error')?.resumeZone, '5,4');
    assert.equal(wrongZone.messages('welcome').length, 0);
    assert.deepEqual(session(h, uid), before, 'old-zone reconnect must not overwrite the destination checkpoint');
    const restored = await admitted(h, uid, '5,4', { continuousHandoff: true });
    assert.equal(restored.attachment().id, originalId);
    assert.notEqual(restored.attachment().sessionId, priorSession);
    assert.deepEqual(pose(restored.attachment()), saved);
    assert.equal(session(h, uid).save_revision, savedRevision);
    assertOneOwner(h, uid, '5,4');
    const current = session(h, uid);
    const replay = await authenticate(h, uid, '5,4', {
      handoffToken: ticket.handoffToken, continuousHandoff: true
    });
    assert.equal(replay.messages('welcome').length, 0);
    assert.equal(replay.client.closed, true);
    assert.deepEqual(session(h, uid), current, 'a consumed predecessor ticket cannot replace the reconnected owner');
    assert.equal(restored.client.closed, false);
    assertOneOwner(h, uid, '5,4');
    assertIsolated(h);
  });
}
