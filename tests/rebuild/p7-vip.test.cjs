'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHmac, webcrypto } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { createHarness } = require('./harness.cjs');
globalThis.crypto ||= webcrypto;
const modules = Promise.all(['payment-events.mjs', 'vip-store.mjs'].map(file =>
  import(pathToFileURL(path.join(__dirname, '../../src/worker', file)))));
const SYNTHETIC_SECRET = 'synthetic-p7-only-provider-signing-fixture';

function event(uid = 'synthetic-vip-user', changes = {}) {
  const now = Date.now();
  return { eventId: `event:${uid}:1`, subscriptionId: `subscription:${uid}`, uid,
    version: 1, status: 'active', product: 'vip1', amount: 50, currency: 'THB',
    periodStart: now - 1000, periodEnd: now - 1000 + 30 * 24 * 60 * 60 * 1000,
    ...changes };
}
function signed(body, changes = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', SYNTHETIC_SECRET).update(timestamp + '.' + text).digest('hex');
  return new Request('https://synthetic.invalid/payments/webhook', {
    method: 'POST', body: text,
    headers: { 'content-type': 'application/json', 'x-provider-timestamp': timestamp,
      'x-provider-signature': signature, ...changes }
  });
}
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  let nesting = 0;
  const storage = {
    sql: { exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows.map(row => ({ ...row })) };
    } },
    transactionSync(callback) {
      if (nesting) return callback();
      db.exec('BEGIN IMMEDIATE'); nesting++;
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { nesting--; }
    }
  };
  storage.sql.exec(`CREATE TABLE voxel_entitlements (uid TEXT PRIMARY KEY,
    speed_expires INTEGER NOT NULL DEFAULT 0,coin_expires INTEGER NOT NULL DEFAULT 0,
    vip1_expires INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)`);
  return { storage, db };
}
async function apply(store, e) {
  const [{ verifyPaymentEvent }] = await modules;
  const verified = await verifyPaymentEvent(signed(e), { PAYMENT_WEBHOOK_SECRET: SYNTHETIC_SECRET });
  return store.applyEvent(verified);
}
const admission = (uid, changes = {}) => ({ uid, sessionId: `session:${uid}:1`,
  exp: Math.floor(Date.now() / 1000) + 3600, ...changes });

test('P7 signed provider activation strictly verifies 50 THB monthly product and fingerprint', async () => {
  const [{ verifyPaymentEvent, VIP_PRODUCT }] = await modules;
  assert.equal(VIP_PRODUCT.amount, 50); assert.equal(VIP_PRODUCT.currency, 'THB');
  assert.equal(VIP_PRODUCT.duration, 30 * 24 * 60 * 60 * 1000);
  assert.equal(VIP_PRODUCT.capacity, 100);
  const payload = event();
  const verified = await verifyPaymentEvent(signed(payload), { PAYMENT_WEBHOOK_SECRET: SYNTHETIC_SECRET });
  assert.deepEqual(verified.event, payload); assert.match(verified.fingerprint, /^[a-f0-9]{64}$/);
  const reordered = Object.fromEntries(Object.entries(payload).reverse());
  const retry = await verifyPaymentEvent(signed(JSON.stringify(reordered, null, 2)), { PAYMENT_WEBHOOK_SECRET: SYNTHETIC_SECRET });
  assert.equal(retry.fingerprint, verified.fingerprint);
});

test('P7 unconfigured, weak, unsigned, tampered and expired payment events fail closed', async () => {
  const [{ verifyPaymentEvent }] = await modules;
  const env = { PAYMENT_WEBHOOK_SECRET: SYNTHETIC_SECRET };
  await assert.rejects(verifyPaymentEvent(signed(event()), {}), error => error.status === 503);
  await assert.rejects(verifyPaymentEvent(signed(event()), { PAYMENT_WEBHOOK_SECRET: 'weak' }), error => error.status === 503);
  for (const headers of [
    { 'x-provider-signature': '' },
    { 'x-provider-signature': '0'.repeat(64) },
    { 'x-provider-timestamp': String(Math.floor(Date.now() / 1000) - 301) }
  ]) await assert.rejects(verifyPaymentEvent(signed(event(), headers), env), error => error.status === 401);
  const e = event(), original = signed(e);
  await assert.rejects(verifyPaymentEvent(new Request(original.url, {
    method: 'POST', headers: original.headers, body: JSON.stringify({ ...e, uid: 'forged-user' })
  }), env), error => error.status === 401);
});

test('P7 malformed schemas, forged price/result/flags, invalid JSON and oversized body rejected', async () => {
  const [{ verifyPaymentEvent }] = await modules;
  const env = { PAYMENT_WEBHOOK_SECRET: SYNTHETIC_SECRET };
  for (const e of [event('a', { amount: 1 }), event('a', { amount: '50' }),
    event('a', { currency: 'USD' }), event('a', { product: 'vip2' }), event('a', { vip: true }),
    event('a', { paid: true }), event('a', { version: 0 }), event('a', { uid: '' }),
    event('a', { status: 'approved' }), event('a', { periodEnd: Date.now() + 999999999999 }),
    event('a', { status: 'expired' }), null, []])
    await assert.rejects(verifyPaymentEvent(signed(e), env), error => error.status === 400);
  await assert.rejects(verifyPaymentEvent(signed('{'), env), error => error.status === 400);
  await assert.rejects(verifyPaymentEvent(signed('x'.repeat(16385)), env), error => error.status === 413);
  await assert.rejects(verifyPaymentEvent(signed(event(), { 'content-length': '16385' }), env), error => error.status === 413);
  await assert.rejects(verifyPaymentEvent(signed(event(), { 'content-type': 'text/plain' }), env), error => error.status === 415);
});

test('P7 event idempotency, ID conflicts, stale versions and subscription identity ownership', async t => {
  const [, { VipStore }] = await modules, ctx = fixture(t), store = new VipStore(ctx);
  const original = event('alpha');
  const first = await apply(store, original); assert.equal(first.ok, true);
  const retry = await apply(store, original); assert.equal(retry.ok, true); assert.equal(retry.replayed, true);
  assert.equal(ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM voxel_vip_events').toArray()[0].count, 1);
  assert.equal((await apply(store, { ...original, uid: 'beta' })).ok, false);
  assert.equal((await apply(store, event('beta', { subscriptionId: original.subscriptionId }))).ok, false);
  assert.equal((await apply(store, event('alpha', { eventId: 'new-id', subscriptionId: 'other-subscription' }))).ok, false);
  const revoked = { ...original, eventId: 'revoke-alpha', version: 2, status: 'revoked' };
  assert.equal((await apply(store, revoked)).ok, true); assert.equal(store.entitlement('alpha').active, false);
  const late = await apply(store, { ...original, eventId: 'late-alpha' });
  assert.equal(late.ok, false); assert.equal(late.stale, true);
  assert.equal((await apply(store, original)).replayed, true);
  assert.equal(store.entitlement('alpha').active, false, 'Replay never reactivates a revoked subscription');
});

test('P7 entitlement lifecycle and restart persist without overwriting economy buffs', async t => {
  const [, { VipStore }] = await modules, ctx = fixture(t), store = new VipStore(ctx);
  ctx.storage.sql.exec('INSERT INTO voxel_entitlements(uid,speed_expires,coin_expires,updated_at) VALUES (?,?,?,?)',
    'alpha', 123456, 234567, Date.now());
  const e = event('alpha'); assert.equal((await apply(store, e)).ok, true);
  assert.equal(store.entitlement('alpha').active, true);
  const persisted = new VipStore(ctx); assert.equal(persisted.entitlement('alpha').expiresAt, e.periodEnd);
  assert.equal(persisted.entitlement('alpha', e.periodEnd).active, false);
  const row = ctx.storage.sql.exec('SELECT * FROM voxel_entitlements WHERE uid=?', 'alpha').toArray()[0];
  assert.equal(row.speed_expires, 123456); assert.equal(row.coin_expires, 234567);
  const ended = event('expired-alpha', { status: 'expired', periodStart: Date.now() - 30 * 24 * 60 * 60 * 1000 - 1000,
    periodEnd: Date.now() - 1000 });
  assert.equal((await apply(persisted, ended)).ok, true);
  assert.equal(persisted.entitlement('expired-alpha').active, false);
});

test('P7 provider mutation rollback preserves entitlement and permits exact retry', async t => {
  const [, { VipStore }] = await modules, ctx = fixture(t), store = new VipStore(ctx);
  const e = event('rollback'), exec = ctx.storage.sql.exec;
  ctx.storage.sql.exec = (query, ...bindings) => {
    if (/INSERT INTO voxel_vip_events/.test(query)) throw Error('synthetic storage failure');
    return exec(query, ...bindings);
  };
  await assert.rejects(apply(store, e), /synthetic storage failure/);
  ctx.storage.sql.exec = exec;
  assert.equal(store.entitlement(e.uid).active, false);
  assert.equal(ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM voxel_vip_subscriptions').toArray()[0].count, 0);
  assert.equal((await apply(store, e)).ok, true);
});

test('P7 current authoritative entitlement required; malformed admissions cannot create seats', async t => {
  const [, { VipStore }] = await modules, ctx = fixture(t), store = new VipStore(ctx);
  assert.equal(store.admit(admission('free-user')).ok, false);
  for (const bad of [{ uid: '', sessionId: 's', exp: 1 }, admission('a', { sessionId: '' }),
    admission('a', { exp: '9999999999' }), admission('a', { exp: 0 }), admission('a', { previousSessionId: 7 })])
    assert.equal(store.admit(bad).ok, false);
  assert.equal(store.count(), 0);
  await apply(store, event('paid'));
  assert.equal(store.admit(admission('paid', { exp: Math.floor(Date.now() / 1000) })).ok, false);
  assert.equal(store.admit(admission('paid')).ok, true);
  assert.equal(store.validate(admission('paid')).ok, true);
  assert.equal(store.validate(admission('forged')).ok, false);
});

test('P7 VIP allows exactly 100 concurrent seats and rejects 101st; extra entitlements are permitted', async t => {
  const [, { VipStore }] = await modules, ctx = fixture(t), store = new VipStore(ctx);
  for (let i = 0; i < 101; i++) assert.equal((await apply(store, event(`capacity-${i}`))).ok, true);
  for (let i = 0; i < 100; i++) assert.equal(store.admit(admission(`capacity-${i}`)).ok, true);
  assert.equal(store.count(), 100);
  const extra = store.admit(admission('capacity-100')); assert.equal(extra.ok, false); assert.equal(extra.full, true);
});

test('P7 concurrent admission race cannot overflow 100 seats', async t => {
  const [, { VipStore }] = await modules, ctx = fixture(t), store = new VipStore(ctx);
  await Promise.all(Array.from({ length: 110 }, (_, i) => apply(store, event(`race-${i}`))));
  const results = await Promise.all(Array.from({ length: 110 }, (_, i) =>
    Promise.resolve().then(() => store.admit(admission(`race-${i}`)))));
  assert.equal(results.filter(result => result.ok).length, 100);
  assert.equal(results.filter(result => !result.ok && result.full).length, 10);
  assert.equal(store.count(), 100);
});

test('P7 duplicate/replaced sessions, reconnect and stale admit/close/renew preserve one seat', async t => {
  const [, { VipStore }] = await modules, ctx = fixture(t), store = new VipStore(ctx);
  await apply(store, event('reconnect'));
  const first = admission('reconnect'), second = admission('reconnect', { sessionId: 'new-session', previousSessionId: first.sessionId });
  assert.equal(store.admit(first).ok, true); assert.equal(store.admit(first).replayed, true);
  assert.equal(store.admit({ ...second, previousSessionId: null }).ok, false);
  assert.equal(store.admit(second).ok, true); assert.equal(store.count(), 1);
  assert.equal(store.admit(first).ok, false); assert.equal(store.validate(first).ok, false);
  assert.equal(store.renew(first).ok, false); assert.equal(store.release(first).ok, false);
  assert.equal(store.validate(second).ok, true);
  const restarted = new VipStore(ctx); assert.equal(restarted.validate(second).ok, true);
  assert.equal(restarted.release(second).ok, true); assert.equal(store.count(), 0);
  assert.equal(restarted.admit(second).ok, false, 'Released generation cannot revive a session');
  assert.equal(restarted.admit(admission('reconnect', { sessionId: 'third-session', previousSessionId: 'new-session' })).ok, true);
});

test('P7 revocation releases seat immediately and cannot be bypassed by legacy expiry writes', async t => {
  const [, { VipStore }] = await modules, ctx = fixture(t), store = new VipStore(ctx);
  const e = event('revoke-seat'), seat = admission(e.uid);
  await apply(store, e); assert.equal(store.admit(seat).ok, true);
  await apply(store, { ...e, eventId: 'revoked-seat', version: 2, status: 'revoked' });
  assert.equal(store.count(), 0); assert.equal(store.validate(seat).ok, false);
  ctx.storage.sql.exec('UPDATE voxel_entitlements SET vip1_expires=? WHERE uid=?', Date.now() + 9999999, e.uid);
  assert.equal(store.entitlement(e.uid).active, false);
  assert.equal(store.admit(admission(e.uid, { sessionId: 'revocation-bypass' })).ok, false);
});

test('P7 seat leases respect auth and entitlement expiry and expired generations cannot be revived', async t => {
  const [, { VipStore }] = await modules, ctx = fixture(t), store = new VipStore(ctx);
  const e = event('lease-seat'), seat = admission(e.uid);
  await apply(store, e); const admitted = store.admit(seat);
  assert.equal(admitted.ok, true); assert.ok(admitted.leaseExpiresAt <= Date.now() + 120000);
  assert.ok(admitted.leaseExpiresAt <= seat.exp * 1000); assert.ok(admitted.leaseExpiresAt <= e.periodEnd);
  assert.equal(store.count(admitted.leaseExpiresAt), 0);
  assert.equal(store.admit(seat).ok, false);
  assert.equal(store.admit(admission(e.uid, { sessionId: 'after-timeout' })).ok, true);
});

function runtimeFixture(t, options) {
  const h = createHarness(options);
  t.after(() => h.close());
  return h;
}
function runtimeEvent(h, uid, changes = {}) {
  return event(uid, { periodStart: h.now() - 1000,
    periodEnd: h.now() - 1000 + 30 * 24 * 60 * 60 * 1000, ...changes });
}
async function webhook(h, e, changes = {}) {
  const body = JSON.stringify(e), timestamp = String(Math.floor(h.now() / 1000));
  const signature = createHmac('sha256', SYNTHETIC_SECRET).update(timestamp + '.' + body).digest('hex');
  return h.request('/payments/webhook', { method: 'POST', body, headers: {
    'content-type': 'application/json', 'x-provider-timestamp': timestamp,
    'x-provider-signature': signature, ...changes
  } });
}

test('P7 bundled Worker verified webhook grants VIP; raw client endpoint cannot grant entitlement', async t => {
  const h = runtimeFixture(t), uid = 'worker-payer', e = runtimeEvent(h, uid);
  const paid = await webhook(h, e); assert.equal(paid.status, 200); assert.equal((await paid.json()).ok, true);
  const retry = await webhook(h, e); assert.equal(retry.status, 200); assert.equal((await retry.json()).replayed, true);
  const altered = await webhook(h, { ...e, amount: 1 }); assert.equal(altered.status, 400);
  const unsigned = await webhook(h, e, { 'x-provider-signature': '0'.repeat(64) }); assert.equal(unsigned.status, 401);
  const internal = await h.request('/_internal/vip/apply-event', { method: 'POST', body: JSON.stringify({ event: e }) });
  assert.equal(internal.status, 404);
  const clientPayment = await h.request('/payments/webhook', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uid: 'forged', vip: true, paid: true, amount: 50 }) });
  assert.equal(clientPayment.status, 401);
  const vip = await h.connect({ server: 'vip1', uid });
  assert.equal(vip.messages('welcome').length, 1); assert.equal(vip.messages('welcome')[0].server, 'vip1');
  assert.equal(vip.messages('welcome')[0].protocol, 4); assert.equal(vip.client.closed, false);
  const entitlement = await (await h.request('/entitlements', { headers: { Authorization: 'Bearer ' + h.token(uid) } })).json();
  assert.equal(entitlement.active.vip1, true); assert.deepEqual(entitlement.servers.vip1, { count: 1, max: 100 });
  assert.equal(h.room().vip.count(), 1);
});

test('P7 bundled Worker rejects unpaid, expired auth, forged VIP/UID/payment packets; Free unaffected', async t => {
  const h = runtimeFixture(t);
  const denied = await h.connect({ server: 'vip1', uid: 'unpaid' });
  assert.equal(denied.messages('welcome').length, 0); assert.equal(denied.client.closed, true);
  const free = await h.connect({ zone: '5,5', uid: 'free-player' }); assert.equal(free.messages('welcome').length, 1);
  const uid = 'verified-paid'; await webhook(h, runtimeEvent(h, uid));
  const expired = await h.connect({ server: 'vip1', uid, token: h.token(uid, { exp: Math.floor(h.now() / 1000) }) });
  assert.equal(expired.messages('welcome').length, 0); assert.equal(expired.client.closed, true);
  for (const fields of [{ vip: true }, { uid }, { payment: { paid: true, amount: 50 } }]) {
    const attacker = await h.open('/play?server=vip1');
    for (let i = 0; i < 3 && !attacker.client.closed; i++) await attacker.send({ type: 'auth', token: h.token('attacker'), ...fields });
    assert.equal(attacker.messages('welcome').length, 0); assert.equal(attacker.client.closed, true);
  }
  assert.equal(h.room().vip.count(), 0); assert.equal(free.client.closed, false);
  const invalid = await h.request('/play?server=vip1&zone=5,5', { headers: { Upgrade: 'websocket' } });
  assert.equal(invalid.status, 400);
});

test('P7 bundled Worker exact 100 seats and concurrent 101st capacity race; release/rejoin', async t => {
  const h = runtimeFixture(t);
  const users = Array.from({ length: 105 }, (_, i) => `worker-capacity-${i}`);
  const paid = await Promise.all(users.map(uid => webhook(h, runtimeEvent(h, uid))));
  assert.ok(paid.every(response => response.status === 200));
  const connections = await Promise.all(users.map(uid => h.connect({ server: 'vip1', uid })));
  const accepted = connections.filter(connection => connection.messages('welcome').length === 1);
  const rejected = connections.filter(connection => connection.messages('welcome').length === 0);
  assert.equal(accepted.length, 100); assert.equal(rejected.length, 5);
  assert.ok(rejected.every(connection => connection.client.closed)); assert.equal(h.room().vip.count(), 100);
  await accepted[0].close(); assert.equal(h.room().vip.count(), 99);
  const rejectedUid = rejected[0].messages('auth_error').length ? users[connections.indexOf(rejected[0])] : 'invalid';
  const retry = await h.connect({ server: 'vip1', uid: rejectedUid }); assert.equal(retry.messages('welcome').length, 1);
  assert.equal(h.room().vip.count(), 100);
  const free = await h.connect({ zone: '5,5', uid: 'still-free' }); assert.equal(free.messages('welcome').length, 1);
});

test('P7 bundled Worker session replacement, stale close and reconnect do not duplicate/release seats', async t => {
  const h = runtimeFixture(t), uid = 'worker-reconnect'; await webhook(h, runtimeEvent(h, uid));
  const first = await h.connect({ server: 'vip1', uid }), oldSession = first.attachment().sessionId;
  const replacement = await h.connect({ server: 'vip1', uid }); assert.equal(replacement.messages('welcome').length, 1);
  assert.equal(first.client.closed, true); assert.equal(h.room().vip.count(), 1);
  await first.close(); assert.equal(h.room().vip.count(), 1);
  const stale = await h.room('vip1').sessionCall('checkpoint', {
    uid, sessionId: oldSession, owner: 'room', checkpointRevision: 999, position: { x: 9, y: 0, z: 9, r: 0 }
  });
  assert.equal(stale.ok, false); assert.equal(h.room().vip.count(), 1);
  const resumeToken = replacement.attachment().resumeToken;
  await replacement.close(); assert.equal(h.room().vip.count(), 0);
  const resumed = await h.open('/play?server=vip1');
  await resumed.send({ type: 'auth', token: h.token(uid), name: 'Resumed', resumeToken });
  assert.equal(resumed.messages('welcome').length, 1); assert.equal(resumed.messages('welcome')[0].resumed, true);
  assert.equal(h.room().vip.count(), 1);
});

test('P7 bundled Worker entitlement revocation denies old-session mutation and frees capacity immediately', async t => {
  const h = runtimeFixture(t), uid = 'worker-revoked', e = runtimeEvent(h, uid);
  await webhook(h, e); const vip = await h.connect({ server: 'vip1', uid });
  const coin = h.room('vip1').coinSnapshot()[0]; h.place(vip, { x: coin.x, y: 0, z: coin.z, r: 0 });
  const revoke = await webhook(h, { ...e, eventId: 'worker-revoke-event', version: 2, status: 'revoked' });
  assert.equal(revoke.status, 200); assert.equal(h.room().vip.count(), 0);
  await vip.instance.webSocketMessage(vip.server, JSON.stringify({ type: 'collect', id: coin.id, requestId: 'revoked-coin-attempt' }));
  assert.equal(vip.client.closed, true); assert.equal(h.room('vip1').coinSnapshot()[0].respawnAt, 0);
  const reconnect = await h.connect({ server: 'vip1', uid }); assert.equal(reconnect.messages('welcome').length, 0);
  const late = await webhook(h, { ...e, eventId: 'worker-late-activation' }); assert.equal(late.status, 409);
  assert.equal((await webhook(h, e)).status, 200);
  assert.equal(h.room().vip.entitlement(uid).active, false);
});

test('P7 bundled Worker VIP world economy and leaderboard are isolated from Free world/zone fan-out', async t => {
  const h = runtimeFixture(t), uid = 'worker-isolated'; await webhook(h, runtimeEvent(h, uid));
  const free = await h.connect({ zone: '5,5', uid: 'free-isolated' }); free.clear();
  const vip = await h.connect({ server: 'vip1', uid });
  const coin = h.room('vip1').coinSnapshot()[1]; h.place(vip, { x: coin.x, y: 0, z: coin.z, r: 0 });
  await vip.send({ type: 'collect', id: coin.id, requestId: 'vip-coin' });
  assert.equal(vip.messages('coin_collected').at(-1).id, coin.id);
  assert.equal(h.room('vip1').economy.score(uid), 1); assert.equal(h.room().coinSnapshot()[1].respawnAt, 0);
  assert.equal(free.messages('coin_collected').length, 0); assert.equal(free.messages('leaderboard').length, 0);
  assert.ok(h.room('vip1').top().some(row => row.score === 1));
  assert.equal(h.room().top().some(row => row.score === 1), false);
});

test('P7 bundled Worker VIP persistence, central entitlement and seats survive instance restart', async t => {
  const h = runtimeFixture(t), uid = 'worker-restart'; await webhook(h, runtimeEvent(h, uid));
  const vip = await h.connect({ server: 'vip1', uid });
  const coin = h.room('vip1').coinSnapshot()[2]; h.place(vip, { x: coin.x, y: 0, z: coin.z, r: 0 });
  await vip.send({ type: 'collect', id: coin.id, requestId: 'vip-before-restart' });
  const expiry = h.room('vip1').coinSnapshot()[2].respawnAt;
  const resumeToken = vip.attachment().resumeToken;
  h.restartRoom(); const restarted = h.restartRoom({ server: 'vip1' }); await restarted.ready;
  assert.equal(restarted.serverScope, 'vip1'); assert.equal(h.room().vip.count(), 1);
  assert.equal(restarted.economy.score(uid), 1); assert.equal(restarted.coinSnapshot()[2].respawnAt, expiry);
  const next = await h.open('/play?server=vip1');
  await next.send({ type: 'auth', token: h.token(uid), name: 'Restarted', resumeToken });
  assert.equal(next.messages('welcome')[0].score, 1); assert.equal(h.room().vip.count(), 1);
  assert.equal(h.room().vip.entitlement(uid).active, true);
});

test('P7 bundled Worker concurrent same-UID acquires retain at most one current seat and permit reconnect', async t => {
  const h = runtimeFixture(t), uid = 'worker-duplicate-race'; await webhook(h, runtimeEvent(h, uid));
  const raced = await Promise.all(Array.from({ length: 5 }, () => h.connect({ server: 'vip1', uid })));
  assert.ok(h.room().vip.count() <= 1);
  const last = await h.connect({ server: 'vip1', uid }); assert.equal(last.messages('welcome').length, 1);
  assert.equal(h.room().vip.count(), 1);
  for (const old of raced) await old.close();
  assert.equal(h.room().vip.count(), 1); assert.equal(last.client.closed, false);
});

test('P7 bundled Worker central storage failure cannot grant admission or leave a local active session', async t => {
  const h = runtimeFixture(t), uid = 'worker-storage-failure'; await webhook(h, runtimeEvent(h, uid));
  const exec = h.room().sql.exec;
  h.room().sql.exec = (query, ...bindings) => {
    if (/SELECT .*voxel_vip_seats|INSERT INTO voxel_vip_seats/.test(query)) throw Error('synthetic VIP persistence outage');
    return exec(query, ...bindings);
  };
  const vip = await h.connect({ server: 'vip1', uid });
  assert.equal(vip.messages('welcome').length, 0); assert.equal(vip.client.closed, true);
  h.room().sql.exec = exec;
  assert.equal(h.room().vip.count(), 0);
  assert.equal(h.room('vip1').sessions.validate({ uid, sessionId: vip.attachment()?.sessionId, owner: 'room' }), false);
  const retry = await h.connect({ server: 'vip1', uid }); assert.equal(retry.messages('welcome').length, 1);
});

test('P7 future subscription period cannot grant early VIP admission', async t => {
  const [, { VipStore }] = await modules, ctx = fixture(t), store = new VipStore(ctx);
  const start = Date.now() + 1000, e = event('future-start', {
    periodStart: start, periodEnd: start + 30 * 24 * 60 * 60 * 1000
  });
  assert.equal((await apply(store, e)).ok, true);
  assert.equal(store.entitlement(e.uid).active, false);
  assert.equal(store.admit(admission(e.uid)).ok, false);
  assert.equal(store.entitlement(e.uid, start).active, true);
});

test('P7 bundled Worker delayed validated frame cannot mutate after authoritative revocation', async t => {
  const h = runtimeFixture(t), uid = 'held-validate', e = runtimeEvent(h, uid);
  await webhook(h, e); const vip = await h.connect({ server: 'vip1', uid });
  const coin = h.room('vip1').coinSnapshot()[3]; h.place(vip, { x: coin.x, y: 0, z: coin.z, r: 0 });
  let seen, resume;
  const seenPromise = new Promise(resolve => { seen = resolve; });
  const resumePromise = new Promise(resolve => { resume = resolve; });
  const getByName = h.env.ROOM.getByName;
  let hold = true;
  h.env.ROOM.getByName = name => {
    const stub = getByName(name);
    if (name !== 'free-v2-demo') return stub;
    return { async fetch(request) {
      const response = await stub.fetch(request);
      if (hold && new URL(request.url).pathname === '/_internal/vip/validate') {
        hold = false; seen(); await resumePromise;
      }
      return response;
    } };
  };
  const pending = vip.send({ type: 'collect', id: coin.id, requestId: 'held-revoked-coin' });
  await seenPromise;
  assert.equal((await webhook(h, { ...e, eventId: 'held-revoked', version: 2, status: 'revoked' })).status, 200);
  assert.equal(vip.client.closed, true);
  resume(); await pending;
  assert.equal(h.room('vip1').economy.score(uid), 0);
  assert.equal(h.room('vip1').coinSnapshot()[3].respawnAt, 0);
  assert.equal(h.room().vip.count(), 0);
  assert.equal(h.room('vip1').sessions.row(uid).lease_expires, 0);
});

test('P7 shortened subscription period evicts old cached generation and requires current reconnect', async t => {
  const h = runtimeFixture(t), uid = 'shortened-entitlement', e = runtimeEvent(h, uid);
  await webhook(h, e); const old = await h.connect({ server: 'vip1', uid });
  const shorter = { ...e, eventId: 'shorten-period', version: 2,
    periodStart: e.periodStart - 60000, periodEnd: e.periodEnd - 60000 };
  assert.equal((await webhook(h, shorter)).status, 200);
  assert.equal(old.client.closed, true); assert.equal(h.room().vip.count(), 0);
  assert.equal(h.room('vip1').count(), 0);
  const next = await h.connect({ server: 'vip1', uid });
  assert.equal(next.messages('welcome').length, 1);
  assert.equal(next.messages('welcome')[0].entitlements.vip1Expires, shorter.periodEnd);
  assert.equal(h.room().vip.count(), 1);
});

test('P7 failed revocation delivery retries its durable generation receipt without restoring entitlement', async t => {
  const h = runtimeFixture(t), uid = 'revoke-retry', e = runtimeEvent(h, uid);
  await webhook(h, e); const vip = await h.connect({ server: 'vip1', uid });
  const getByName = h.env.ROOM.getByName;
  let fail = true;
  h.env.ROOM.getByName = name => {
    const stub = getByName(name);
    if (name !== 'vip1-v2-demo') return stub;
    return { fetch(request) {
      if (fail && new URL(request.url).pathname === '/_internal/session-revoke')
        return Promise.resolve(Response.json({ ok: false }, { status: 503 }));
      return stub.fetch(request);
    } };
  };
  const revoked = { ...e, eventId: 'retry-revocation', version: 2, status: 'revoked' };
  assert.equal((await webhook(h, revoked)).status, 503);
  assert.equal(h.room().vip.entitlement(uid).active, false); assert.equal(h.room().vip.count(), 0);
  fail = false;
  const retry = await webhook(h, revoked); assert.equal(retry.status, 200); assert.equal((await retry.json()).replayed, true);
  assert.equal(vip.client.closed, true); assert.equal(h.room('vip1').count(), 0);
  const next = await h.connect({ server: 'vip1', uid }); assert.equal(next.messages('welcome').length, 0);
});

test('P7 idle expired 100-player cohort loses world visibility, broadcasts and seats before replacement', async t => {
  const h = runtimeFixture(t);
  const users = Array.from({ length: 100 }, (_, i) => `idle-expired-${i}`);
  await Promise.all(users.map(uid => webhook(h, runtimeEvent(h, uid))));
  const old = await Promise.all(users.map(uid => h.connect({ server: 'vip1', uid,
    token: h.token(uid, { exp: Math.floor(h.now() / 1000) + 60 }) })));
  assert.equal(h.room().vip.count(), 100); assert.equal(h.room('vip1').count(), 100);
  old.forEach(connection => connection.clear());
  await h.advance(60000);
  assert.equal(h.room().vip.count(), 0); assert.equal(h.room('vip1').count(), 0);
  assert.equal(h.room('vip1').economyPlayers().length, 0);
  h.room('vip1').broadcast({ type: 'leaderboard', top: [] });
  assert.ok(old.every(connection => connection.messages().length === 0));
  await webhook(h, runtimeEvent(h, 'idle-replacement'));
  const next = await h.connect({ server: 'vip1', uid: 'idle-replacement' });
  assert.equal(next.messages('welcome')[0].count, 1); assert.deepEqual(next.messages('welcome')[0].players, []);
  assert.equal(h.room().vip.count(), 1); assert.equal(h.room('vip1').count(), 1);
  assert.ok(old.every(connection => connection.client.closed && connection.messages().length === 0));
});

test('P7 repeated idle lease expiration cannot exhaust VIP transport soft cap', async t => {
  const h = runtimeFixture(t);
  for (let cycle = 0; cycle < 3; cycle++) {
    const users = Array.from({ length: 100 }, (_, i) => `expiry-cycle-${cycle}-${i}`);
    await Promise.all(users.map(uid => webhook(h, runtimeEvent(h, uid))));
    const connections = await Promise.all(users.map(uid => h.connect({ server: 'vip1', uid })));
    assert.ok(connections.every(connection => connection.messages('welcome').length === 1));
    assert.equal(h.room().vip.count(), 100); assert.equal(h.room('vip1').count(), 100);
    await h.advance(120001);
    assert.equal(h.room().vip.count(), 0); assert.equal(h.room('vip1').count(), 0);
  }
  await webhook(h, runtimeEvent(h, 'after-three-expired-cohorts'));
  const fresh = await h.connect({ server: 'vip1', uid: 'after-three-expired-cohorts' });
  assert.equal(fresh.messages('welcome').length, 1); assert.equal(h.room('vip1').sockets().length, 1);
});
