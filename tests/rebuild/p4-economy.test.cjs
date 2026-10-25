'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

// Every economy transition below runs through the actual Worker and real
// SQLite. Trusted setup selects a resource contact point; it never replaces
// collection, session validation, score persistence or transaction handling.
const COIN_RESPAWN = 60_000;
const BOX_RESPAWN = 4 * 60 * 60 * 1000;
const last = (connection, type) => connection.messages(type).at(-1);
const plain = value => JSON.parse(JSON.stringify(value));
const zoneAt = ({ x, z }) => `${Math.min(9, Math.max(0, Math.floor((x + 750) / 150)))},${Math.min(9, Math.max(0, Math.floor((z + 750) / 150)))}`;
const contact = resource => ({ x: resource.x, y: 0, z: resource.z, r: 0 });

function harness(t) {
  const h = createHarness();
  t.after(() => h.close());
  return h;
}

async function authenticate(h, uid, zone, resumeToken) {
  const connection = await h.open(zone ? `/play?zone=${encodeURIComponent(zone)}` : '/play');
  await connection.send({ type: 'auth', token: h.token(uid), name: 'P4 test player', protocol: zone ? 6 : 4,
    ...(resumeToken ? { resumeToken } : {}) });
  assert.equal(connection.client.closed, false);
  assert.ok(last(connection, 'welcome'), 'actual token verification and session admission must succeed');
  return connection;
}

const score = (h, uid) => Number(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0]?.score || 0);
const actionCount = h => h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_economy_actions').toArray()[0].count;
const coinRow = (h, id) => h.room().sql.exec('SELECT * FROM voxel_coins WHERE id=?', id).toArray()[0] || null;
const boxRow = h => h.room().sql.exec('SELECT * FROM voxel_lucky_box WHERE id=1').toArray()[0];

async function reconnect(h, connection, uid, zone) {
  const resumeToken = last(connection, 'welcome').session.resumeToken;
  await connection.close();
  return authenticate(h, uid, zone, resumeToken);
}

function failSQL(h, table, event, name) {
  // SQLite itself aborts the transaction. No server method is stubbed and the
  // failure remains visible through the existing server_error/box_error wire.
  h.room().sql.exec(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
    BEGIN SELECT RAISE(ABORT,'synthetic P4 SQLite write failure'); END`);
}

test('P4 one logical server exposes exactly 200 coin identities and one Lucky Box to room and zones', async t => {
  const h = harness(t);
  const players = [];
  for (const [index, zone] of [undefined, '0,0', '4,4', '9,9'].entries())
    players.push(await authenticate(h, `synthetic-p4-inventory-${index}`, zone));
  const baseline = last(players[0], 'welcome');
  assert.equal(baseline.coins.length, 200);
  assert.equal(new Set(baseline.coins.map(coin => coin.id)).size, 200);
  for (const player of players.slice(1)) {
    assert.deepEqual(last(player, 'welcome').coins, baseline.coins);
    for (const key of ['x', 'z', 'cycle', 'nextSpawnAt', 'active'])
      assert.equal(last(player, 'welcome').luckyBox[key], baseline.luckyBox[key]);
  }
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_lucky_box').toArray()[0].count, 1);
  for (const zone of ['0,0', '4,4', '9,9']) {
    const duplicated = h.zone(zone).ctx.storage.sql.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('voxel_coins','voxel_lucky_box','voxel_scores')"
    ).toArray();
    assert.deepEqual(duplicated, [], 'zone routing must not create independent economy stores');
  }
});

test('P4 simultaneous collectors in one zone receive only one persisted coin reward', async t => {
  const h = harness(t);
  const coin = h.room().coinSnapshot()[0];
  const zone = zoneAt(coin);
  const a = await authenticate(h, 'synthetic-p4-same-zone-a', zone);
  const b = await authenticate(h, 'synthetic-p4-same-zone-b', zone);
  for (const player of [a, b]) { h.place(player, contact(coin)); player.clear(); }
  const results = await Promise.allSettled([
    a.send({ type: 'collect', id: coin.id, requestId: 'synthetic-same-zone-a' }),
    b.send({ type: 'collect', id: coin.id, requestId: 'synthetic-same-zone-b' })
  ]);
  assert.ok(results.every(result => result.status === 'fulfilled'));
  assert.equal(score(h, 'synthetic-p4-same-zone-a') + score(h, 'synthetic-p4-same-zone-b'), 1);
  assert.equal([a, b].flatMap(player => player.messages('coin_collect_result')).filter(message => message.collected).length, 1);
  assert.equal(coinRow(h, coin.id).cycle, 1);
  assert.equal(coinRow(h, coin.id).respawn_at, h.now() + COIN_RESPAWN);
  assert.equal(h.room().coinSnapshot().length, 200);
  for (const player of [a, b]) assert.ok(player.messages('coin_collected').some(message => message.id === coin.id));
});

test('P4 cross-zone and room contenders share the same atomic coin cycle', async t => {
  const h = harness(t);
  let fixture;
  for (const coin of h.room().coinSnapshot()) {
    const boundary = Math.round((coin.x + 750) / 150) * 150 - 750;
    if (boundary > -750 && boundary < 750 && Math.abs(coin.x - boundary) < 1.8) {
      fixture = { coin, west: { ...contact(coin), x: boundary - 0.1 }, east: { ...contact(coin), x: boundary + 0.1 } };
      break;
    }
  }
  assert.ok(fixture, 'the actual seeded world must supply a collectable coin near a zone boundary');
  const { coin, west, east } = fixture;
  assert.notEqual(zoneAt(west), zoneAt(east));
  const entries = [
    { uid: 'synthetic-p4-boundary-west', zone: zoneAt(west), position: west },
    { uid: 'synthetic-p4-boundary-east', zone: zoneAt(east), position: east },
    { uid: 'synthetic-p4-boundary-room', position: contact(coin) }
  ];
  for (const entry of entries) {
    entry.player = await authenticate(h, entry.uid, entry.zone);
    h.place(entry.player, entry.position);
    entry.player.clear();
  }
  await Promise.all(entries.map((entry, index) => entry.player.send({ type: 'collect', id: coin.id, requestId: `synthetic-boundary-${index}` })));
  assert.equal(entries.reduce((total, entry) => total + score(h, entry.uid), 0), 1);
  assert.equal(coinRow(h, coin.id).cycle, 1);
  assert.equal(coinRow(h, coin.id).respawn_at, h.now() + COIN_RESPAWN);
  for (const entry of entries) assert.ok(entry.player.messages('coin_collected').some(message => message.id === coin.id));
});

for (const collectorKind of ['room', 'zone']) {
  test(`P4 a ${collectorKind} coin collection disappears for connected room and zone observers`, async t => {
    const h = harness(t);
    const coin = h.room().coinSnapshot()[7];
    const zone = zoneAt(coin);
    const collector = await authenticate(h, `synthetic-p4-fanout-${collectorKind}`, collectorKind === 'zone' ? zone : undefined);
    const roomObserver = await authenticate(h, `synthetic-p4-fanout-${collectorKind}-room`);
    const zoneObserver = await authenticate(h, `synthetic-p4-fanout-${collectorKind}-zone`, zone);
    for (const player of [collector, roomObserver, zoneObserver]) { h.place(player, contact(coin)); player.clear(); }
    await collector.send({ type: 'collect', id: coin.id });
    const persisted = coinRow(h, coin.id);
    assert.equal(score(h, `synthetic-p4-fanout-${collectorKind}`), 1);
    for (const player of [roomObserver, zoneObserver]) {
      const event = player.messages('coin_collected').find(message => message.id === coin.id);
      assert.ok(event, 'every observer that can see the coin receives its authoritative disappearance');
      assert.equal(event.respawnAt, persisted.respawn_at);
      assert.equal(event.cycle, persisted.cycle);
      assert.ok(last(player, 'leaderboard').top.some(row => row.score === 1));
    }
  });
}

test('P4 concurrent independent coin claims update only their own slots and preserve the logical cap', async t => {
  const h = harness(t);
  const baseline = plain(h.room().coinSnapshot());
  const entries = [];
  for (let index = 0; index < 8; index++) {
    const coin = baseline[index];
    const uid = `synthetic-p4-independent-${index}`;
    const player = await authenticate(h, uid, index % 2 ? zoneAt(coin) : undefined);
    h.place(player, contact(coin));
    entries.push({ player, coin, uid });
  }
  await Promise.all(entries.map(({ player, coin }, index) => player.send({ type: 'collect', id: coin.id, requestId: `synthetic-independent-${index}` })));
  assert.equal(entries.reduce((total, entry) => total + score(h, entry.uid), 0), 8);
  const after = h.room().coinSnapshot();
  assert.equal(after.length, 200);
  assert.equal(after.filter(coin => coin.respawnAt > h.now()).length, 8);
  assert.deepEqual(plain(after.slice(8)), baseline.slice(8));
});

test('P4 a coin request replay remains idempotent after reconnect and the next 60-second cycle', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-durable-coin';
  let player = await authenticate(h, uid, '4,4');
  const original = h.room().coinSnapshot()[2];
  h.place(player, contact(original));
  const requestId = 'synthetic-durable-coin-request';
  await player.send({ type: 'collect', id: original.id, requestId });
  assert.equal(score(h, uid), 1);
  const firstRow = coinRow(h, original.id);
  const receiptCount = actionCount(h);
  player = await reconnect(h, player, uid, '4,4');
  await h.setTime(firstRow.respawn_at);
  h.place(player, contact(h.room().coinSnapshot()[original.id]));
  await player.send({ type: 'collect', id: original.id, requestId });
  assert.equal(score(h, uid), 1, 'a retry cannot become a new reward merely because the resource respawned');
  assert.deepEqual(coinRow(h, original.id), firstRow);
  assert.equal(actionCount(h), receiptCount);
  await h.advance(150);
  await player.send({ type: 'collect', id: original.id, requestId: 'synthetic-next-coin-request' });
  assert.equal(score(h, uid), 2);
  assert.equal(coinRow(h, original.id).cycle, 2);
});

test('P4 duplicate legacy coin packets cannot double reward even without a request identifier', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-legacy-retry';
  const player = await authenticate(h, uid);
  const coin = h.room().coinSnapshot()[3];
  h.place(player, contact(coin));
  await player.send({ type: 'collect', id: coin.id });
  const committed = coinRow(h, coin.id);
  h.place(player, contact(h.room().coinSnapshot()[coin.id]));
  await h.advance(150);
  await player.send({ type: 'collect', id: coin.id });
  assert.equal(score(h, uid), 1);
  assert.deepEqual(coinRow(h, coin.id), committed);
  assert.equal(last(player, 'coin_state').respawnAt, committed.respawn_at);
});

test('P4 server time enforces the exact 60-second coin cooldown', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-coin-clock';
  const player = await authenticate(h, uid);
  const coin = h.room().coinSnapshot()[4];
  h.place(player, contact(coin));
  const collectedAt = h.now();
  await player.send({ type: 'collect', id: coin.id, requestId: 'synthetic-coin-clock-first' });
  h.place(player, contact(h.room().coinSnapshot()[coin.id]));
  await h.setTime(collectedAt + COIN_RESPAWN - 1);
  await player.send({ type: 'collect', id: coin.id, requestId: 'synthetic-coin-clock-too-early' });
  assert.equal(score(h, uid), 1);
  assert.equal(coinRow(h, coin.id).cycle, 1);
  await h.advance(1);
  // The existing 150ms action throttle is separate from the resource clock.
  const other = await authenticate(h, 'synthetic-p4-coin-clock-second');
  h.place(other, contact(h.room().coinSnapshot()[coin.id]));
  await other.send({ type: 'collect', id: coin.id, requestId: 'synthetic-coin-clock-at-deadline' });
  assert.equal(score(h, 'synthetic-p4-coin-clock-second'), 1);
  assert.equal(coinRow(h, coin.id).cycle, 2);
  assert.equal(coinRow(h, coin.id).respawn_at, h.now() + COIN_RESPAWN);
});

test('P4 coin cooldown, position, receipt and authoritative leaderboard survive SQLite restart', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-coin-restart';
  const coin = h.room().coinSnapshot()[5];
  // The baseline legacy room stores a UID fallback nickname, whereas zone
  // admission intentionally updates it from the authenticated name. Keep the
  // same zone admission on both sides of this persistence assertion.
  const first = await authenticate(h, uid, zoneAt(coin));
  h.place(first, contact(coin));
  await first.send({ type: 'collect', id: coin.id, requestId: 'synthetic-coin-restart-request' });
  const snapshot = plain(h.room().coinSnapshot());
  const receipts = actionCount(h);
  const leaderboard = h.room().top();
  h.restartRoom();
  await h.room().ready;
  const returned = await authenticate(h, uid, zoneAt(coin));
  assert.equal(last(returned, 'welcome').score, 1);
  assert.deepEqual(last(returned, 'welcome').coins, snapshot);
  assert.deepEqual(last(returned, 'welcome').leaderboard, leaderboard);
  assert.equal(actionCount(h), receipts);
  assert.equal(snapshot[coin.id].respawnAt, h.now() + COIN_RESPAWN);
});

test('P4 client score, reward, identity and remote contact claims cannot grant coins', async t => {
  const h = harness(t);
  const coin = h.room().coinSnapshot()[6];
  for (const [index, authority] of [{ score: 9999 }, { reward: 9999 }, { uid: 'synthetic-forged-economy-owner' }].entries()) {
    const uid = `synthetic-p4-forged-economy-${index}`;
    const player = await authenticate(h, uid);
    h.place(player, contact(coin));
    await player.send({ type: 'collect', id: coin.id, ...authority });
    assert.equal(player.client.closed, true);
    assert.equal(player.client.closeInfo.code, 1008);
    assert.equal(score(h, uid), 0);
  }
  const remote = await authenticate(h, 'synthetic-p4-remote-contact');
  h.place(remote, { x: 0, y: 0, z: 0, r: 0 });
  assert.ok(Math.hypot(coin.x, coin.z) > 2.35);
  await remote.send({ type: 'collect', id: coin.id, ...contact(coin) });
  assert.equal(score(h, 'synthetic-p4-remote-contact'), 0);
  assert.equal(coinRow(h, coin.id), null);
  assert.equal(actionCount(h), 0);
});

for (const failure of ['score', 'receipt']) {
  test(`P4 a real SQLite ${failure} write failure rolls back coin, score and action receipt`, async t => {
    const h = harness(t);
    const uid = `synthetic-p4-coin-rollback-${failure}`;
    const player = await authenticate(h, uid, '4,4');
    const coin = h.room().coinSnapshot()[9];
    h.place(player, contact(coin));
    const before = plain(h.room().coinSnapshot());
    const beforeActions = actionCount(h);
    const trigger = `p4_coin_${failure}_failure`;
    failSQL(h, failure === 'score' ? 'voxel_scores' : 'voxel_economy_actions', failure === 'score' ? 'UPDATE' : 'INSERT', trigger);
    await player.send({ type: 'collect', id: coin.id, requestId: `synthetic-coin-failed-${failure}` });
    assert.equal(score(h, uid), 0);
    assert.deepEqual(plain(h.room().coinSnapshot()), before);
    assert.equal(actionCount(h), beforeActions);
    assert.ok(last(player, 'server_error'));
    assert.equal(player.messages('coin_collect_result').filter(message => message.collected).length, 0);
    h.room().sql.exec(`DROP TRIGGER ${trigger}`);
    await h.advance(150);
    await player.send({ type: 'collect', id: coin.id, requestId: `synthetic-coin-failed-${failure}` });
    assert.equal(score(h, uid), 1);
    assert.equal(coinRow(h, coin.id).cycle, 1);
  });
}

test('P4 a missing persisted score row fails closed without consuming a coin', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-missing-score';
  const player = await authenticate(h, uid);
  const coin = h.room().coinSnapshot()[10];
  h.place(player, contact(coin));
  const before = plain(h.room().coinSnapshot());
  h.room().sql.exec('DELETE FROM voxel_scores WHERE uid=?', uid);
  await player.send({ type: 'collect', id: coin.id, requestId: 'synthetic-missing-score' });
  assert.deepEqual(plain(h.room().coinSnapshot()), before);
  assert.equal(actionCount(h), 0);
  assert.ok(last(player, 'server_error'));
});

test('P4 simultaneous room and cross-zone Lucky Box claimants obtain one claim and one reward', async t => {
  const h = harness(t);
  const box = h.room().boxSnapshot();
  const entries = [];
  for (const [index, zone] of [undefined, zoneAt(box), '4,4'].entries()) {
    const uid = `synthetic-p4-box-contender-${index}`;
    const player = await authenticate(h, uid, zone);
    h.place(player, contact(box));
    player.clear();
    entries.push({ player, uid });
  }
  await Promise.all(entries.map((entry, index) => entry.player.send({ type: 'collect_box', requestId: `synthetic-box-claim-${index}` })));
  const winners = entries.filter(entry => entry.player.messages('box_spin_ready').length);
  assert.equal(winners.length, 1);
  for (const entry of entries) {
    const state = last(entry.player, 'box_state').box;
    assert.equal(state.claimed, true);
    assert.equal(state.active, false);
    assert.equal(state.claimExpiresAt, boxRow(h).claim_expires_at);
  }
  await Promise.all(entries.map((entry, index) => entry.player.send({ type: 'spin_box', requestId: `synthetic-box-spin-${index}` })));
  const successful = entries.flatMap(entry => entry.player.messages('box_reward'));
  assert.equal(successful.length, 1);
  assert.ok([100, 500, 1000, 5000, 9999].includes(successful[0].reward));
  assert.equal(entries.reduce((total, entry) => total + score(h, entry.uid), 0), successful[0].reward);
  assert.equal(boxRow(h).cycle, 1);
  assert.equal(boxRow(h).next_spawn_at, h.now() + BOX_RESPAWN);
  for (const entry of entries) assert.equal(last(entry.player, 'box_state').box.nextSpawnAt, boxRow(h).next_spawn_at);
});

test('P4 spin replay after restart and four hours cannot spend a new Lucky Box claim', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-durable-spin';
  let player = await authenticate(h, uid);
  h.place(player, contact(h.room().boxSnapshot()));
  await player.send({ type: 'collect_box', requestId: 'synthetic-durable-claim-first' });
  const requestId = 'synthetic-durable-spin-request';
  await player.send({ type: 'spin_box', requestId });
  const reward = last(player, 'box_reward').reward;
  const cooldown = boxRow(h).next_spawn_at;
  h.restartRoom();
  await h.room().ready;
  await h.setTime(cooldown);
  player = await authenticate(h, uid, '4,4');
  h.place(player, contact(h.room().boxSnapshot()));
  await player.send({ type: 'collect_box', requestId: 'synthetic-durable-claim-second' });
  const beforeRetry = boxRow(h);
  const receiptCount = actionCount(h);
  await player.send({ type: 'spin_box', requestId });
  assert.equal(score(h, uid), reward);
  assert.deepEqual(boxRow(h), beforeRetry);
  assert.equal(actionCount(h), receiptCount);
  await player.send({ type: 'spin_box', requestId: 'synthetic-new-cycle-spin-request' });
  const newReward = last(player, 'box_reward').reward;
  assert.equal(score(h, uid), reward + newReward);
  assert.equal(boxRow(h).cycle, 2);
});

test('P4 Lucky Box claim survives restart and belongs only to its original authenticated UID', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-persistent-claim';
  const first = await authenticate(h, uid, '4,4');
  h.place(first, contact(h.room().boxSnapshot()));
  await first.send({ type: 'collect_box', requestId: 'synthetic-persistent-claim' });
  const persisted = boxRow(h);
  h.restartRoom();
  await h.room().ready;
  assert.deepEqual(boxRow(h), persisted);
  const other = await authenticate(h, 'synthetic-p4-wrong-claim-owner');
  await other.send({ type: 'spin_box' });
  assert.equal(other.messages('box_reward').length, 0);
  assert.equal(score(h, 'synthetic-p4-wrong-claim-owner'), 0);
  const resumed = await authenticate(h, uid, '4,4');
  await resumed.send({ type: 'spin_box', requestId: 'synthetic-persistent-claim-spin' });
  assert.ok(last(resumed, 'box_reward'));
  assert.equal(score(h, uid), last(resumed, 'box_reward').reward);
});

test('P4/P8 Lucky Box claim expiry preserves collection cooldown and a stale owner cannot steal a successor claim', async t => {
  const h = harness(t);
  const first = await authenticate(h, 'synthetic-p4-expired-claim-owner');
  let second = await authenticate(h, 'synthetic-p4-successor-claim-owner', '4,4');
  const box = h.room().boxSnapshot();
  h.place(first, contact(box));
  h.place(second, contact(box));
  await first.send({ type: 'collect_box', requestId: 'synthetic-expiring-claim' });
  const deadline = boxRow(h).claim_expires_at;
  assert.equal(deadline, h.now() + 90_000);
  await h.setTime(deadline - 1);
  assert.equal(h.room().boxSnapshot().claimed, true);
  await h.advance(1);
  const cooling = h.room().boxSnapshot();
  assert.equal(cooling.active, false);
  assert.equal(cooling.claimed, false);
  assert.equal(cooling.nextSpawnAt, deadline - 90_000 + BOX_RESPAWN);
  await second.send({ type: 'collect_box', requestId: 'synthetic-successor-claim' });
  assert.equal(second.messages('box_spin_ready').length, 0);
  assert.equal(score(h, 'synthetic-p4-successor-claim-owner'), 0);
  await first.send({ type: 'spin_box', requestId: 'synthetic-expired-owner-spin' });
  assert.equal(first.messages('box_reward').length, 0);
  assert.equal(score(h, 'synthetic-p4-expired-claim-owner'), 0);
  await h.setTime(cooling.nextSpawnAt);
  second = await authenticate(h, 'synthetic-p4-successor-claim-owner', '4,4');
  h.place(second, contact(h.room().boxSnapshot()));
  await second.send({ type: 'collect_box', requestId: 'synthetic-successor-claim' });
  assert.ok(last(second, 'box_spin_ready'));
  await second.send({ type: 'spin_box', requestId: 'synthetic-successor-spin' });
  assert.equal(score(h, 'synthetic-p4-successor-claim-owner'), last(second, 'box_reward').reward);
});

test('P4 Lucky Box activates at exactly four hours and its single position persists across restart', async t => {
  const h = harness(t);
  const first = await authenticate(h, 'synthetic-p4-box-clock');
  h.place(first, contact(h.room().boxSnapshot()));
  await first.send({ type: 'collect_box' });
  const started = h.now();
  await first.send({ type: 'spin_box' });
  const deadline = started + BOX_RESPAWN;
  assert.equal(boxRow(h).next_spawn_at, deadline);
  await h.setTime(deadline - 1);
  assert.equal(h.room().boxSnapshot().active, false);
  await h.advance(1);
  const active = plain(h.room().boxSnapshot());
  assert.equal(active.active, true);
  assert.equal(active.cycle, 1);
  h.restartRoom();
  await h.room().ready;
  const restored = h.room().boxSnapshot();
  for (const key of ['x', 'z', 'cycle', 'nextSpawnAt', 'active']) assert.equal(restored[key], active[key]);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_lucky_box').toArray()[0].count, 1);
});

test('P4 Lucky Box respawn avoids currently live room and zone players and saves the selected location', async t => {
  const h = harness(t);
  const initial = await authenticate(h, 'synthetic-p4-box-spawn-initial');
  h.place(initial, contact(h.room().boxSnapshot()));
  await initial.send({ type: 'collect_box' });
  await initial.send({ type: 'spin_box' });
  const deadline = boxRow(h).next_spawn_at;
  await h.setTime(deadline - 1000);
  const { luckyBoxPosition, SERVER_WORLD } = require('../../src/worker/world.mjs');
  const candidate = luckyBoxPosition(1);
  const current = [
    { uid: 'synthetic-p4-spawn-room', position: contact(candidate) },
    { uid: 'synthetic-p4-spawn-zone', zone: zoneAt(candidate), position: { ...contact(candidate), x: candidate.x + 1 } }
  ];
  for (const entry of current) {
    entry.player = await authenticate(h, entry.uid, entry.zone);
    h.place(entry.player, entry.position);
  }
  await h.advance(200);
  for (const entry of current) await entry.player.send({ type: 'move', seq: 0, input: { x: 0, z: 0, jump: false } });
  await h.setTime(deadline);
  const spawned = h.room().boxSnapshot();
  assert.equal(spawned.active, true);
  assert.equal(spawned.cycle, 1);
  for (const entry of current) {
    const position = entry.player.attachment();
    assert.ok(Math.hypot(spawned.x - position.x, spawned.z - position.z) >= 6,
      'an activating box cannot overlap a currently live authoritative player');
  }
  assert.ok(Math.abs(spawned.x) <= 748 && Math.abs(spawned.z) <= 748);
  assert.ok(![...SERVER_WORLD.buildings, ...SERVER_WORLD.trees].some(obstacle =>
    spawned.x >= obstacle.minX && spawned.x <= obstacle.maxX && spawned.z >= obstacle.minZ && spawned.z <= obstacle.maxZ));
  h.restartRoom();
  await h.room().ready;
  const restored = h.room().boxSnapshot();
  assert.equal(restored.x, spawned.x);
  assert.equal(restored.z, spawned.z);
});

for (const failure of ['score', 'receipt']) {
  test(`P4 a real SQLite ${failure} write failure rolls back Lucky Box score, cooldown and receipt`, async t => {
    const h = harness(t);
    const uid = `synthetic-p4-box-rollback-${failure}`;
    const player = await authenticate(h, uid, '4,4');
    h.place(player, contact(h.room().boxSnapshot()));
    await player.send({ type: 'collect_box', requestId: `synthetic-box-rollback-claim-${failure}` });
    const before = boxRow(h);
    const beforeActions = actionCount(h);
    const trigger = `p4_box_${failure}_failure`;
    failSQL(h, failure === 'score' ? 'voxel_scores' : 'voxel_economy_actions', failure === 'score' ? 'UPDATE' : 'INSERT', trigger);
    await player.send({ type: 'spin_box', requestId: `synthetic-box-failed-${failure}` });
    assert.equal(score(h, uid), 0);
    assert.deepEqual(boxRow(h), before);
    assert.equal(actionCount(h), beforeActions);
    assert.equal(player.messages('box_reward').length, 0);
    assert.ok(last(player, 'box_error'));
    h.room().sql.exec(`DROP TRIGGER ${trigger}`);
    await player.send({ type: 'spin_box', requestId: `synthetic-box-failed-${failure}` });
    const reward = last(player, 'box_reward').reward;
    assert.equal(score(h, uid), reward);
    assert.equal(boxRow(h).cycle, before.cycle, 'collection already advanced the cycle; a retry cannot advance it again');
    assert.equal(boxRow(h).next_spawn_at, before.next_spawn_at, 'spin retry must preserve the collection deadline');
  });
}

test('P4 authoritative persisted leaderboard reflects coin and single Lucky Box rewards after recovery', async t => {
  const h = harness(t);
  const coinUid = 'synthetic-p4-board-coin';
  const boxUid = 'synthetic-p4-board-box';
  const coinPlayer = await authenticate(h, coinUid);
  const boxPlayer = await authenticate(h, boxUid, '4,4');
  const coin = h.room().coinSnapshot()[11];
  h.place(coinPlayer, contact(coin));
  await coinPlayer.send({ type: 'collect', id: coin.id });
  h.place(boxPlayer, contact(h.room().boxSnapshot()));
  await boxPlayer.send({ type: 'collect_box' });
  await boxPlayer.send({ type: 'spin_box' });
  const reward = last(boxPlayer, 'box_reward').reward;
  assert.equal(score(h, coinUid), 1);
  assert.equal(score(h, boxUid), reward);
  const persisted = h.room().top();
  assert.deepEqual(persisted.map(row => row.score), [reward, 1]);
  h.restartRoom();
  await h.room().ready;
  const observer = await authenticate(h, 'synthetic-p4-board-observer', '9,9');
  assert.deepEqual(last(observer, 'welcome').leaderboard.slice(0, 2), persisted);
  assert.deepEqual(h.room().top().slice(0, 2), persisted);
});

test('P4 a durable action identifier cannot be reused for another resource or reward kind', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-action-conflict';
  let player = await authenticate(h, uid);
  const first = h.room().coinSnapshot()[13];
  const second = h.room().coinSnapshot()[14];
  const requestId = 'synthetic-shared-action-id';
  h.place(player, contact(first));
  await player.send({ type: 'collect', id: first.id, requestId });
  assert.equal(score(h, uid), 1);
  const receipts = actionCount(h);
  player = await reconnect(h, player, uid);
  h.place(player, contact(second));
  await player.send({ type: 'collect', id: second.id, requestId });
  assert.equal(score(h, uid), 1);
  assert.equal(coinRow(h, second.id), null);
  assert.equal(actionCount(h), receipts);
  player = await reconnect(h, player, uid);
  h.place(player, contact(h.room().boxSnapshot()));
  const before = boxRow(h);
  await player.send({ type: 'collect_box', requestId });
  assert.deepEqual(boxRow(h), before);
  assert.equal(player.messages('box_spin_ready').length, 0);
  assert.equal(actionCount(h), receipts);
});

test('P4 a too-far attempt can retry its uncommitted action ID at real contact and reward only once', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-negative-retry';
  const player = await authenticate(h, uid, '4,4');
  const coin = h.room().coinSnapshot()[15];
  const requestId = 'synthetic-contact-retry';
  h.place(player, { x: 0, y: 0, z: 0, r: 0 });
  assert.ok(Math.hypot(coin.x, coin.z) > 2.35);
  await player.send({ type: 'collect', id: coin.id, requestId });
  assert.equal(score(h, uid), 0);
  assert.equal(coinRow(h, coin.id), null);
  assert.equal(actionCount(h), 0, 'an uncommitted contact attempt must not permanently consume an action ID');
  h.place(player, contact(coin));
  await h.advance(150);
  await player.send({ type: 'collect', id: coin.id, requestId });
  assert.equal(score(h, uid), 1);
  assert.equal(coinRow(h, coin.id).cycle, 1);
  const persisted = coinRow(h, coin.id);
  await h.advance(150);
  await player.send({ type: 'collect', id: coin.id, requestId });
  assert.equal(score(h, uid), 1);
  assert.deepEqual(coinRow(h, coin.id), persisted);
});

test('P4 numeric and string request identifiers remain distinct persisted actions', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-typed-id';
  const player = await authenticate(h, uid);
  const first = h.room().coinSnapshot()[16];
  const second = h.room().coinSnapshot()[17];
  h.place(player, contact(first));
  await player.send({ type: 'collect', id: first.id, requestId: 17 });
  h.place(player, contact(second));
  await h.advance(150);
  await player.send({ type: 'collect', id: second.id, requestId: '17' });
  assert.equal(score(h, uid), 2);
  const identifiers = h.room().sql.exec('SELECT request_id FROM voxel_economy_actions WHERE uid=? ORDER BY request_id', uid)
    .toArray().map(row => row.request_id);
  assert.deepEqual(identifiers, ['number:17', 'string:17']);
});

test('P4 a claim retry across reconnect does not extend its original server deadline', async t => {
  const h = harness(t);
  const uid = 'synthetic-p4-claim-retry';
  let player = await authenticate(h, uid, '4,4');
  h.place(player, contact(h.room().boxSnapshot()));
  const requestId = 'synthetic-no-claim-extension';
  await player.send({ type: 'collect_box', requestId });
  const claimed = boxRow(h);
  await h.advance(1000);
  player = await reconnect(h, player, uid, '4,4');
  await player.send({ type: 'collect_box', requestId });
  assert.equal(boxRow(h).claim_expires_at, claimed.claim_expires_at);
  assert.equal(boxRow(h).claimed_uid, uid);
  assert.equal(score(h, uid), 0);
});

test('P4/P8 a disconnected claimant releases spin ownership but preserves cooldown for every observer', async t => {
  const h = harness(t);
  const collector = await authenticate(h, 'synthetic-p4-disconnected-claim');
  const roomObserver = await authenticate(h, 'synthetic-p4-claim-alarm-room');
  const zoneObserver = await authenticate(h, 'synthetic-p4-claim-alarm-zone', '4,4');
  h.place(collector, contact(h.room().boxSnapshot()));
  await collector.send({ type: 'collect_box' });
  const expires = boxRow(h).claim_expires_at;
  for (const observer of [roomObserver, zoneObserver]) {
    assert.equal(last(observer, 'box_state').box.claimed, true);
    observer.clear();
  }
  await collector.close();
  await h.setTime(expires - 1);
  assert.equal(boxRow(h).claimed_uid, 'synthetic-p4-disconnected-claim');
  await h.advance(1);
  assert.equal(boxRow(h).claimed_uid, null);
  assert.equal(boxRow(h).cycle, 1);
  assert.equal(boxRow(h).next_spawn_at, expires - 90_000 + BOX_RESPAWN);
  assert.equal(score(h, 'synthetic-p4-disconnected-claim'), 0);
  for (const observer of [roomObserver, zoneObserver]) {
    const released = last(observer, 'box_state');
    assert.ok(released, 'a server alarm publishes claim recovery without another player action');
    assert.equal(released.box.active, false);
    assert.equal(released.box.nextSpawnAt, boxRow(h).next_spawn_at);
    assert.equal(released.box.claimed, false);
  }
});

test('D005 lost coin acknowledgment replay after disconnect, restart and respawn cannot consume the new cycle', async t => {
  const h = harness(t), uid = 'synthetic-d005-lost-ack';
  let player = await authenticate(h, uid, '4,4');
  const coin = h.room().coinSnapshot()[16];
  const requestId = 'synthetic-d005-retry';
  h.place(player, contact(coin));
  await player.send({ type: 'collect', id: coin.id, requestId });
  assert.equal(score(h, uid), 1);
  const committed = coinRow(h, coin.id), receipts = actionCount(h);
  const ticket = last(player, 'welcome').session.resumeToken;
  // Model loss after the authoritative transaction: discard the received ACK,
  // then reconnect with the same request ID rather than inventing a new action.
  player.clear();
  await player.close();
  await h.restartRoom().ready;
  player = await authenticate(h, uid, '4,4', ticket);
  assert.equal(last(player, 'welcome').score, 1);
  await h.setTime(committed.respawn_at);
  const respawned = h.room().coinSnapshot()[coin.id];
  h.place(player, contact(respawned));
  await player.send({ type: 'collect', id: coin.id, requestId });
  assert.equal(score(h, uid), 1);
  assert.equal(actionCount(h), receipts);
  assert.deepEqual(coinRow(h, coin.id), committed);
  assert.equal(h.room().coinSnapshot().length, 200);
  assert.equal(new Set(h.room().coinSnapshot().map(item => item.id)).size, 200);
  // Another identity can win the new cycle even with an identical action ID;
  // the old owner's receipt must neither award twice nor reserve the coin.
  const otherUid = 'synthetic-d005-next-owner';
  const other = await authenticate(h, otherUid, zoneAt(respawned));
  h.place(other, contact(respawned));
  await other.send({ type: 'collect', id: coin.id, requestId });
  assert.equal(score(h, otherUid), 1);
  assert.equal(score(h, uid), 1);
  assert.equal(actionCount(h), receipts + 1);
  assert.equal(coinRow(h, coin.id).cycle, committed.cycle + 1);
  assert.equal(coinRow(h, coin.id).respawn_at, h.now() + COIN_RESPAWN);
});
