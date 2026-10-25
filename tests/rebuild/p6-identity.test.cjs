'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

function harness(t) {
  const h = createHarness();
  t.after(() => h.close());
  return h;
}
const position = p => Object.fromEntries(['x', 'y', 'z', 'r'].map(key => [key, Number(p[key])]));
const row = (h, uid) => h.room().sessions.row(uid);
const identity = p => ({ uid: p.uid, sessionId: p.sessionId, owner: p.zoneId ? `zone:${p.zoneId}` : 'room' });
async function auth(h, uid, { zone, fields = {}, token } = {}) {
  const connection = await h.open(zone ? `/play?zone=${zone}` : '/play');
  await connection.send({ type: 'auth', token: token ?? h.token(uid), protocol: zone ? 6 : 4, ...fields });
  return connection;
}
function checkpoint(h, connection, target, revision, extra = {}) {
  return h.room().sessions.checkpoint({ ...identity(connection.attachment()), position: target, revision, ...extra });
}

test('P6 fresh verified login restores durable identity/position after resume expiry and process restart', async t => {
  const h = harness(t), uid = 'synthetic-p6-long-reconnect';
  const source = await auth(h, uid);
  const first = source.messages('welcome').at(-1);
  await h.advance(200);
  await h.moveTo(source, { x: source.attachment().x + 1, z: source.attachment().z });
  const saved = position(source.attachment());
  const savedRevision = row(h, uid).save_revision;
  assert.ok(savedRevision > 0);
  await source.close();
  await h.advance(120_001);
  h.restartRoom();
  await h.room().ready;
  const restored = await auth(h, uid);
  const welcome = restored.messages('welcome').at(-1);
  assert.ok(welcome);
  assert.equal(welcome.id, first.id);
  assert.notEqual(welcome.session.sessionId, first.session.sessionId);
  assert.notEqual(welcome.session.resumeToken, first.session.resumeToken);
  assert.deepEqual(position(restored.attachment()), saved);
  assert.equal(row(h, uid).save_revision, savedRevision);
  assert.equal(row(h, uid).player_id, first.id);
});

test('P6 persistent zone reconnect restores server state without a resume ticket', async t => {
  const h = harness(t), uid = 'synthetic-p6-zone-reconnect';
  const source = await auth(h, uid, { zone: '4,4' });
  await h.advance(200);
  await h.moveTo(source, { x: source.attachment().x + 1, z: source.attachment().z });
  const saved = position(source.attachment()), id = source.attachment().id;
  await source.close();
  await h.advance(120_001);
  h.restartRoom();
  await h.room().ready;
  const restored = await auth(h, uid, { zone: '4,4' });
  assert.equal(restored.client.closed, false);
  assert.equal(restored.attachment().id, id);
  assert.deepEqual(position(restored.attachment()), saved);
  assert.equal(row(h, uid).owner, 'zone:4,4');
});

test('P6 saved-zone redirect is nonmutating and only follows a verified UID', async t => {
  const h = harness(t), uid = 'synthetic-p6-saved-zone';
  const source = await auth(h, uid, { zone: '4,4' });
  await source.close();
  const before = row(h, uid);
  const wrongZone = await auth(h, uid, { zone: '5,4' });
  assert.equal(wrongZone.client.closed, true);
  assert.equal(wrongZone.messages('welcome').length, 0);
  assert.equal(wrongZone.messages('auth_error').at(-1)?.resumeZone, '4,4');
  assert.deepEqual(row(h, uid), before);
  const invalid = await auth(h, uid, { zone: '5,4', token: 'invalid-synthetic-token' });
  assert.equal(invalid.messages('auth_error').at(-1)?.resumeZone, undefined);
  assert.deepEqual(row(h, uid), before);
  const restored = await auth(h, uid, { zone: '4,4' });
  assert.equal(restored.client.closed, false);
  assert.equal(restored.attachment().id, before.player_id);
});

test('P6 live cross-zone replacement preserves P5 admission policy and stable identity', async t => {
  const h = harness(t), uid = 'synthetic-p6-live-replacement';
  const old = await auth(h, uid, { zone: '4,4' });
  const oldPlayer = old.attachment();
  const winner = await auth(h, uid, { zone: '5,4' });
  assert.equal(winner.client.closed, false);
  assert.equal(old.client.closed, true);
  assert.equal(winner.attachment().id, oldPlayer.id);
  assert.equal(row(h, uid).owner, 'zone:5,4');
  assert.ok(winner.attachment().x >= 0 && winner.attachment().x < 150);
  const before = row(h, uid);
  assert.equal(h.room().sessions.checkpoint({ ...identity(oldPlayer), position: position(oldPlayer), revision: before.save_revision + 1 }).ok, false);
  await old.close();
  assert.deepEqual(row(h, uid), before);
});

test('P6 server checkpoint duplicate delivery is idempotent and conflicting replay is rejected', async t => {
  const h = harness(t), uid = 'synthetic-p6-idempotent-save';
  const connection = await auth(h, uid);
  const target = { ...position(connection.attachment()), x: 21 };
  const revision = row(h, uid).save_revision + 1;
  const first = checkpoint(h, connection, target, revision);
  assert.equal(first.ok, true);
  const saved = row(h, uid);
  await h.advance(1000);
  const replay = checkpoint(h, connection, target, revision);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.checkpointRevision, revision);
  assert.deepEqual(row(h, uid), saved, 'retry cannot extend lease or alter saved state');
  const conflict = checkpoint(h, connection, { ...target, x: 22 }, revision);
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /Conflicting/);
  assert.deepEqual(row(h, uid), saved);
});

test('P6 stale and out-of-order server save revisions cannot overwrite the current checkpoint', async t => {
  const h = harness(t), uid = 'synthetic-p6-out-of-order-save';
  const connection = await auth(h, uid);
  const initial = row(h, uid).save_revision;
  assert.equal(checkpoint(h, connection, { ...position(connection.attachment()), x: 35 }, initial + 3).ok, true);
  const saved = row(h, uid);
  for (const revision of [initial, initial + 1, initial + 2]) {
    const rejected = checkpoint(h, connection, { ...position(connection.attachment()), x: 12 }, revision);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Stale/);
    assert.deepEqual(row(h, uid), saved);
  }
  assert.equal(checkpoint(h, connection, { ...position(connection.attachment()), x: 36 }, initial + 4).ok, true);
  assert.equal(row(h, uid).x, 36);
});

test('P6 save rejects malformed player state, invalid revisions and forbidden authoritative fields', async t => {
  const h = harness(t), uid = 'synthetic-p6-malformed-save';
  const connection = await auth(h, uid), player = connection.attachment();
  const valid = position(player), revision = row(h, uid).save_revision + 1;
  const before = row(h, uid);
  const invalid = [null, [], {}, { x: 0, y: 0, z: 0 }, { ...valid, x: '1' },
    { ...valid, x: NaN }, { ...valid, z: Infinity }, { ...valid, x: 749 },
    { ...valid, z: -749 }, { ...valid, y: -1 }, { ...valid, y: 9 },
    { ...valid, r: 10001 }, { ...valid, balance: 999 }, { ...valid, score: 999 }];
  for (const target of invalid) {
    assert.equal(checkpoint(h, connection, target, revision).ok, false);
    assert.deepEqual(row(h, uid), before);
  }
  for (const badRevision of [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(checkpoint(h, connection, valid, badRevision).ok, false);
    assert.deepEqual(row(h, uid), before);
  }
  for (const field of ['score', 'balance', 'vip', 'inventory', 'reward', 'nickname', 'playerId', 'resumeToken']) {
    assert.equal(checkpoint(h, connection, valid, revision, { [field]: 999 }).ok, false);
    assert.deepEqual(row(h, uid), before);
  }
  assert.equal(h.room().economy.score(uid), 0);
  assert.equal(h.room().entitlementSnapshot(uid).vip1Expires, 0);
});

test('P6 checkpoint validates verified UID, generation and owner together', async t => {
  const h = harness(t), uid = 'synthetic-p6-save-ownership';
  const connection = await auth(h, uid), player = connection.attachment();
  const base = { ...identity(player), position: position(player), revision: row(h, uid).save_revision + 1 };
  const before = row(h, uid);
  for (const forged of [{ uid: 'synthetic-other-uid' }, { sessionId: 'forged-generation' }, { owner: 'zone:4,4' }]) {
    assert.equal(h.room().sessions.checkpoint({ ...base, ...forged }).ok, false);
    assert.deepEqual(row(h, uid), before);
  }
  const replacement = await auth(h, uid);
  const current = row(h, uid);
  assert.equal(connection.client.closed, true);
  assert.equal(h.room().sessions.checkpoint(base).ok, false);
  assert.deepEqual(row(h, uid), current);
  assert.equal(replacement.attachment().id, player.id);
});

test('P6 expired auth and lease cannot save, even with a higher revision', async t => {
  const h = harness(t), uid = 'synthetic-p6-save-expired';
  const connection = await auth(h, uid, { token: h.token(uid, { exp: Math.floor(h.now() / 1000) + 1 }) });
  const target = { ...position(connection.attachment()), x: 19 };
  await h.advance(1000);
  const before = row(h, uid);
  assert.equal(checkpoint(h, connection, target, before.save_revision + 1).ok, false);
  assert.deepEqual(row(h, uid), before);
  const leased = await auth(h, 'synthetic-p6-save-lease');
  await leased.close();
  const released = row(h, 'synthetic-p6-save-lease');
  assert.equal(checkpoint(h, leased, target, released.save_revision + 1).ok, false);
  assert.deepEqual(row(h, 'synthetic-p6-save-lease'), released);
});

test('P6 storage failure rolls back save and exact same revision remains retryable', async t => {
  const h = harness(t), uid = 'synthetic-p6-save-retry';
  const connection = await auth(h, uid), store = h.room().sessions;
  const before = row(h, uid), target = { ...position(connection.attachment()), x: 44 };
  const original = store.sql.exec.bind(store.sql);
  store.sql.exec = (query, ...bindings) => {
    if (query.startsWith('INSERT INTO voxel_sessions')) throw Error('Synthetic durable save unavailable');
    return original(query, ...bindings);
  };
  assert.throws(() => checkpoint(h, connection, target, before.save_revision + 1), /Synthetic durable/);
  store.sql.exec = original;
  assert.deepEqual(row(h, uid), before);
  assert.equal(checkpoint(h, connection, target, before.save_revision + 1).ok, true);
  assert.equal(row(h, uid).x, 44);
  assert.equal(row(h, uid).save_revision, before.save_revision + 1);
});

test('P6 lease/token refresh preserves position revision and rejects stale identity', async t => {
  const h = harness(t), uid = 'synthetic-p6-refresh-save';
  const connection = await auth(h, uid), first = row(h, uid);
  await h.advance(1000);
  await connection.send({ type: 'auth', protocol: 4, token: h.token(uid) });
  const refreshed = row(h, uid);
  assert.equal(connection.client.closed, false);
  assert.equal(refreshed.save_revision, first.save_revision);
  assert.deepEqual(position(refreshed), position(first));
  assert.ok(refreshed.exp > first.exp);
  assert.ok(refreshed.resume_expires > first.resume_expires);
  const prior = identity(connection.attachment());
  await auth(h, uid);
  const current = row(h, uid);
  assert.equal(h.room().sessions.checkpoint({ ...prior, exp: current.exp + 1 }).ok, false);
  assert.deepEqual(row(h, uid), current);
});

test('P6 runtime movement checkpoints carry server revisions and survive hibernation attachment', async t => {
  const h = harness(t), uid = 'synthetic-p6-runtime-revisions';
  const connection = await auth(h, uid, { zone: '4,4' });
  const requests = [], original = connection.instance.sessionCall.bind(connection.instance);
  connection.instance.sessionCall = async (action, payload) => {
    if (action === 'checkpoint' && payload.position !== undefined) requests.push(structuredClone(payload));
    return original(action, payload);
  };
  for (let sequence = 0; sequence < 3; sequence++) {
    await h.advance(200);
    await connection.send({ type: 'move', seq: sequence, input: { x: 0, z: 0, jump: false } });
  }
  assert.equal(requests.length, 3);
  assert.ok(requests.every(request => Number.isSafeInteger(request.revision)));
  assert.ok(requests.every((request, index) => index === 0 || request.revision > requests[index - 1].revision));
  assert.equal(connection.attachment().checkpointRevision, row(h, uid).save_revision);
  const attachment = connection.attachment();
  connection.server.serializeAttachment(attachment);
  await h.advance(200);
  await connection.send({ type: 'move', seq: 3, input: { x: 0, z: 0, jump: false } });
  assert.equal(connection.attachment().checkpointRevision, row(h, uid).save_revision);
  assert.ok(row(h, uid).save_revision > attachment.checkpointRevision);
});

test('P6 browser protocol cannot supply save state/revision or overwrite economy fields', async t => {
  const h = harness(t);
  const attempts = [
    { type: 'save', position: { x: 12, y: 0, z: 10, r: 0 }, score: 999 },
    { type: 'move', seq: 0, input: { x: 0, z: 0, jump: false }, revision: 999 },
    { type: 'auth', protocol: 4, playerId: 'forged-player' },
    { type: 'auth', protocol: 4, displayName: 'forged-name' },
    { type: 'collect', id: 0, inventory: ['forged-item'] },
    { type: 'collect', id: 0, balance: 999 },
    { type: 'spin_box', paymentResult: { paid: true } }
  ];
  for (const [index, packet] of attempts.entries()) {
    const uid = `synthetic-p6-public-save-${index}`, connection = await auth(h, uid);
    const before = row(h, uid);
    await connection.send({ ...packet, ...(packet.type === 'auth' ? { token: h.token(uid) } : {}) });
    assert.deepEqual(row(h, uid), before);
    assert.equal(h.room().economy.score(uid), 0);
    assert.equal(h.room().entitlementSnapshot(uid).vip1Expires, 0);
  }
  const response = await h.request('/_internal/session/checkpoint', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: 'synthetic-p6-public-save-0', position: { x: 0, y: 0, z: 0, r: 0 }, revision: 999 })
  });
  assert.equal(response.status, 404);
});

test('P6 additive SQLite migration preserves a P5 row and fresh login keeps its player identity', async t => {
  const h = harness(t), room = h.room();
  await room.ready;
  room.sql.exec('DROP TABLE voxel_sessions');
  room.sql.exec(`CREATE TABLE voxel_sessions (
    uid TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner TEXT NOT NULL, player_id TEXT NOT NULL,
    resume_token TEXT NOT NULL, resume_expires INTEGER NOT NULL, lease_expires INTEGER NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL, r REAL NOT NULL, exp INTEGER NOT NULL DEFAULT 0)`);
  room.sql.exec('INSERT INTO voxel_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    'synthetic-p6-migrated', 'p5-generation', 'room', 'p5-stable-player', 'p5-resume-ticket', 1, 0, 29, 0, -21, .25, 0);
  h.restartRoom();
  await h.room().ready;
  const migrated = row(h, 'synthetic-p6-migrated');
  assert.equal(migrated.player_id, 'p5-stable-player');
  assert.equal(migrated.save_revision, 0);
  assert.deepEqual(position(migrated), { x: 29, y: 0, z: -21, r: .25 });
  const connection = await auth(h, 'synthetic-p6-migrated');
  assert.equal(connection.client.closed, false);
  assert.equal(connection.attachment().id, 'p5-stable-player');
  assert.deepEqual(position(connection.attachment()), position(migrated));
  assert.equal(typeof row(h, 'synthetic-p6-migrated').save_fingerprint, 'string');
});

test('P6 corrupt persisted state is rejected without silent spawn fallback or owner mutation', async t => {
  const h = harness(t), uid = 'synthetic-p6-corrupt-state';
  const connection = await auth(h, uid);
  await connection.close();
  h.room().sql.exec('UPDATE voxel_sessions SET x=9999 WHERE uid=?', uid);
  const corrupt = row(h, uid);
  const rejected = await auth(h, uid);
  assert.equal(rejected.client.closed, true);
  assert.equal(rejected.messages('welcome').length, 0);
  assert.deepEqual(row(h, uid), corrupt);
});
