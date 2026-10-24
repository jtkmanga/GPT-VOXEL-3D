'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createHarness } = require('./harness.cjs');

// Release-candidate security/recovery exercises the actual Worker module graph,
// RSA/HMAC boundaries and transactional SQLite. Setup may place an authenticated
// server fixture at a resource; packets never receive authority for coordinates,
// identity, saved score, entitlement or a payment result.
const MONTH = 30 * 24 * 60 * 60 * 1000;
const BOX_COOLDOWN = 4 * 60 * 60 * 1000;
const position = p => Object.fromEntries(['x', 'y', 'z', 'r'].map(key => [key, Number(p[key])]));
const contact = resource => ({ x: resource.x, y: 0, z: resource.z, r: 0 });
const zoneAt = p => `${Math.floor((p.x + 750) / 150)},${Math.floor((p.z + 750) / 150)}`;
const last = (connection, type) => connection.messages(type).at(-1);
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const h = createHarness();
  t.after(() => h.close());
  return h;
}
function event(h, uid, changes = {}) {
  return { eventId: `p8-event:${uid}:1`, subscriptionId: `p8-subscription:${uid}`, uid,
    version: 1, status: 'active', product: 'vip1', amount: 50, currency: 'THB',
    periodStart: h.now() - 1000, periodEnd: h.now() - 1000 + MONTH, ...changes };
}
function signed(h, payload, changes = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const timestamp = changes['x-provider-timestamp'] ?? String(Math.floor(h.now() / 1000));
  const signature = createHmac('sha256', h.env.PAYMENT_WEBHOOK_SECRET).update(timestamp + '.' + body).digest('hex');
  return { method: 'POST', body, headers: { 'content-type': 'application/json',
    'x-provider-timestamp': timestamp, 'x-provider-signature': signature, ...changes } };
}
const webhook = (h, payload, headers) => h.request('/payments/webhook', signed(h, payload, headers));
async function paid(h, uid) {
  const response = await webhook(h, event(h, uid));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
}
async function packet(h, instance, connection, message) {
  await instance.webSocketMessage(connection.server, typeof message === 'string' ? message : JSON.stringify(message));
  await h.settle();
}
function restartZone(h, zone) {
  const entry = h.env.ZONE.object(`free-zone-${zone}`);
  entry.instance = new h.runtime.ZoneRoom(entry.ctx, h.env);
  return entry.instance;
}
function boxRow(room) { return room.sql.exec('SELECT * FROM voxel_lucky_box WHERE id=1').toArray()[0]; }
function receipts(room) { return room.sql.exec('SELECT COUNT(*) AS n FROM voxel_economy_actions').toArray()[0].n; }
function failWrite(room, table, action, name) {
  room.sql.exec(`CREATE TRIGGER ${name} BEFORE ${action} ON ${table}
    BEGIN SELECT RAISE(ABORT,'synthetic P8 SQLite outage'); END`);
}
function seeded(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}

test('P8 seeded malformed protocol fuzz cannot mutate durable ownership, economy or resources in room or zone', async t => {
  const h = fixture(t), random = seeded(0x50385038);
  const malformed = ['{', 'null', '[]', 'true', '"move"', '{"type":"untrusted-command"}',
    '{"type":"move","__proto__":{"score":999999}}', '😀'.repeat(2049)];
  const invalidNumbers = [null, '1', [], {}, true, Number.MAX_SAFE_INTEGER + 1];
  for (let index = 0; index < 24; index++) {
    const value = invalidNumbers[random() % invalidNumbers.length];
    const alternatives = [
      { type: 'move', seq: random() % 10, input: { x: value, z: 0, jump: false } },
      { type: 'move', seq: -1, input: { x: 0, z: 0, jump: false } },
      { type: 'collect', id: 200 + random() % 10000 },
      { type: 'collect', id: random() % 200, reward: random() },
      { type: 'auth', token: value },
      { type: 'spin_box', uid: `forged-${random()}` },
      { type: 'collect_box', inventory: [random()] },
      { type: 'move', seq: random(), input: { x: 0, z: 0, jump: false, speed: 999 } }
    ];
    // Every alternative is deliberately invalid; seed chooses malformed values,
    // never authorizes a mutation that might happen to resemble a legal packet.
    malformed.push(JSON.stringify(alternatives[index % alternatives.length]));
  }
  let verifiedAttempts = 0;
  for (const zone of [undefined, '4,4']) {
    for (const [index, raw] of malformed.entries()) {
      const uid = `p8-fuzz-${zone ? 'zone' : 'room'}-${index}`;
      const connection = await h.connect({ uid, ...(zone ? { zone } : {}) });
      assert.ok(last(connection, 'welcome'));
      const before = h.room().sessions.row(uid), coins = plain(h.room().coinSnapshot()), box = boxRow(h.room());
      await connection.send(raw);
      const after = h.room().sessions.row(uid);
      assert.deepEqual(position(after), position(before), `fuzz case ${index} must not move persisted player`);
      assert.equal(after.save_revision, before.save_revision);
      assert.equal(after.session_id, before.session_id);
      assert.equal(h.room().economy.score(uid), 0);
      assert.deepEqual(plain(h.room().coinSnapshot()), coins);
      assert.deepEqual(boxRow(h.room()), box);
      assert.equal(connection.messages('box_reward').length, 0);
      assert.equal(connection.messages('score').length, 0);
      verifiedAttempts++;
    }
  }
  assert.equal(verifiedAttempts, 64);
  assert.equal(receipts(h.room()), 0);
  assert.equal(h.room().vip.count(), 0);
});

test('P8 binary and UTF-8 oversized packets remain rejected after actual zone reconstruction', async t => {
  const h = fixture(t);
  for (const [index, message] of [new Uint8Array([0, 1, 2]), '😀'.repeat(2049)].entries()) {
    const uid = `p8-transport-${index}`, connection = await h.connect({ uid, zone: '4,4' });
    const before = h.room().sessions.row(uid), restored = restartZone(h, '4,4');
    await restored.webSocketMessage(connection.server, message);
    await h.settle();
    assert.equal(connection.client.closed, true);
    assert.equal(connection.client.closeInfo.code, index === 0 ? 1003 : 1009);
    assert.equal(h.room().sessions.row(uid).save_revision, before.save_revision);
    assert.deepEqual(position(h.room().sessions.row(uid)), position(before));
    assert.equal(h.room().economy.score(uid), 0);
  }
});

test('P8 every private mutation/visibility endpoint stays inaccessible through public HTTP and WebSocket routing', async t => {
  const h = fixture(t), connection = await h.connect({ uid: 'p8-private-routing', zone: '4,4' });
  const before = h.room().sessions.row(connection.attachment().uid), routeCount = h.records.routes.length;
  const paths = ['configure-scope', 'grant-payment', 'get-entitlements', 'zone-bootstrap', 'zone-world-state',
    'zone-collect', 'zone-collect-box', 'zone-spin-box', 'create-zone-handoff', 'consume-zone-handoff',
    'cancel-zone-handoff', 'session-revoke', 'world-event', 'border-snapshot', 'border-state', 'active-zones',
    'session/acquire', 'session/checkpoint', 'session/release', 'session/transfer', 'session/validate', 'session/revoke',
    'vip/apply-event', 'vip/admit', 'vip/validate', 'vip/renew', 'vip/release', 'vip/status'];
  for (const endpoint of paths) {
    for (const upgrade of [false, true]) {
      const response = await h.request(`/_internal/${endpoint}`, {
        method: upgrade ? 'GET' : 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${h.token(before.uid)}`,
          ...(upgrade ? { Upgrade: 'websocket' } : {}) },
        ...(!upgrade ? { body: JSON.stringify({ uid: before.uid, sessionId: before.session_id, owner: before.owner,
          scope: 'vip1', score: 999999, reward: 999999, amount: 50, paid: true, revision: 999999,
          position: { x: 700, y: 0, z: 700, r: 0 } }) } : {})
      });
      assert.equal(response.status, 404, `${endpoint} cannot enter a Durable Object from public routing`);
    }
  }
  assert.equal(h.records.routes.length, routeCount);
  assert.deepEqual(h.room().sessions.row(before.uid), before);
  assert.equal(h.room().economy.score(before.uid), 0);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_payments').toArray()[0].n, 0);
  assert.equal(h.room().vip.count(), 0);
});

test('P8 replayed and out-of-order movement remains fenced after zone and coordinator reconstruction', async t => {
  const h = fixture(t), uid = 'p8-movement-recovery', zone = '4,4';
  const connection = await h.connect({ uid, zone });
  await h.advance(200);
  await connection.send({ type: 'move', seq: 10, input: { x: .1, z: 0, jump: false } });
  const durable = h.room().sessions.row(uid), id = connection.attachment().id;
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  const restored = restartZone(h, zone);
  for (const seq of [10, 9, 0]) {
    await h.advance(200);
    await packet(h, restored, connection, { type: 'move', seq, input: { x: 1, z: 0, jump: false } });
    assert.deepEqual(h.room().sessions.row(uid), durable, `replayed sequence ${seq} cannot save new state`);
    assert.deepEqual(position(connection.attachment()), position(durable));
  }
  await packet(h, restored, connection, { type: 'move', seq: 11, input: { x: 0, z: .1, jump: false } });
  assert.equal(last(connection, 'move').ack, 11);
  assert.equal(connection.attachment().id, id);
  assert.ok(h.room().sessions.row(uid).save_revision > durable.save_revision);
  assert.deepEqual(position(h.room().sessions.row(uid)), position(connection.attachment()));
});

test('P8 real SQLite checkpoint failure preserves last save; restart/reconnect recovers and retries authored movement', async t => {
  const h = fixture(t), uid = 'p8-checkpoint-rollback', zone = '4,4';
  const connection = await h.connect({ uid, zone }), before = h.room().sessions.row(uid);
  failWrite(h.room(), 'voxel_sessions', 'UPDATE', 'p8_checkpoint_abort');
  await h.advance(200);
  await connection.send({ type: 'move', seq: 0, input: { x: .2, z: 0, jump: false } });
  assert.equal(connection.client.closed, true);
  assert.ok(last(connection, 'server_error'));
  assert.deepEqual(h.room().sessions.row(uid), before, 'actual SQLite rollback retains the pre-frame checkpoint');
  h.room().sql.exec('DROP TRIGGER p8_checkpoint_abort');
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  restartZone(h, zone);
  const recovered = await h.connect({ uid, zone });
  assert.equal(recovered.attachment().id, before.player_id);
  assert.deepEqual(position(recovered.attachment()), position(before));
  await h.advance(200);
  await recovered.send({ type: 'move', seq: 0, input: { x: .2, z: 0, jump: false } });
  assert.equal(recovered.client.closed, false);
  assert.equal(last(recovered, 'move').ack, 0);
  assert.ok(h.room().sessions.row(uid).save_revision > before.save_revision);
  assert.deepEqual(position(h.room().sessions.row(uid)), position(recovered.attachment()));
});

test('P8 live zone callbacks recover coin receipt and claimed Lucky Box cooldown through coordinator/zone restart', async t => {
  const h = fixture(t), coin = h.room().coinSnapshot()[21], box = h.room().boxSnapshot();
  const coinUid = 'p8-zone-coin', boxUid = 'p8-zone-box';
  const coinZone = zoneAt(coin), boxZone = zoneAt(box);
  const coinPlayer = await h.connect({ uid: coinUid, zone: coinZone });
  const boxPlayer = await h.connect({ uid: boxUid, zone: boxZone });
  h.place(coinPlayer, contact(coin)); h.place(boxPlayer, contact(box));
  await coinPlayer.send({ type: 'collect', id: coin.id, requestId: 'p8-zone-coin-request' });
  const collectedAt = h.now();
  await boxPlayer.send({ type: 'collect_box', requestId: 'p8-zone-box-claim' });
  assert.ok(last(boxPlayer, 'box_spin_ready'));
  const coinBefore = plain(h.room().coinSnapshot()), boxBefore = boxRow(h.room());
  const coinOwner = h.room().sessions.row(coinUid), boxOwner = h.room().sessions.row(boxUid);
  assert.equal(boxBefore.next_spawn_at, collectedAt + BOX_COOLDOWN);
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  const restored = new Map([...new Set([coinZone, boxZone])].map(zone => [zone, restartZone(h, zone)]));
  assert.deepEqual(plain(h.room().coinSnapshot()), coinBefore);
  assert.deepEqual(boxRow(h.room()), boxBefore);
  assert.deepEqual(h.room().sessions.row(coinUid), coinOwner);
  assert.deepEqual(h.room().sessions.row(boxUid), boxOwner);
  await h.advance(1000);
  await packet(h, restored.get(boxZone), boxPlayer, { type: 'spin_box', requestId: 'p8-zone-box-spin' });
  const reward = last(boxPlayer, 'box_reward')?.reward;
  assert.ok([100, 500, 1000, 5000, 9999].includes(reward));
  assert.equal(h.room().economy.score(boxUid), reward);
  assert.equal(h.room().economy.score(coinUid), 1);
  assert.equal(boxRow(h.room()).next_spawn_at, boxBefore.next_spawn_at, 'recovered reward cannot restart collection cooldown');
  const totalReceipts = receipts(h.room());
  await restored.get(boxZone).webSocketClose(boxPlayer.server); await h.settle();
  const reconnect = await h.connect({ uid: boxUid, zone: boxZone });
  await reconnect.send({ type: 'spin_box', requestId: 'p8-zone-box-spin' });
  assert.equal(last(reconnect, 'box_reward').replayed, true);
  assert.equal(h.room().economy.score(boxUid), reward);
  assert.equal(receipts(h.room()), totalReceipts);
  assert.equal(last(reconnect, 'welcome').luckyBox.nextSpawnAt, collectedAt + BOX_COOLDOWN);
  assert.equal(h.room().coinSnapshot()[coin.id].respawnAt, collectedAt + 60000);
});

test('P8 VIP live socket, seat generation, save, economy and collection-time cooldown recover through both authorities', async t => {
  const h = fixture(t), uid = 'p8-vip-recovery'; await paid(h, uid);
  const connection = await h.connect({ uid, server: 'vip1' });
  const coin = h.room('vip1').coinSnapshot()[22], box = h.room('vip1').boxSnapshot();
  h.place(connection, contact(coin));
  await connection.send({ type: 'collect', id: coin.id, requestId: 'p8-vip-coin' });
  h.place(connection, contact(box));
  const collectedAt = h.now();
  await connection.send({ type: 'collect_box', requestId: 'p8-vip-box-claim' });
  const player = connection.attachment(), saved = h.room('vip1').sessions.row(uid);
  const durableBox = boxRow(h.room('vip1'));
  const centralSeat = h.room().sql.exec('SELECT * FROM voxel_vip_seats WHERE uid=?', uid).toArray()[0];
  assert.equal(durableBox.next_spawn_at, collectedAt + BOX_COOLDOWN);
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  const restored = h.restartRoom({ keepSockets: true, server: 'vip1' }); await restored.ready;
  assert.equal(restored.serverScope, 'vip1');
  assert.deepEqual(restored.sessions.row(uid), saved);
  assert.deepEqual(boxRow(restored), durableBox);
  assert.deepEqual(h.room().sql.exec('SELECT * FROM voxel_vip_seats WHERE uid=?', uid).toArray()[0], centralSeat);
  assert.equal(restored.count(), 1);
  await h.advance(1200);
  await packet(h, restored, connection, { type: 'spin_box', requestId: 'p8-vip-spin' });
  const reward = last(connection, 'box_reward')?.reward;
  assert.ok([100, 500, 1000, 5000, 9999].includes(reward));
  assert.equal(restored.economy.score(uid), 1 + reward);
  assert.equal(boxRow(restored).next_spawn_at, durableBox.next_spawn_at);
  assert.equal(restored.coinSnapshot()[coin.id].respawnAt, collectedAt + 60000);
  assert.deepEqual(position(restored.sessions.row(uid)), position(connection.attachment()));
  assert.equal(h.room().vip.count(), 1);
  const replacement = await h.connect({ uid, server: 'vip1' });
  assert.equal(replacement.attachment().id, player.id);
  assert.notEqual(replacement.attachment().sessionId, player.sessionId);
  const successorSeat = h.room().sql.exec('SELECT * FROM voxel_vip_seats WHERE uid=?', uid).toArray()[0];
  await restored.webSocketClose(connection.server); await h.settle();
  assert.deepEqual(h.room().sql.exec('SELECT * FROM voxel_vip_seats WHERE uid=?', uid).toArray()[0], successorSeat);
  assert.equal(h.room().vip.count(), 1);
  assert.equal(h.room().coinSnapshot()[coin.id].respawnAt, 0, 'VIP resource state cannot leak into Free world');
});

test('P8 provider activation real SQLite rollback and concurrent signed retries produce one entitlement receipt after restart', async t => {
  const h = fixture(t), uid = 'p8-provider-rollback', activation = event(h, uid);
  await h.room().ready;
  failWrite(h.room(), 'voxel_vip_events', 'INSERT', 'p8_provider_receipt_abort');
  const failed = await webhook(h, activation); assert.equal(failed.status, 503);
  assert.equal(h.room().vip.entitlement(uid).active, false);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_vip_subscriptions').toArray()[0].n, 0);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_vip_events').toArray()[0].n, 0);
  h.room().sql.exec('DROP TRIGGER p8_provider_receipt_abort');
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  const deliveries = await Promise.all(Array.from({ length: 8 }, (_, index) => webhook(h,
    index % 2 ? JSON.stringify(Object.fromEntries(Object.entries(activation).reverse()), null, 2) : activation)));
  assert.ok(deliveries.every(response => response.status === 200));
  const results = await Promise.all(deliveries.map(response => response.json()));
  assert.equal(results.filter(result => result.replayed === false).length, 1);
  assert.equal(results.filter(result => result.replayed === true).length, 7);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_vip_events').toArray()[0].n, 1);
  assert.equal(h.room().vip.entitlement(uid).expiresAt, activation.periodEnd);
  const connection = await h.connect({ uid, server: 'vip1' });
  assert.ok(last(connection, 'welcome'));
  assert.equal(h.room().vip.count(), 1);
});

test('P8 provider revocation rollback preserves seat until commit; recovery/retry retires exactly that generation', async t => {
  const h = fixture(t), uid = 'p8-revocation-rollback', activation = event(h, uid);
  assert.equal((await webhook(h, activation)).status, 200);
  const connection = await h.connect({ uid, server: 'vip1' });
  const beforeSeat = h.room().sql.exec('SELECT * FROM voxel_vip_seats WHERE uid=?', uid).toArray()[0];
  const revocation = { ...activation, eventId: 'p8-revocation-rollback:2', version: 2, status: 'revoked' };
  failWrite(h.room(), 'voxel_vip_events', 'INSERT', 'p8_revocation_abort');
  assert.equal((await webhook(h, revocation)).status, 503);
  assert.equal(connection.client.closed, false);
  assert.equal(h.room().vip.entitlement(uid).active, true);
  assert.deepEqual(h.room().sql.exec('SELECT * FROM voxel_vip_seats WHERE uid=?', uid).toArray()[0], beforeSeat);
  h.room().sql.exec('DROP TRIGGER p8_revocation_abort');
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  const restored = h.restartRoom({ keepSockets: true, server: 'vip1' }); await restored.ready;
  assert.equal((await webhook(h, revocation)).status, 200);
  assert.equal(connection.client.closed, true);
  assert.equal(h.room().vip.count(), 0);
  assert.equal(restored.sessions.row(uid).lease_expires, 0);
  const retry = await webhook(h, revocation);
  assert.equal(retry.status, 200); assert.equal((await retry.json()).replayed, true);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_vip_events').toArray()[0].n, 2);
  const denied = await h.connect({ uid, server: 'vip1' });
  assert.equal(denied.messages('welcome').length, 0);
  const free = await h.connect({ uid: 'p8-revocation-free', zone: '4,4' });
  assert.ok(last(free, 'welcome'));
});

test('P8 seeded signed-byte tampering and stale provider replay never change authoritative entitlement or capacity', async t => {
  const h = fixture(t), uid = 'p8-webhook-fuzz', activation = event(h, uid), random = seeded(0x80378037);
  assert.equal((await webhook(h, activation)).status, 200);
  const before = h.room().sql.exec('SELECT * FROM voxel_vip_subscriptions WHERE uid=?', uid).toArray()[0];
  for (let index = 0; index < 32; index++) {
    const request = signed(h, activation);
    const mutations = [{ ...activation, uid: `forged-${random()}` }, { ...activation, amount: random() % 50 },
      { ...activation, status: 'revoked', version: 999 }, { ...activation, periodEnd: activation.periodEnd + 1 }];
    request.body = JSON.stringify(mutations[index % mutations.length]);
    const response = await h.request('/payments/webhook', request);
    assert.equal(response.status, 401, 'changing signed bytes invalidates provider authority');
    assert.deepEqual(h.room().sql.exec('SELECT * FROM voxel_vip_subscriptions WHERE uid=?', uid).toArray()[0], before);
  }
  await h.advance(300001);
  const expiredSignature = signed(h, activation, { 'x-provider-timestamp': String(Math.floor((h.now() - 300001) / 1000)) });
  assert.equal((await h.request('/payments/webhook', expiredSignature)).status, 401);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_vip_events').toArray()[0].n, 1);
  assert.equal(h.room().vip.count(), 0);
  assert.equal(h.room().vip.entitlement(uid).active, true);
});
