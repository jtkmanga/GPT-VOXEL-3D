'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

const BOX_RESPAWN = 14_400_000, CLAIM = 90_000;
const last = (connection, type) => connection.messages(type).at(-1);
const row = h => h.room().sql.exec('SELECT * FROM voxel_lucky_box WHERE id=1').toArray()[0];
const contact = box => ({ x: box.x, y: 0, z: box.z, r: 0 });
const plain = value => JSON.parse(JSON.stringify(value));
function harness(t) { const h = createHarness(); t.after(() => h.close()); return h; }
async function auth(h, uid, zone) {
  const connection = await h.open(zone ? `/play?zone=${zone}` : '/play');
  await connection.send({ type: 'auth', protocol: zone ? 6 : 4, token: h.token(uid) });
  assert.equal(connection.client.closed, false);
  assert.ok(last(connection, 'welcome'));
  return connection;
}
async function claim(h, player, requestId) {
  h.place(player, contact(h.room().boxSnapshot()));
  await player.send({ type: 'collect_box', requestId });
  assert.ok(last(player, 'box_spin_ready'));
}
const actions = h => h.room().sql.exec('SELECT * FROM voxel_economy_actions ORDER BY created_at,action_key').toArray();

test('P8 collection starts one global four-hour cooldown and delayed spin cannot extend it', async t => {
  const h = harness(t), uid = 'synthetic-p8-collection-start';
  let collector = await auth(h, uid);
  const observers = [await auth(h, 'synthetic-p8-collection-observer'), await auth(h, 'synthetic-p8-collection-zone', '4,4')];
  const collectedAt = h.now();
  await claim(h, collector, 'p8-collection-claim');
  const claimed = row(h);
  assert.equal(claimed.next_spawn_at, collectedAt + BOX_RESPAWN);
  assert.equal(claimed.cycle, 1);
  assert.equal(claimed.claim_cycle, 0);
  assert.equal(claimed.claim_expires_at, collectedAt + CLAIM);
  assert.equal(h.room().economy.score(uid), 0);
  for (const observer of [collector, ...observers]) {
    assert.equal(last(observer, 'box_state').box.nextSpawnAt, claimed.next_spawn_at);
    assert.equal(last(observer, 'box_state').box.active, false);
  }
  await h.advance(30_000);
  await collector.close();
  collector = await auth(h, uid);
  assert.equal(last(collector, 'welcome').luckyBox.nextSpawnAt, claimed.next_spawn_at);
  await collector.send({ type: 'collect_box', requestId: 'p8-collection-claim' });
  assert.equal(row(h).next_spawn_at, claimed.next_spawn_at);
  assert.equal(row(h).claim_expires_at, claimed.claim_expires_at);
  await collector.send({ type: 'spin_box', requestId: 'p8-delayed-spin' });
  const reward = last(collector, 'box_reward');
  assert.ok(reward);
  assert.equal(h.room().economy.score(uid), reward.reward);
  assert.equal(row(h).next_spawn_at, collectedAt + BOX_RESPAWN);
  assert.equal(row(h).cycle, 1);
  assert.equal(row(h).claimed_uid, null);
  assert.equal(row(h).claim_cycle, -1);
  assert.equal(actions(h).filter(action => action.kind === 'spin' && action.awarded === 1).length, 1);
  assert.equal(actions(h).find(action => action.kind === 'spin').cycle, 0);
});

test('P8 abandoned claim survives restart, releases spin at 90 seconds and remains hidden until four hours', async t => {
  const h = harness(t), uid = 'synthetic-p8-abandoned-claim';
  let collector = await auth(h, uid);
  await claim(h, collector, 'p8-abandoned-claim');
  const saved = row(h);
  await collector.close();
  await h.advance(20_000);
  h.restartRoom();
  await h.room().ready;
  collector = await auth(h, uid);
  const observers = [await auth(h, 'synthetic-p8-abandon-observer'), await auth(h, 'synthetic-p8-abandon-zone', '4,4')];
  assert.deepEqual(row(h), saved);
  await h.setTime(saved.claim_expires_at - 1);
  assert.equal(h.room().boxSnapshot().claimed, true);
  for (const observer of observers) observer.clear();
  await h.advance(1);
  assert.equal(row(h).claimed_uid, null);
  assert.equal(row(h).next_spawn_at, saved.next_spawn_at);
  assert.equal(row(h).cycle, saved.cycle);
  assert.equal(h.room().boxSnapshot().active, false);
  for (const observer of observers) {
    assert.equal(last(observer, 'box_state').box.active, false);
    assert.equal(last(observer, 'box_state').box.nextSpawnAt, saved.next_spawn_at);
    assert.equal(last(observer, 'box_state').box.claimed, false);
  }
  await collector.send({ type: 'spin_box', requestId: 'p8-expired-spin' });
  await collector.send({ type: 'collect_box', requestId: 'p8-expired-reclaim' });
  assert.equal(collector.messages('box_reward').length, 0);
  assert.equal(h.room().economy.score(uid), 0);
  assert.equal(row(h).next_spawn_at, saved.next_spawn_at);
  h.restartRoom();
  await h.room().ready;
  assert.equal(h.room().boxSnapshot().active, false);
  assert.equal(row(h).next_spawn_at, saved.next_spawn_at);
  await h.setTime(saved.next_spawn_at - 1);
  assert.equal(h.room().boxSnapshot().active, false);
  await h.advance(1);
  assert.equal(h.room().boxSnapshot().active, true);
  assert.equal(h.room().boxSnapshot().cycle, 1);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_lucky_box').toArray()[0].count, 1);
});

test('P8 claim receipt failure rolls back collection cooldown/cycle and exact retry commits once', async t => {
  const h = harness(t), uid = 'synthetic-p8-claim-rollback';
  const collector = await auth(h, uid);
  h.place(collector, contact(h.room().boxSnapshot()));
  const before = row(h), count = actions(h).length;
  h.room().sql.exec(`CREATE TRIGGER p8_claim_receipt_failure BEFORE INSERT ON voxel_economy_actions
    WHEN NEW.kind='claim' BEGIN SELECT RAISE(ABORT,'synthetic P8 claim receipt failure'); END`);
  await collector.send({ type: 'collect_box', requestId: 'p8-rollback-claim' });
  assert.deepEqual(row(h), before);
  assert.equal(actions(h).length, count);
  assert.equal(collector.messages('box_spin_ready').length, 0);
  assert.equal(h.room().economy.score(uid), 0);
  assert.ok(last(collector, 'server_error'));
  h.room().sql.exec('DROP TRIGGER p8_claim_receipt_failure');
  await collector.send({ type: 'collect_box', requestId: 'p8-rollback-claim' });
  assert.ok(last(collector, 'box_spin_ready'));
  assert.equal(row(h).cycle, before.cycle + 1);
  assert.equal(row(h).next_spawn_at, h.now() + BOX_RESPAWN);
  assert.equal(actions(h).filter(action => action.kind === 'claim').length, 1);
});

for (const failure of ['score', 'receipt']) {
  test(`P8 delayed spin ${failure} failure/retry keeps the collection cooldown and rewards only once`, async t => {
    const h = harness(t), uid = `synthetic-p8-delayed-spin-${failure}`;
    let collector = await auth(h, uid);
    await claim(h, collector, `p8-failure-claim-${failure}`);
    const claimed = row(h), priorActions = actions(h).length;
    await h.advance(30_000);
    const table = failure === 'score' ? 'voxel_scores' : 'voxel_economy_actions';
    const event = failure === 'score' ? 'UPDATE' : 'INSERT';
    h.room().sql.exec(`CREATE TRIGGER p8_spin_failure BEFORE ${event} ON ${table}
      BEGIN SELECT RAISE(ABORT,'synthetic P8 spin failure'); END`);
    await collector.send({ type: 'spin_box', requestId: `p8-failed-spin-${failure}` });
    assert.deepEqual(row(h), claimed);
    assert.equal(actions(h).length, priorActions);
    assert.equal(h.room().economy.score(uid), 0);
    assert.equal(collector.messages('box_reward').length, 0);
    assert.ok(last(collector, 'box_error'));
    h.room().sql.exec('DROP TRIGGER p8_spin_failure');
    await collector.send({ type: 'spin_box', requestId: `p8-failed-spin-${failure}` });
    const reward = last(collector, 'box_reward');
    assert.ok(reward);
    assert.equal(row(h).next_spawn_at, claimed.next_spawn_at);
    assert.equal(row(h).cycle, claimed.cycle);
    assert.equal(h.room().economy.score(uid), reward.reward);
    await collector.close();
    h.restartRoom();
    await h.room().ready;
    collector = await auth(h, uid);
    const committed = row(h), count = actions(h).length;
    await collector.send({ type: 'spin_box', requestId: `p8-failed-spin-${failure}` });
    assert.equal(last(collector, 'box_reward').replayed, true);
    assert.deepEqual(row(h), committed);
    assert.equal(actions(h).length, count);
    assert.equal(h.room().economy.score(uid), reward.reward);
  });
}

for (const elapsed of [10_000, 95_000]) {
  test(`P8 additive P5 pending-claim migration preserves collection time after ${elapsed}ms and repeated restart`, async t => {
    const h = harness(t), uid = `synthetic-p8-p5-migration-${elapsed}`;
    await auth(h, uid);
    const oldCycle = 7, collectedAt = h.now() - elapsed, deadline = collectedAt + CLAIM;
    h.room().sql.exec('ALTER TABLE voxel_lucky_box DROP COLUMN claim_cycle');
    h.room().sql.exec('UPDATE voxel_lucky_box SET cycle=?,next_spawn_at=0,claimed_uid=?,claim_expires_at=? WHERE id=1', oldCycle, uid, deadline);
    const claimResponse = { ok: true, claimed: true, box: {}, serverNow: collectedAt };
    h.room().sql.exec(`INSERT INTO voxel_economy_actions
      (action_key,uid,kind,resource_id,cycle,request_id,awarded,response_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, 'p5-claim-receipt', uid, 'claim', 1, oldCycle,
    'string:p5-claim-request', 0, JSON.stringify(claimResponse), collectedAt);
    h.restartRoom();
    await h.room().ready;
    const migrated = row(h);
    assert.equal(migrated.next_spawn_at, collectedAt + BOX_RESPAWN);
    assert.equal(migrated.cycle, oldCycle + 1);
    assert.equal(migrated.claim_cycle, elapsed < CLAIM ? oldCycle : -1);
    assert.equal(migrated.claimed_uid, elapsed < CLAIM ? uid : null);
    const player = await auth(h, uid);
    await player.send({ type: 'collect_box', requestId: 'p5-claim-request' });
    assert.equal(row(h).next_spawn_at, collectedAt + BOX_RESPAWN);
    assert.equal(row(h).cycle, oldCycle + 1);
    assert.equal(h.room().economy.score(uid), 0);
    if (elapsed < CLAIM) {
      assert.ok(last(player, 'box_spin_ready'));
      await player.send({ type: 'spin_box', requestId: 'p8-migrated-spin' });
      assert.ok(last(player, 'box_reward'));
      assert.equal(actions(h).find(action => action.kind === 'spin').cycle, oldCycle);
    } else {
      assert.equal(player.messages('box_spin_ready').length, 0);
      await player.send({ type: 'spin_box', requestId: 'p8-expired-migrated-spin' });
      assert.equal(player.messages('box_reward').length, 0);
    }
    const final = row(h);
    h.restartRoom();
    await h.room().ready;
    assert.deepEqual(row(h), final);
    assert.equal(h.room().boxSnapshot().active, false);
  });
}

test('P8 next spawn avoids current authoritative collector and remains one persisted shared location', async t => {
  const h = harness(t), uid = 'synthetic-p8-spawn-collector';
  let collector = await auth(h, uid);
  await claim(h, collector, 'p8-avoid-player-claim');
  await collector.send({ type: 'spin_box', requestId: 'p8-avoid-player-spin' });
  const nextSpawnAt = row(h).next_spawn_at;
  await h.setTime(nextSpawnAt - 1);
  collector = await auth(h, uid);
  const candidate = h.room().boxSnapshot();
  const player = h.place(collector, contact(candidate));
  const saved = h.room().sessions.checkpoint({ uid, sessionId: player.sessionId, owner: 'room',
    position: contact(candidate), revision: h.room().sessions.row(uid).save_revision + 1 });
  assert.equal(saved.ok, true);
  await h.advance(1);
  const spawned = plain(h.room().boxSnapshot());
  assert.equal(spawned.active, true);
  assert.ok(Math.hypot(spawned.x - player.x, spawned.z - player.z) >= 6);
  const observer = await auth(h, 'synthetic-p8-shared-spawn', '4,4');
  const seen = last(observer, 'welcome').luckyBox;
  for (const key of ['x', 'z', 'cycle', 'nextSpawnAt', 'active']) assert.equal(seen[key], spawned[key]);
  h.restartRoom();
  await h.room().ready;
  const restored = h.room().boxSnapshot();
  assert.equal(restored.x, spawned.x);
  assert.equal(restored.z, spawned.z);
  assert.equal(restored.cycle, spawned.cycle);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_lucky_box').toArray()[0].count, 1);
});


test('P8 contradictory or malformed legacy claim fails closed without renewing or partially rewriting authority', async t => {
  const h = harness(t), room = h.room();
  await room.ready;
  const malformed = [
    { cycle: 4, nextSpawnAt: h.now() + 1000, deadline: h.now() + CLAIM },
    { cycle: 4, nextSpawnAt: 0, deadline: CLAIM - 1 },
    { cycle: -1, nextSpawnAt: 0, deadline: h.now() + CLAIM },
    { cycle: Number.MAX_SAFE_INTEGER, nextSpawnAt: 0, deadline: h.now() + CLAIM },
    { cycle: 4, nextSpawnAt: 0, deadline: h.now() + CLAIM + 1 }
  ];
  for (const state of malformed) {
    room.sql.exec('UPDATE voxel_lucky_box SET cycle=?,next_spawn_at=?,claimed_uid=?,claim_expires_at=?,claim_cycle=-1 WHERE id=1',
      state.cycle, state.nextSpawnAt, 'synthetic-invalid-legacy-owner', state.deadline);
    const before = row(h);
    assert.throws(() => new room.economy.constructor(room.ctx, () => []), /Invalid legacy Lucky Box claim/);
    assert.deepEqual(row(h), before, 'failed migration must preserve the exact original authority row');
    assert.equal(actions(h).length, 0);
  }
});
