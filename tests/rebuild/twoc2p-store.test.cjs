'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { webcrypto, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
globalThis.crypto ||= webcrypto;
const modules = Promise.all(['twoc2p-store.mjs', 'vip-store.mjs', 'payment-events.mjs']
  .map(file => import(pathToFileURL(path.join(__dirname, '../../src/worker', file)))));
const BASE_NOW = Date.parse('2026-01-15T12:34:56.789Z');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture(t, now = BASE_NOW) {
  const [{ Twoc2pSandboxStore }, { VipStore }] = await modules;
  const db = new DatabaseSync(':memory:');
  const originalNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; db.close(); });
  let depth = 0;
  const ctx = { storage: {
    sql: { exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows.map(row => ({ ...row })) };
    } },
    transactionSync(callback) {
      if (depth) return callback();
      db.exec('BEGIN IMMEDIATE'); depth++;
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { depth--; }
    }
  } };
  ctx.storage.sql.exec(`CREATE TABLE voxel_entitlements (uid TEXT PRIMARY KEY,
    speed_expires INTEGER NOT NULL DEFAULT 0,coin_expires INTEGER NOT NULL DEFAULT 0,
    vip1_expires INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)`);
  const vip = new VipStore(ctx), store = new Twoc2pSandboxStore(ctx, vip);
  return { ctx, db, vip, store, now: () => now, advance: delta => { now += delta; },
    restart: () => new Twoc2pSandboxStore(ctx, new VipStore(ctx)) };
}

function create(store, uid = 'synthetic-alpha', changes = {}) {
  return store.createCheckout({ uid, merchantID: 'SYNTHETICMERCHANT',
    invoicePrefix: 'TEST', requestId: `request:${uid}`, ...changes });
}
function notice(checkout, changes = {}) {
  return { merchantID: 'SYNTHETICMERCHANT', invoiceNo: checkout.invoiceNo,
    amount: 50, currencyCode: 'THB', paymentID: `payment:${checkout.invoiceNo}`,
    referenceNo: `reference:${checkout.invoiceNo}`, respCode: '0000',
    transactionDateTime: '20260115123457', recurringUniqueID: '12345678901234567890',
    recurringSequenceNo: '1', ...changes };
}
function ready(store, checkout, uid = 'synthetic-alpha') {
  const identity = { invoiceNo: checkout.invoiceNo, uid };
  assert.equal(store.claimTokenAttempt(identity).ok, true);
  assert.equal(store.finishTokenAttempt({ ...identity, succeeded: true }).ok, true);
}
function apply(store, notification, changes = {}) {
  return store.applyNotification({ notification, fingerprint: fingerprint(notification), ...changes });
}

test('2C2P immutable pending invoice uses verified UID, exactly 50 THB and calendar month', async t => {
  const { store, now, vip } = await fixture(t);
  const checkout = create(store);
  assert.equal(checkout.ok, true); assert.match(checkout.invoiceNo, /^TEST[A-Z0-9]{16}$/);
  assert.equal(checkout.amount, 50); assert.equal(checkout.currencyCode, 'THB');
  assert.equal(checkout.invoicePrefix, 'TEST');
  assert.equal(checkout.createdAt, now()); assert.equal(checkout.periodStart, now());
  assert.equal(checkout.periodEnd, Date.parse('2026-02-15T12:34:56.789Z'));
  assert.equal(checkout.periodEnd - checkout.periodStart, 31 * 86400000);
  assert.equal(checkout.expiresAt - checkout.createdAt, 15 * 60000);
  assert.equal(Object.hasOwn(checkout, 'uid'), false);
  assert.equal(store.checkout(checkout.invoiceNo).uid, 'synthetic-alpha');
  assert.equal(vip.entitlement('synthetic-alpha').active, false);
});

test('2C2P checkout rejects caller-defined UID alias, amount, period and invalid identity schema', async t => {
  const { store } = await fixture(t);
  for (const changes of [{ amount: 1 }, { periodEnd: BASE_NOW + 999999 },
    { uid: '' }, { uid: 'bad\u0000uid' }, { merchantID: '../production' },
    { invoicePrefix: 'SIXTEENCHARACTERS' }, { invoicePrefix: '' }, { requestId: '' }])
    assert.equal(create(store, 'synthetic-alpha', changes).ok, false);
  assert.equal(store.createCheckout(null).ok, false);
  assert.equal(store.createCheckout([]).ok, false);
});

test('2C2P snapshots a server-owned dynamic VIP price per invoice', async t => {
  const { store, vip } = await fixture(t);
  const first = store.createCheckout({ uid:'synthetic-alpha', merchantID:'SYNTHETICMERCHANT',
    invoicePrefix:'PRICE', requestId:'request:dynamic-alpha' }, BASE_NOW, 75);
  assert.equal(first.ok,true);
  assert.equal(first.amount,75);
  ready(store,first);
  const paid = notice(first,{ amount:75 });
  const result=apply(store,paid);
  assert.equal(result.ok,true);
  assert.equal(result.entitlementGranted,true);
  assert.equal(vip.entitlement('synthetic-alpha').expiresAt,first.periodEnd);
  const replay=store.createCheckout({ uid:'synthetic-alpha', merchantID:'SYNTHETICMERCHANT',
    invoicePrefix:'PRICE', requestId:'request:dynamic-alpha' }, BASE_NOW, 99);
  assert.equal(replay.ok,true);
  assert.equal(replay.replayed,true);
  assert.equal(replay.amount,75,'existing invoice keeps its original quoted price');
});

test('2C2P checkout request idempotency and one pending invoice per UID persist through restart', async t => {
  const { store, restart, db } = await fixture(t);
  const first = create(store);
  const replay = create(restart());
  assert.equal(replay.ok, true); assert.equal(replay.replayed, true);
  assert.equal(replay.invoiceNo, first.invoiceNo);
  assert.equal(create(store, 'synthetic-alpha', { requestId: 'new-request' }).ok, false);
  assert.equal(create(store, 'synthetic-alpha', { merchantID: 'OTHER' }).ok, false);
  assert.equal(create(store, 'synthetic-beta', { requestId: 'request:synthetic-alpha' }).ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_2c2p_sandbox_checkouts').get().n, 2);
});

test('2C2P token request is claimed once, UID-bound, no retry after ambiguous failure', async t => {
  const { store, restart } = await fixture(t);
  const first = create(store), identity = { invoiceNo: first.invoiceNo, uid: 'synthetic-alpha' };
  assert.equal(store.claimTokenAttempt({ ...identity, uid: 'attacker' }).status, 404);
  assert.equal(store.claimTokenAttempt(identity).ok, true);
  assert.equal(restart().claimTokenAttempt(identity).ok, false);
  assert.equal(store.finishTokenAttempt({ ...identity, succeeded: false }).ok, true);
  assert.equal(store.claimTokenAttempt(identity).ok, false);
  assert.equal(store.finishTokenAttempt({ ...identity, succeeded: true }).ok, false);
  assert.equal(store.finishTokenAttempt({ ...identity, succeeded: false }).replayed, true);
  const persisted = store.checkout(first.invoiceNo);
  assert.equal(persisted.tokenState, 'failed'); assert.equal(persisted.status, 'pending');
  assert.equal(JSON.stringify(persisted).includes('paymentToken'), false);
});

test('2C2P token-ready outcome never grants entitlement', async t => {
  const { store, vip } = await fixture(t);
  const first = create(store), identity = { invoiceNo: first.invoiceNo, uid: 'synthetic-alpha' };
  assert.equal(store.finishTokenAttempt({ ...identity, succeeded: true }).ok, false);
  store.claimTokenAttempt(identity);
  assert.equal(store.finishTokenAttempt({ ...identity, succeeded: true }).ok, true);
  assert.equal(vip.entitlement(identity.uid).active, false);
});

test('2C2P verified success grants ledger UID atomically once and persists on restart', async t => {
  const { store, vip, restart, db } = await fixture(t);
  db.prepare('INSERT INTO voxel_entitlements(uid,speed_expires,coin_expires,updated_at) VALUES (?,?,?,?)')
    .run('synthetic-alpha', 12345, 23456, BASE_NOW);
  const first = create(store), notification = notice(first);
  ready(store, first);
  const result = apply(store, notification);
  assert.equal(result.ok, true); assert.equal(result.entitlementGranted, true);
  assert.equal(result.expiresAt, first.periodEnd);
  assert.equal(vip.entitlement('synthetic-alpha').expiresAt, first.periodEnd);
  assert.equal(vip.entitlement('attacker').active, false);
  const replay = apply(restart(), notification);
  assert.equal(replay.ok, true); assert.equal(replay.replayed, true);
  assert.equal(replay.entitlementGranted, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_vip_events').get().n, 1);
  const ent = db.prepare('SELECT * FROM voxel_entitlements WHERE uid=?').get('synthetic-alpha');
  assert.equal(ent.speed_expires, 12345); assert.equal(ent.coin_expires, 23456);
});

test('2C2P signed notification cannot choose UID, price, currency or grant flags', async t => {
  const { store, vip } = await fixture(t);
  const first = create(store), original = notice(first);
  ready(store, first);
  for (const changes of [{ uid: 'attacker' }, { paid: true }, { amount: 1 },
    { amount: '50.00' }, { currencyCode: 'USD' }, { merchantID: 'OTHER' },
    { invoiceNo: 'UNKNOWN' }, { paymentID: '' }, { referenceNo: '' },
    { transactionDateTime: '20260230120000' }, { transactionDateTime: '20260115250000' },
    { recurringSequenceNo: -1 }, { recurringUniqueID: '' }]) {
    assert.equal(apply(store, { ...original, ...changes }).ok, false);
    assert.equal(vip.entitlement('synthetic-alpha').active, false);
  }
  assert.equal(apply(store, original, { fingerprint: 'not-a-fingerprint' }).ok, false);
});

test('2C2P duplicate concurrent notification deliveries grant exactly once', async t => {
  const { store, db } = await fixture(t), first = create(store), notification = notice(first);
  ready(store, first);
  const results = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => apply(store, notification))));
  assert.equal(results.filter(result => result.entitlementGranted).length, 1);
  assert.equal(results.filter(result => result.replayed).length, 19);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_vip_events').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_2c2p_sandbox_notifications').get().n, 1);
});

test('2C2P same semantic transaction with a different receipt fingerprint never extends period', async t => {
  const { store, vip, advance, db } = await fixture(t), first = create(store), notification = notice(first);
  ready(store, first);
  assert.equal(apply(store, notification).ok, true);
  advance(1000);
  const result = apply(store, notification, { fingerprint: 'a'.repeat(64) });
  assert.equal(result.ok, true); assert.equal(result.entitlementGranted, false);
  assert.equal(result.replayed, true); assert.equal(vip.entitlement('synthetic-alpha').expiresAt, first.periodEnd);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_vip_events').get().n, 1);
});

test('2C2P notification fingerprint collision cannot substitute merchant or metadata', async t => {
  const { store } = await fixture(t), first = create(store), notification = notice(first);
  ready(store, first);
  assert.equal(apply(store, notification).ok, true);
  for (const changes of [{ merchantID: 'OTHER' }, { recurringUniqueID: 'changed-plan' },
    { transactionDateTime: '20260115123458' }])
    assert.equal(apply(store, { ...notification, ...changes }, { fingerprint: fingerprint(notification) }).ok, false);
});

test('2C2P global payment and reference IDs cannot belong to another invoice or UID', async t => {
  const { store, vip } = await fixture(t), alpha = create(store), beta = create(store, 'synthetic-beta');
  ready(store, alpha); ready(store, beta, 'synthetic-beta');
  const notification = notice(alpha);
  assert.equal(apply(store, notification).ok, true);
  for (const changes of [{ paymentID: notification.paymentID }, { referenceNo: notification.referenceNo }]) {
    assert.equal(apply(store, notice(beta, changes)).ok, false);
    assert.equal(vip.entitlement('synthetic-beta').active, false);
  }
  assert.equal(apply(store, notice(alpha, { paymentID: 'different', referenceNo: 'different' })).ok, false);
});

test('2C2P transaction ownership is also fenced for non-success callbacks', async t => {
  const { store, vip } = await fixture(t), alpha = create(store), beta = create(store, 'synthetic-beta');
  ready(store, alpha); ready(store, beta, 'synthetic-beta');
  const pending = notice(alpha, { respCode: '0001' });
  assert.equal(apply(store, pending).status, 'pending');
  assert.equal(apply(store, notice(beta, { paymentID: pending.paymentID })).ok, false);
  assert.equal(vip.entitlement('synthetic-beta').active, false);
  assert.equal(apply(store, notice(alpha)).entitlementGranted, true);
});

for (const [respCode, expected] of [['0001', 'pending'], ['2001', 'pending'], ['0003', 'cancelled'],
  ['4080', 'cancelled'], ['2003', 'failed'], ['5009', 'expired'], ['5017', 'expired'], ['9020', 'expired'],
  ['4000', 'unconfirmed'], ['2000', 'unconfirmed'], ['4120', 'unconfirmed'], ['4130', 'unconfirmed'], ['9999', 'unconfirmed']]) {
  test(`2C2P response ${respCode} is ${expected}, never proof of payment`, async t => {
    const { store, vip } = await fixture(t), first = create(store), notification = notice(first, { respCode });
    ready(store, first);
    const result = apply(store, notification);
    assert.equal(result.ok, true); assert.equal(result.status, expected);
    assert.equal(result.entitlementGranted, false); assert.equal(vip.entitlement('synthetic-alpha').active, false);
    assert.equal(apply(store, notification).replayed, true);
    if (['failed', 'cancelled', 'expired'].includes(expected))
      assert.equal(apply(store, notice(first)).ok, false, 'Terminal checkout cannot be revived');
  });
}

test('2C2P late failure/cancel/refund/chargeback is not an authenticated revocation contract', async t => {
  const { store, vip } = await fixture(t), first = create(store);
  ready(store, first);
  assert.equal(apply(store, notice(first)).ok, true);
  for (const respCode of ['2003', '0003', '5009', '4120', '4130']) {
    const result = apply(store, notice(first, { respCode }));
    assert.equal(result.ok, true); assert.equal(result.status, 'paid');
    assert.equal(result.entitlementGranted, false); assert.equal(result.ignored, true);
    assert.equal(vip.entitlement('synthetic-alpha').expiresAt, first.periodEnd);
  }
});

test('2C2P expired invoice rejects success; original request cannot refresh expiry', async t => {
  const { store, vip, advance } = await fixture(t), first = create(store);
  ready(store, first);
  advance(15 * 60000);
  assert.equal(store.checkout(first.invoiceNo).status, 'expired');
  assert.equal(apply(store, notice(first)).ok, false);
  assert.equal(vip.entitlement('synthetic-alpha').active, false);
  const replay = create(store);
  assert.equal(replay.invoiceNo, first.invoiceNo); assert.equal(replay.expiresAt, first.expiresAt);
  assert.equal(store.claimTokenAttempt({ invoiceNo: first.invoiceNo, uid: 'synthetic-alpha' }).ok, false);
  assert.equal(create(store, 'synthetic-alpha', { requestId: 'new-after-expiry' }).ok, true);
});

test('2C2P invoice lifetime cannot cross the UTC calendar anchor date', async t => {
  const { store } = await fixture(t, Date.parse('2026-01-28T23:58:00.000Z'));
  const first = create(store);
  assert.equal(first.expiresAt, Date.parse('2026-01-29T00:00:00.000Z'));
  assert.equal(first.expiresAt - first.createdAt, 2 * 60000);
});

test('2C2P UTC day29-31 activation is blocked without invented provider rollover', async t => {
  const { store } = await fixture(t, Date.parse('2026-01-31T12:00:00.000Z'));
  assert.equal(create(store).status, 503);
});

test('2C2P calendar period respects February, leap year and year rollover', async () => {
  const [, { sandboxCalendarPeriodEnd }] = await modules;
  for (const [start, end, days] of [
    ['2026-02-15T12:34:56.789Z', '2026-03-15T12:34:56.789Z', 28],
    ['2028-02-15T12:34:56.789Z', '2028-03-15T12:34:56.789Z', 29],
    ['2026-04-28T23:59:59.000Z', '2026-05-28T23:59:59.000Z', 30],
    ['2026-12-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z', 31]]) {
    const periodEnd = sandboxCalendarPeriodEnd(Date.parse(start));
    assert.equal(periodEnd, Date.parse(end)); assert.equal(periodEnd - Date.parse(start), days * 86400000);
  }
  for (const start of [Date.parse('2026-01-29T00:00:00Z'), -1, NaN, '2026-01-15'])
    assert.throws(() => sandboxCalendarPeriodEnd(start));
});

test('2C2P entitlement expiry remains server-owned and subsequent checkout/renewal is blocked', async t => {
  const { store, vip, advance } = await fixture(t), first = create(store);
  ready(store, first);
  assert.equal(apply(store, notice(first, { recurringUniqueID: '1234567890', recurringSequenceNo: '1' })).ok, true);
  assert.equal(create(store, 'synthetic-alpha', { requestId: 'second-subscription' }).ok, false);
  assert.equal(apply(store, notice({ invoiceNo: 'UNKNOWNRENEWAL' }, { recurringUniqueID: '1234567890', recurringSequenceNo: '2' })).ok, false);
  advance(first.periodEnd - BASE_NOW);
  assert.equal(vip.entitlement('synthetic-alpha').active, false);
  assert.equal(vip.admit({ uid: 'synthetic-alpha', sessionId: 'expired-seat', exp: Math.floor(Date.now() / 1000) + 3600 }).ok, false);
  assert.equal(create(store, 'synthetic-alpha', { requestId: 'expired-replacement' }).ok, false);
});

test('2C2P rollback after entitlement write preserves invoice and exact retry', async t => {
  const { store, vip, ctx, db } = await fixture(t), first = create(store), notification = notice(first);
  ready(store, first);
  const exec = ctx.storage.sql.exec;
  ctx.storage.sql.exec = (query, ...bindings) => {
    if (/INSERT INTO voxel_2c2p_sandbox_notifications/.test(query)) throw Error('synthetic receipt storage outage');
    return exec(query, ...bindings);
  };
  assert.throws(() => apply(store, notification), /synthetic receipt storage outage/);
  assert.equal(vip.entitlement('synthetic-alpha').active, false);
  assert.equal(store.checkout(first.invoiceNo).status, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_vip_events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_2c2p_sandbox_transactions').get().n, 0);
  ctx.storage.sql.exec = exec;
  assert.equal(apply(store, notification).entitlementGranted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_vip_events').get().n, 1);
});

test('2C2P calendar boundary cannot relax the original provider-neutral 30-day schema', async t => {
  const { vip } = await fixture(t);
  const event = { eventId: `2c2p:sandbox:${'a'.repeat(64)}`, subscriptionId: '2c2p:sandbox:TESTINVOICE',
    uid: 'synthetic-alpha', version: 1, status: 'active', product: 'vip1', amount: 50, currency: 'THB',
    periodStart: BASE_NOW, periodEnd: Date.parse('2026-02-15T12:34:56.789Z') };
  assert.equal(vip.applyEvent({ event, fingerprint: 'a'.repeat(64) }).ok, false);
  for (const changes of [{ periodEnd: BASE_NOW + 30 * 86400000 }, { status: 'revoked' },
    { amount: 1 }, { subscriptionId: 'production-subscription' }, { version: 2 }])
    assert.equal(vip.applyVerifiedSandboxCalendarEvent({ event: { ...event, ...changes }, fingerprint: 'a'.repeat(64) }).ok, false);
  assert.equal(vip.applyVerifiedSandboxCalendarEvent({ event, fingerprint: 'a'.repeat(64) }).ok, true);
});

test('2C2P signed success cannot grant for uninitiated or ambiguously failed token attempts', async t => {
  const { store, vip, db } = await fixture(t), first = create(store), notification = notice(first);
  assert.equal(apply(store, notification).ok, false);
  assert.equal(vip.entitlement('synthetic-alpha').active, false);
  const identity = { invoiceNo: first.invoiceNo, uid: 'synthetic-alpha' };
  assert.equal(store.claimTokenAttempt(identity).ok, true);
  assert.equal(store.finishTokenAttempt({ ...identity, succeeded: false }).ok, true);
  assert.equal(apply(store, notification).ok, false);
  assert.equal(vip.entitlement('synthetic-alpha').active, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_vip_events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_2c2p_sandbox_notifications').get().n, 0);
});

test('2C2P verified backend success can race the payment-token response without duplicate grant', async t => {
  const { store, vip } = await fixture(t), first = create(store), notification = notice(first);
  const identity = { invoiceNo: first.invoiceNo, uid: 'synthetic-alpha' };
  assert.equal(store.claimTokenAttempt(identity).ok, true);
  assert.equal(apply(store, notification).entitlementGranted, true);
  assert.equal(store.finishTokenAttempt({ ...identity, succeeded: true }).ok, true);
  assert.equal(vip.entitlement('synthetic-alpha').expiresAt, first.periodEnd);
  assert.equal(apply(store, notification).entitlementGranted, false);
});

test('2C2P expired token attempt cannot return a new hosted checkout', async t => {
  const { store, advance } = await fixture(t), first = create(store);
  const identity = { invoiceNo: first.invoiceNo, uid: 'synthetic-alpha' };
  assert.equal(store.claimTokenAttempt(identity).ok, true);
  advance(15 * 60000);
  assert.equal(store.finishTokenAttempt({ ...identity, succeeded: true }).ok, false);
  assert.equal(store.checkout(first.invoiceNo).status, 'expired');
});

test('2C2P successful notification requires native recurring identity strings', async t => {
  const { store, vip } = await fixture(t), first = create(store), notification = notice(first);
  ready(store, first);
  for (const changes of [
    { recurringUniqueID: undefined }, { recurringSequenceNo: undefined },
    { recurringUniqueID: 'plan-name' }, { recurringUniqueID: '1'.repeat(21) },
    { recurringSequenceNo: 1 }, { recurringSequenceNo: '1'.repeat(11) },
    { transactionDateTime: '19000115123457' }
  ]) {
    assert.equal(apply(store, { ...notification, ...changes }).ok, false);
    assert.equal(vip.entitlement('synthetic-alpha').active, false);
  }
  const missing = { ...notification }; delete missing.recurringUniqueID;
  assert.equal(apply(store, missing).ok, false);
  assert.equal(apply(store, notification).entitlementGranted, true);
});

test('2C2P re-signed paid transaction cannot substitute accepted provider metadata', async t => {
  const { store, vip, db } = await fixture(t), first = create(store);
  ready(store, first);
  const notification = notice(first, { tranRef: 'provider-transaction-reference' });
  assert.equal(apply(store, notification).entitlementGranted, true);
  for (const changes of [
    { recurringUniqueID: '999999' }, { recurringSequenceNo: '2' },
    { tranRef: 'other-reference' }, { transactionDateTime: '20260115123458' }
  ]) assert.equal(apply(store, { ...notification, ...changes }).ok, false);
  assert.equal(vip.entitlement('synthetic-alpha').expiresAt, first.periodEnd);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM voxel_vip_events').get().n, 1);
});

test('2C2P native maximum transaction fields and zero-prefixed recurring identities persist exactly', async t => {
  const { store, restart, db } = await fixture(t), first = create(store);
  ready(store, first);
  const notification = notice(first, { paymentID: 'p'.repeat(255), referenceNo: 'r'.repeat(50),
    tranRef: 't'.repeat(255), recurringUniqueID: '00012345678901234567', recurringSequenceNo: '0000000001' });
  assert.equal(apply(store, notification).entitlementGranted, true);
  const row = db.prepare('SELECT * FROM voxel_2c2p_sandbox_checkouts WHERE invoice_no=?').get(first.invoiceNo);
  assert.equal(row.recurring_sequence_no, '0000000001');
  assert.equal(row.recurring_unique_id, '00012345678901234567');
  assert.equal(restart().checkout(first.invoiceNo).invoicePrefix, 'TEST');
  assert.equal(apply(store, notification).replayed, true);
});

test('2C2P semantic notification ordering does not alter stored receipt identity', async t => {
  const { store } = await fixture(t), first = create(store), notification = notice(first);
  ready(store, first);
  assert.equal(apply(store, notification).entitlementGranted, true);
  const reordered = Object.fromEntries(Object.entries(notification).reverse());
  const result = apply(store, reordered, { fingerprint: fingerprint(notification) });
  assert.equal(result.ok, true); assert.equal(result.replayed, true);
  assert.equal(result.entitlementGranted, false);
});

test('VIP normalized-event mutation boundary is inaccessible without strict provider validation', async t => {
  const { vip } = await fixture(t);
  assert.equal(typeof vip.applyNormalizedEvent, 'undefined');
  const forged = { eventId: 'fake', subscriptionId: 'fake', uid: 'synthetic-alpha',
    version: 1, status: 'active', product: 'vip1', amount: 1, currency: 'THB',
    periodStart: BASE_NOW, periodEnd: BASE_NOW + 30 * 86400000 };
  assert.equal(vip.applyEvent({ event: forged, fingerprint: 'a'.repeat(64) }).ok, false);
  assert.equal(vip.applyVerifiedSandboxCalendarEvent({ event: forged, fingerprint: 'a'.repeat(64) }).ok, false);
  assert.equal(vip.entitlement('synthetic-alpha').active, false);
});
