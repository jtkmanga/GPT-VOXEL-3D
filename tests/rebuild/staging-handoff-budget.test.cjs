'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, CERTS_URL } = require('./harness.cjs');
const { imported } = require('./staging-client-fixture.cjs');

const right = { x: 1, z: 0, jump: false };
const idle = { x: 0, z: 0, jump: false };
const pose = p => Object.fromEntries(['x', 'y', 'z', 'r'].map(key => [key, p[key]]));
const last = (connection, type) => connection.messages(type).at(-1);
const batch = (seq, count, input = right) => ({ type: 'move', seq, input,
  frames: Array.from({ length: count }, () => ({ input, delta: .1 })) });

function stagingHarness(t) {
  const projectId = 'handoff-staging-fixture';
  const workerName = 'gpt-voxel-3d-staging-handoff-fixture';
  const workerOrigin = `https://${workerName}.invalid`;
  const h = createHarness({ workerOrigin, defaultTokenProject: projectId,
    env: { APP_ENV: 'staging', STAGING_WORKER_NAME: workerName,
      STAGING_WORKER_ORIGIN: workerOrigin, ALLOWED_ORIGIN: workerOrigin,
      FIREBASE_PROJECT_ID: projectId,
      FIREBASE_PUBLIC_CONFIG: JSON.stringify({ apiKey: 'synthetic-public-staging-key',
        projectId, authDomain: `${projectId}.firebaseapp.com`, appId: '1:123456:web:abcdef123456' }),
      STAGING_AUTH_MODE: 'popup', PAYMENT_MODE: 'provider-neutral-test',
      PAYMENT_WEBHOOK_SECRET: undefined, SLIP2GO_API_SECRET: undefined } });
  t.after(() => h.close());
  return h;
}

async function earnedCredit(h, connection) {
  const before = pose(connection.attachment());
  assert.equal(Number(connection.attachment().motion.credit) || 0, 0);
  await h.advance(500);
  await connection.send({ type: 'move', seq: 0, input: idle,
    frames: [{ input: idle, delta: 0 }] });
  assert.deepEqual(pose(connection.attachment()), before);
  assert.equal(connection.attachment().motion.credit, .5,
    'the actual owning ZoneRoom earns the bounded budget from server time');
}

for (const intervals of [1, 5]) {
  test(`staging handoff cancellation cannot refund credit after ${intervals * 100}ms of authoritative movement`, async t => {
    const h = stagingHarness(t);
    const source = await h.connect({ uid: `synthetic-staging-handoff-budget-${intervals}`, zone: '4,4' });
    assert.ok(last(source, 'welcome'));
    // Only the initial trusted boundary fixture is placed. All subsequent
    // movement, crossing, cancellation and replay use actual socket handlers.
    h.place(source, { x: -.1, y: 0, z: -75, r: 0 });
    const initial = pose(source.attachment());
    await earnedCredit(h, source);
    const bankedAt = h.now();
    await source.send(batch(1, intervals));
    const crossing = source.attachment();
    assert.equal(h.now(), bankedAt, 'the crossing spends previously earned time');
    assert.ok(crossing.x > 0);
    assert.equal(last(source, 'zone_change').zone, '5,4');
    assert.ok(last(source, 'zone_change').handoffToken);
    assert.ok(Math.abs(crossing.motion.credit - (.5 - intervals * .1)) < 1e-9);
    assert.equal(crossing.handoffPending.source.motion.credit, .5,
      'the saved rollback snapshot contains the pre-crossing budget');

    await source.send({ type: 'handoff_cancel', seq: 2 });
    const cancelled = source.attachment();
    assert.deepEqual(pose(cancelled), initial);
    assert.equal(cancelled.motion.credit, 0, 'rollback never restores the saved budget');
    assert.equal(cancelled.motion.clock, bankedAt);
    assert.equal(cancelled.handoffPending, null);
    assert.equal(cancelled.lastSequence, 2);
    assert.equal(last(source, 'handoff_cancelled').nextSequence, 3);
    assert.equal(h.room().sessions.row(cancelled.uid).owner, 'zone:4,4');

    const acks = source.messages('move').length;
    await source.send(batch(1, 5));
    assert.deepEqual(pose(source.attachment()), initial);
    assert.equal(source.attachment().motion.credit, 0);
    assert.equal(source.attachment().lastSequence, 2);
    assert.equal(source.messages('move').length, acks,
      'the global sequence fence rejects the old crossing despite motion rollback');

    const tickets = source.messages('zone_change').length;
    await source.send(batch(3, 5));
    assert.equal(last(source, 'move').ack, 3);
    assert.deepEqual(pose(source.attachment()), initial,
      'a fresh sequence at the same server clock cannot spend refunded time');
    assert.equal(source.attachment().motion.credit, 0);
    assert.equal(source.attachment().handoffPending, null);
    assert.equal(source.messages('zone_change').length, tickets);

    await h.advance(200);
    await source.send(batch(4, 2));
    assert.ok(source.attachment().x > 0, 'new server elapsed time permits legitimate movement');
    assert.ok(source.attachment().x - initial.x <= 22 * .2 + 1e-9);
    assert.equal(source.messages('zone_change').length, tickets + 1);
    const accepted = pose(source.attachment());
    const currentSequence = source.attachment().lastSequence;
    await source.send(batch(3, 5));
    assert.deepEqual(pose(source.attachment()), accepted);
    assert.equal(source.attachment().lastSequence, currentSequence);
    assert.equal(source.client.closed, false);
    assert.ok(h.records.fetches.every(entry => entry.url === CERTS_URL),
      'only the isolated synthetic identity certificate fixture is contacted');
  });
}

test('staging pickup survives cancellation without granting a second movement budget', async t => {
  const h = stagingHarness(t);
  const { integrateMovement } = await imported('shared/movement.mjs');
  const { SERVER_WORLD } = await imported('worker/world.mjs');
  const obstacles = [...SERVER_WORLD.buildings, ...SERVER_WORLD.trees];
  let fixture;
  for (const coin of h.room().coinSnapshot()) {
    const column = Math.floor((coin.x + 750) / 150);
    if (column < 1 || column > 9) continue;
    const start = { x: column * 150 - 750 - .1, y: 0, z: coin.z, r: 0,
      vx: 0, vz: 0, vy: 0, jumpHeld: false, grounded: true };
    let predicted = start;
    for (let index = 0; index < 5; index++) {
      predicted = integrateMovement(predicted, right, .1, { speed: 22, obstacles, bounds: 748 });
    }
    if (predicted.x > column * 150 - 750 &&
        Math.hypot(predicted.x - coin.x, predicted.z - coin.z) < 2.2 &&
        Math.hypot(start.x - coin.x, start.z - coin.z) > 2.35) {
      fixture = { coin, start: pose(start), zone: `${column - 1},${Math.floor((coin.z + 750) / 150)}` };
      break;
    }
  }
  assert.ok(fixture, 'an actual generated coin lies along an unobstructed boundary approach');
  const source = await h.connect({ uid: 'synthetic-staging-handoff-pickup', zone: fixture.zone });
  h.place(source, fixture.start);
  await earnedCredit(h, source);
  await source.send(batch(1, 5));
  assert.ok(last(source, 'zone_change').handoffToken);
  await source.send({ type: 'collect', id: fixture.coin.id, requestId: 'synthetic-handoff-pickup' });
  assert.equal(last(source, 'coin_collect_result').collected, true);
  assert.equal(h.room().economy.score(source.attachment().uid), 1);
  const cooldown = h.room().coinSnapshot()[fixture.coin.id].respawnAt;

  await source.send({ type: 'handoff_cancel', seq: 2 });
  assert.deepEqual(pose(source.attachment()), fixture.start);
  assert.equal(source.attachment().motion.credit, 0);
  await source.send(batch(3, 5));
  assert.deepEqual(pose(source.attachment()), fixture.start,
    'a persisted crossing pickup cannot be followed by reused crossing time');
  assert.equal(source.attachment().handoffPending, null);
  assert.equal(h.room().economy.score(source.attachment().uid), 1);
  assert.equal(h.room().coinSnapshot()[fixture.coin.id].respawnAt, cooldown);
});
