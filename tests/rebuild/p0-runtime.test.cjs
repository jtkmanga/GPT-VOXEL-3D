'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, CERTS_URL, SLIP_URL } = require('./harness.cjs');

function harness(t, options) {
  const h = createHarness(options);
  t.after(() => h.close());
  return h;
}
function last(connection, type) { return connection.messages(type).at(-1); }
function score(h, uid) {
  return h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0]?.score ?? 0;
}

test('P0 startup routes, origins, methods and Durable Object entrypoints', async t => {
  const h = harness(t);
  const health = await h.request('/health');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'VOXEL RUN v4 online');
  assert.equal((await h.request('/missing')).status, 404);
  assert.equal((await h.request('/play')).status, 404);
  assert.equal((await h.request('/play?zone=10,0', { headers: { Upgrade: 'websocket' } })).status, 400);
  assert.equal((await h.request('/play', { headers: { Upgrade: 'websocket', Origin: 'https://other.invalid' } })).status, 403);
  assert.equal((await h.request('/entitlements', { method: 'POST' })).status, 405);
  assert.equal((await h.request('/verify-slip')).status, 405);
  assert.equal((await h.request('/entitlements', { method: 'OPTIONS' })).status, 204);
  assert.equal((await h.request('/verify-slip', { method: 'OPTIONS' })).status, 204);
  const room = await h.open('/play');
  const zone = await h.open('/play?zone=4,4');
  assert.equal(room.attachment().acceptedAt, h.now());
  assert.equal(zone.attachment().zoneId, '4,4');
  assert.ok(h.records.routes.some(route => route.binding === 'ROOM' && route.name === 'free-v2-demo'));
  assert.ok(h.records.routes.some(route => route.binding === 'ZONE' && route.name === 'free-zone-4,4'));
});

test('P0 actual Firebase verifier accepts synthetic RSA token and rejects expiry, claims and signatures', async t => {
  const h = harness(t);
  const valid = await h.runtime.verifyFirebaseIdToken(h.token('synthetic-auth'), h.env.FIREBASE_PROJECT_ID);
  assert.equal(valid.uid, 'synthetic-auth');
  assert.equal(valid.exp, Math.floor(h.now() / 1000) + 3600);
  await assert.rejects(h.runtime.verifyFirebaseIdToken(h.token('synthetic-auth', { exp: Math.floor(h.now() / 1000) }), h.env.FIREBASE_PROJECT_ID), /Invalid token claims/);
  await assert.rejects(h.runtime.verifyFirebaseIdToken(h.token('synthetic-auth', { aud: 'other-project' }), h.env.FIREBASE_PROJECT_ID), /Invalid token claims/);
  const validToken = h.token('synthetic-auth');
  const parts = validToken.split('.');
  const bytes = Buffer.from(parts[2], 'base64url');
  bytes[0] ^= 1;
  const invalidSignature = `${parts[0]}.${parts[1]}.${bytes.toString('base64url')}`;
  await assert.rejects(h.runtime.verifyFirebaseIdToken(invalidSignature, h.env.FIREBASE_PROJECT_ID), /Invalid token signature/);
  const connection = await h.connect({ uid: 'synthetic-auth', name: '  Alpha\n   test  ' });
  const welcome = last(connection, 'welcome');
  assert.ok(Number.isInteger(welcome.protocol));
  assert.equal(welcome.count, 1);
  assert.equal(connection.attachment().uid, 'synthetic-auth');
  assert.equal(connection.attachment().nickname, 'Alpha test');
  assert.equal(welcome.coins.length, 200);
  assert.equal(welcome.luckyBox.active, true);
  assert.ok(h.records.fetches.every(record => record.url === CERTS_URL));
});

test('P0 socket rejects invalid auth, unauthenticated movement, expired token and UID switch', async t => {
  const h = harness(t);
  const invalid = await h.connect({ auth: false });
  await invalid.send({ type: 'auth', token: 'synthetic-invalid-token' });
  assert.equal(last(invalid, 'auth_error').message, 'Firebase sign-in failed');
  assert.equal(invalid.client.closeInfo.code, 1008);
  const unauthenticated = await h.connect({ auth: false });
  await unauthenticated.send({ type: 'move', x: 0, y: 0, z: 0, r: 0 });
  assert.equal(unauthenticated.client.closeInfo.code, 1008);
  const refreshed = await h.connect({ uid: 'synthetic-refresh' });
  const initialId = refreshed.attachment().id;
  await h.advance(1000);
  await refreshed.send({ type: 'auth', token: h.token('synthetic-refresh') });
  assert.equal(last(refreshed, 'auth_refreshed').type, 'auth_refreshed');
  assert.equal(refreshed.attachment().id, initialId);
  await refreshed.send({ type: 'auth', token: h.token('synthetic-different') });
  assert.equal(refreshed.client.closeInfo.code, 1008);
  const expired = await h.connect({ uid: 'synthetic-expiring', token: h.token('synthetic-expiring', { exp: Math.floor(h.now() / 1000) + 1 }) });
  await h.advance(1000);
  await expired.send({ type: 'move', x: 0, y: 0, z: 0, r: 0 });
  assert.equal(expired.client.closeInfo.code, 1008);
});

test('P0 multiplayer movement reaches nearby peers, preserves direction control and enforces rate/range', async t => {
  const h = harness(t);
  const mover = await h.connect({ uid: 'synthetic-mover' });
  const near = await h.connect({ uid: 'synthetic-near' });
  const distant = await h.connect({ uid: 'synthetic-distant' });
  assert.equal(last(near, 'welcome').players.length, 1);
  assert.equal(last(mover, 'join').player.id, distant.attachment().id);
  h.place(mover, { x: 0, y: 0, z: 0, r: 0 });
  h.place(near, { x: 100, y: 0, z: 0, r: 0 });
  h.place(distant, { x: 300, y: 0, z: 0, r: 0 });
  near.clear(); distant.clear();
  for (const position of [{ x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }, { x: 0, z: 0 }]) {
    await h.advance(200);
    await mover.send({ type: 'move', ...position, y: 0, r: 0 });
    assert.equal(mover.attachment().x, position.x);
    assert.equal(mover.attachment().z, position.z);
  }
  assert.equal(near.messages('move').length, 4);
  assert.equal(distant.messages('move').length, 0);
  await h.advance(199);
  await mover.send({ type: 'move', x: 1, y: 0, z: 0, r: 0 });
  assert.equal(mover.attachment().x, 0);
  await h.advance(1);
  await mover.send({ type: 'move', x: 1, y: 0, z: 0, r: 0 });
  assert.equal(mover.attachment().x, 1);
  await h.advance(200);
  await mover.send({ type: 'move', x: 500, y: 0, z: 0, r: 0 });
  await mover.send({ type: 'move', x: 749, y: 0, z: 0, r: 0 });
  assert.equal(mover.attachment().x, 1);
  await mover.close();
  assert.equal(last(near, 'leave').id, mover.attachment().id);
});

test('P0 coins have 200 slots, single persisted reward, shared disappearance and 60 second respawn', async t => {
  const h = harness(t);
  const collector = await h.connect({ uid: 'synthetic-collector' });
  const observer = await h.connect({ uid: 'synthetic-observer' });
  const snapshot = h.room().coinSnapshot();
  assert.equal(snapshot.length, 200);
  assert.equal(new Set(snapshot.map(coin => coin.id)).size, 200);
  const original = snapshot[0];
  h.place(collector, { x: original.x, y: 0, z: original.z, r: 0 });
  const collectedAt = h.now();
  await collector.send({ type: 'collect', id: 0 });
  assert.equal(score(h, 'synthetic-collector'), 1);
  assert.equal(last(collector, 'score').score, 1);
  const event = last(observer, 'coin_collected');
  assert.equal(event.id, 0);
  assert.equal(event.respawnAt, collectedAt + 60_000);
  assert.equal(event.cycle, 1);
  assert.equal(last(collector, 'coin_collected').respawnAt, event.respawnAt);
  const next = h.room().coinSnapshot()[0];
  h.place(collector, { x: next.x, y: 0, z: next.z, r: 0 });
  await h.advance(150);
  await collector.send({ type: 'collect', id: 0 });
  assert.equal(score(h, 'synthetic-collector'), 1);
  assert.equal(last(collector, 'coin_state').respawnAt, event.respawnAt);
  await h.setTime(collectedAt + 59_999);
  assert.ok(h.room().coinSnapshot()[0].respawnAt > h.now());
  await h.advance(1);
  await collector.send({ type: 'collect', id: 0 });
  assert.equal(score(h, 'synthetic-collector'), 2);
  assert.equal(h.room().coinSnapshot().length, 200);
});

test('P0 Lucky Box is one persisted box, single claimed reward and four hour cooldown', async t => {
  const h = harness(t);
  const first = await h.connect({ uid: 'synthetic-box-first' });
  const second = await h.connect({ uid: 'synthetic-box-second' });
  const box = h.room().boxSnapshot();
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_lucky_box').toArray()[0].count, 1);
  assert.equal(box.active, true);
  assert.ok(Math.hypot(box.x, box.z) >= 120);
  h.place(first, { x: box.x, y: 0, z: box.z, r: 0 });
  h.place(second, { x: box.x, y: 0, z: box.z, r: 0 });
  await first.send({ type: 'collect_box' });
  assert.ok(last(first, 'box_spin_ready'));
  await second.send({ type: 'collect_box' });
  assert.equal(second.messages('box_spin_ready').length, 0);
  await first.send({ type: 'spin_box' });
  const reward = last(first, 'box_reward').reward;
  assert.ok([100, 500, 1000, 5000, 9999].includes(reward));
  assert.equal(score(h, 'synthetic-box-first'), reward);
  assert.equal(score(h, 'synthetic-box-second'), 0);
  const cooling = h.room().boxSnapshot();
  assert.equal(cooling.nextSpawnAt, h.now() + 4 * 60 * 60 * 1000);
  assert.equal(cooling.active, false);
  assert.equal(cooling.cycle, 1);
  await first.send({ type: 'spin_box' });
  assert.equal(first.messages('box_reward').length, 1);
  assert.equal(score(h, 'synthetic-box-first'), reward);
  h.restartRoom();
  await h.room().ready;
  assert.equal(h.room().boxSnapshot().nextSpawnAt, cooling.nextSpawnAt);
  await h.setTime(cooling.nextSpawnAt - 1);
  assert.equal(h.room().boxSnapshot().active, false);
  await h.advance(1);
  assert.equal(h.room().boxSnapshot().active, true);
});

test('P0 score, leaderboard and coin cooldown survive actual SQLite restart and reconnect', async t => {
  const h = harness(t);
  const first = await h.connect({ uid: 'synthetic-persistent' });
  const coin = h.room().coinSnapshot()[3];
  h.place(first, { x: coin.x, y: 0, z: coin.z, r: 0 });
  await first.send({ type: 'collect', id: coin.id });
  const cooldown = h.room().coinSnapshot()[3].respawnAt;
  await first.close();
  h.restartRoom();
  const reconnected = await h.connect({ uid: 'synthetic-persistent' });
  assert.equal(last(reconnected, 'welcome').score, 1);
  assert.equal(last(reconnected, 'welcome').coins[3].respawnAt, cooldown);
  assert.equal(last(reconnected, 'welcome').leaderboard[0].score, 1);
  assert.equal(score(h, 'synthetic-persistent'), 1);
});

test('P0 synthetic slip payment grants server entitlement for VIP 50 THB / 30 days once', async t => {
  const h = harness(t);
  assert.equal((await h.request('/entitlements')).status, 401);
  const form = new FormData();
  form.append('item', 'vip1');
  form.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'synthetic.png', { type: 'image/png' }));
  const authorization = `Bearer ${h.token('synthetic-payer')}`;
  const paid = await h.request('/verify-slip', { method: 'POST', headers: { Authorization: authorization }, body: form });
  assert.equal(paid.status, 200);
  const result = await paid.json();
  assert.equal(result.ok, true);
  assert.equal(result.price, 50);
  assert.equal(result.item, 'vip1');
  assert.equal(result.expiresAt, h.now() + 30 * 24 * 60 * 60 * 1000);
  const entitlements = await (await h.request('/entitlements', { headers: { Authorization: authorization } })).json();
  assert.equal(entitlements.active.vip1, true);
  assert.equal(entitlements.entitlements.vip1Expires, result.expiresAt);
  assert.equal(entitlements.servers.vip1.max, 100);
  const duplicate = await h.request('/verify-slip', { method: 'POST', headers: { Authorization: authorization }, body: form });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_payments').toArray()[0].count, 1);
  assert.ok(h.records.fetches.some(record => record.url === SLIP_URL));
  assert.ok(h.records.fetches.every(record => [CERTS_URL, SLIP_URL].includes(record.url)));
});

test('P0 zoned bootstrap and coin collection share logical-server world and persisted leaderboard', async t => {
  const h = harness(t);
  const main = await h.connect({ uid: 'synthetic-main' });
  const coin = h.room().coinSnapshot()[8];
  const half = 750;
  const zoneId = `${Math.floor((coin.x + half) / 150)},${Math.floor((coin.z + half) / 150)}`;
  const zoned = await h.connect({ zone: zoneId, uid: 'synthetic-zoned', name: 'Zone player' });
  const welcome = last(zoned, 'welcome');
  assert.equal(welcome.zone, zoneId);
  assert.equal(welcome.coins.length, 200);
  assert.equal(welcome.luckyBox.x, last(main, 'welcome').luckyBox.x);
  h.place(zoned, { x: coin.x, y: 0, z: coin.z, r: 0 });
  await zoned.send({ type: 'collect', id: coin.id });
  const collected = last(zoned, 'coin_collect_result');
  assert.equal(collected.collected, true);
  assert.equal(collected.score, 1);
  assert.equal(score(h, 'synthetic-zoned'), 1);
  assert.equal(h.room().coinSnapshot()[8].respawnAt, collected.event.respawnAt);
  assert.equal(h.room().top()[0].nickname, 'Zone player');
  const another = await h.connect({ zone: '5,5', uid: 'synthetic-zone-another' });
  assert.equal(last(another, 'welcome').coins[8].respawnAt, collected.event.respawnAt);
  assert.equal(last(another, 'welcome').leaderboard[0].score, 1);
  assert.equal(h.room().coinSnapshot().length, 200);
});

test('P0 zone crossing uses one-use expiring ticket, preserves player identity and resumes valid movement', async t => {
  const h = harness(t);
  const uid = 'synthetic-handoff';
  const source = await h.connect({ zone: '4,4', uid });
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await source.send({ type: 'move', x: 1, y: 0, z: -75, r: 0 });
  const change = last(source, 'zone_change');
  assert.equal(change.from, '4,4');
  assert.equal(change.zone, '5,4');
  assert.equal(change.expiresAt, h.now() + 12_000);
  assert.ok(change.handoffToken);
  const target = await h.connect({ zone: '5,4', uid, handoffToken: change.handoffToken });
  const welcome = last(target, 'welcome');
  assert.equal(welcome.handoff, true);
  assert.equal(welcome.id, source.attachment().id);
  assert.equal(welcome.spawn.x, 1);
  await h.advance(200);
  await target.send({ type: 'handoff_resume', x: 2, y: 0, z: -75, r: 0 });
  assert.equal(last(target, 'handoff_resumed').x, 2);
  assert.equal(target.attachment().handoffResume, null);
  await source.close();
  const replay = await h.connect({ zone: '5,4', uid, handoffToken: change.handoffToken });
  assert.equal(replay.client.closeInfo.code, 1008);
  assert.ok(last(replay, 'handoff_error'));
  const expiringSource = await h.connect({ zone: '4,4', uid: 'synthetic-ticket-expiry' });
  h.place(expiringSource, { x: -1, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await expiringSource.send({ type: 'move', x: 1, y: 0, z: -75, r: 0 });
  const expiring = last(expiringSource, 'zone_change');
  await h.advance(12_001);
  const expired = await h.connect({ zone: '5,4', uid: 'synthetic-ticket-expiry', handoffToken: expiring.handoffToken });
  assert.equal(expired.client.closeInfo.code, 1008);
  assert.ok(last(expired, 'handoff_error'));
});
