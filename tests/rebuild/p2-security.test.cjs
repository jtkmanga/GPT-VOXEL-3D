'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, CERTS_URL, SLIP_URL } = require('./harness.cjs');

// The harness bundles the active Worker graph and executes its real Firebase
// verifier, Durable Objects, protocol parser and SQLite transactions. Only the
// network, clock and WebSocket transport are local synthetic fixtures.
function harness(t) {
  const h = createHarness();
  t.after(() => h.close());
  return h;
}
const last = (connection, type) => connection.messages(type).at(-1);
const session = (h, uid) => h.room().sql.exec('SELECT * FROM voxel_sessions WHERE uid=?', uid).toArray()[0];
const position = p => ({ x: p.x, y: p.y, z: p.z, r: p.r });

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function authenticate(h, { uid = 'synthetic-p2-user', zone, token, protocol, authFields = {}, ...fields } = {}) {
  const connection = await h.open(zone ? `/play?zone=${encodeURIComponent(zone)}` : '/play');
  await connection.send({ type: 'auth', token: token ?? h.token(uid), name: 'Security fixture',
    protocol: protocol ?? (zone ? 6 : 4), ...fields, ...authFields });
  return connection;
}
function assertAuthenticated(h, connection, uid) {
  assert.equal(connection.client.closed, false);
  const welcome = last(connection, 'welcome');
  assert.ok(welcome, 'verified auth must return a welcome');
  assert.equal(connection.attachment().uid, uid);
  assert.equal(typeof welcome.session?.sessionId, 'string');
  assert.equal(typeof welcome.session?.resumeToken, 'string');
  assert.ok(welcome.session.resumeToken.length >= 20);
  assert.ok(welcome.session.resumeExpiresAt > h.now());
  assert.equal(welcome.session.tokenExpiresAt, connection.attachment().exp * 1000);
  const row = session(h, uid);
  assert.equal(row.session_id, welcome.session.sessionId);
  assert.equal(row.player_id, welcome.id);
  assert.ok(row.lease_expires > h.now());
  return welcome;
}
async function rejectFrame(connection, frame) {
  // Invalid schema/ranges have a bounded three-strike policy. Malformed JSON,
  // unknown messages, incompatible protocol and oversized packets may close
  // immediately. Both paths must fail closed without mutation.
  for (let attempt = 0; attempt < 3 && !connection.client.closed; attempt++) await connection.send(frame);
  assert.equal(connection.client.closed, true);
  assert.ok([1003, 1007, 1008, 1009].includes(connection.client.closeInfo.code));
}

test('P2 real Firebase verifier rejects invalid signatures, expired tokens and invalid claims', async t => {
  const h = harness(t);
  const uid = 'synthetic-p2-verifier';
  const verified = await h.runtime.verifyFirebaseIdToken(h.token(uid), h.env.FIREBASE_PROJECT_ID);
  assert.equal(verified.uid, uid);
  const cases = [
    h.token(uid, { exp: Math.floor(h.now() / 1000) }),
    h.token(uid, { aud: 'synthetic-other-project' }),
    h.token(uid, { iss: 'https://synthetic.invalid/issuer' }),
    h.token('', { sub: '' }),
    'synthetic-invalid-token'
  ];
  const components = h.token(uid).split('.');
  const signature = Buffer.from(components[2], 'base64url');
  signature[0] ^= 1;
  cases.push(`${components[0]}.${components[1]}.${signature.toString('base64url')}`);
  for (const token of cases) await assert.rejects(h.runtime.verifyFirebaseIdToken(token, h.env.FIREBASE_PROJECT_ID));
  assert.ok(h.records.fetches.every(record => record.url === CERTS_URL));
});

test('P2 custom backend request verifier requires valid Firebase ID and App Check tokens', async t => {
  const h = createHarness({ env: {
    APP_ENV: 'staging',
    STAGING_WORKER_NAME: 'gpt-voxel-3d-staging-01',
    FIREBASE_PROJECT_ID: 'rebuild-synthetic-project',
    FIREBASE_PUBLIC_CONFIG: JSON.stringify({
      apiKey: 'AIza' + '0'.repeat(35),
      projectId: 'rebuild-synthetic-project',
      appId: '1:123456789:web:abcdef1234567890'
    })
  }});
  t.after(() => h.close());
  const uid = 'synthetic-request-verifier';
  assert.equal((await h.runtime.verifyFirebaseRequestTokens(
    h.token(uid), h.appCheckToken(), h.env)).uid, uid);
  await assert.rejects(h.runtime.verifyFirebaseRequestTokens(
    h.token(uid), 'invalid-app-check-token', h.env), error => error.authStage === 'app-check');
  await assert.rejects(h.runtime.verifyFirebaseRequestTokens(
    'invalid-id-token', h.appCheckToken(), h.env), error => error.authStage === 'active-user');
  assert.ok(h.records.fetches.some(record => record.url ===
    'https://firebaseappcheck.googleapis.com/v1/jwks'));
});

test('P2 staging online Firebase user check rejects disabled revoked and missing users', async t => {
  const firebaseEnv = {
    APP_ENV: 'staging',
    STAGING_WORKER_NAME: 'gpt-voxel-3d-staging-01',
    STAGING_WORKER_ORIGIN: 'https://gpt-voxel-3d-staging-01.hjinffv5426.workers.dev',
    FIREBASE_ONLINE_USER_CHECK: 'true',
    FIREBASE_PUBLIC_CONFIG: JSON.stringify({
      apiKey: 'AIza' + '0'.repeat(35),
      projectId: 'rebuild-synthetic-project'
    })
  };
  {
    const h = createHarness({ env: firebaseEnv, firebaseUserState: 'active' });
    t.after(() => h.close());
    const uid = 'synthetic-online-active';
    assert.equal((await h.runtime.verifyFirebaseActiveIdToken(
      h.token(uid), h.env, 'synthetic-app-check-token')).uid, uid);
    assert.ok(h.records.fetches.some(record =>
      record.url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=')));
  }
  for (const mode of ['disabled', 'revoked', 'missing']) {
    const h = createHarness({ env: firebaseEnv, firebaseUserState: mode });
    t.after(() => h.close());
    await assert.rejects(
      h.runtime.verifyFirebaseActiveIdToken(h.token('synthetic-online-' + mode), h.env, 'synthetic-app-check-token'),
      error => mode === 'missing' ? error.firebaseLookupStatus === 400 : error.firebaseLookupReason === mode
    );
  }
});

test('P2 online Firebase user check stays off outside explicitly enabled staging', async t => {
  const h = createHarness({ env: {
    FIREBASE_ONLINE_USER_CHECK: 'false',
    FIREBASE_PUBLIC_CONFIG: JSON.stringify({
      apiKey: 'AIza' + '0'.repeat(35),
      projectId: 'rebuild-synthetic-project'
    })
  }});
  t.after(() => h.close());
  const before = h.records.fetches.length;
  const uid = 'synthetic-local-only';
  assert.equal((await h.runtime.verifyFirebaseActiveIdToken(h.token(uid), h.env)).uid, uid);
  const after = h.records.fetches.slice(before);
  assert.ok(after.every(record => record.url === CERTS_URL));
});

test('P2 compatible protocols authenticate and incompatible protocols fail closed', async t => {
  const h = harness(t);
  for (const [zone, protocol] of [[undefined, 4], ['4,4', 6]]) {
    const uid = `synthetic-p2-protocol-${protocol}`;
    const accepted = await authenticate(h, { uid, zone, protocol });
    assert.equal(assertAuthenticated(h, accepted, uid).protocol, protocol);
    for (const invalid of [protocol === 4 ? 6 : 4, 0, 999, '6']) {
      const rejected = await authenticate(h, { uid: `${uid}-invalid-${invalid}`, zone, protocol: invalid });
      await rejectFrame(rejected, { type: 'auth', token: h.token(`${uid}-invalid-${invalid}`), protocol: invalid });
      assert.equal(rejected.messages('welcome').length, 0);
      assert.equal(session(h, `${uid}-invalid-${invalid}`), undefined);
    }
  }
  // Existing P0/P1 clients omit the field; compatibility is deliberate rather
  // than silently treating an explicitly incompatible version as valid.
  const legacy = await h.open();
  await legacy.send({ type: 'auth', token: h.token('synthetic-p2-missing-version') });
  assertAuthenticated(h, legacy, 'synthetic-p2-missing-version');
});

test('P2 unauthenticated sockets expire at the server ten-second deadline in both entrypoints', async t => {
  const h = harness(t);
  const connections = [await h.open(), await h.open('/play?zone=4,4')];
  await h.advance(9999);
  for (const connection of connections) assert.equal(connection.client.closed, false);
  await h.advance(1);
  for (const connection of connections) {
    assert.equal(connection.client.closed, true);
    assert.equal(connection.client.closeInfo.code, 1008);
    assert.equal(connection.messages('welcome').length, 0);
  }
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_sessions').toArray()[0].count, 0);
});

test('P2 invalid and expired socket authentication never acquires an owner', async t => {
  const h = harness(t);
  for (const zone of [undefined, '4,4']) {
    for (const token of ['synthetic-invalid-token', h.token('synthetic-p2-expired', { exp: Math.floor(h.now() / 1000) })]) {
      const connection = await authenticate(h, { zone, uid: 'synthetic-p2-expired', token });
      assert.equal(connection.client.closed, true);
      assert.equal(connection.client.closeInfo.code, 1008);
      assert.ok(last(connection, 'auth_error'));
      assert.equal(connection.messages('welcome').length, 0);
    }
  }
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_sessions').toArray()[0].count, 0);
});

test('P2 refresh preserves verified UID, identity and ownership and rejects UID switches', async t => {
  const h = harness(t);
  for (const zone of [undefined, '4,4']) {
    const uid = `synthetic-p2-refresh-${zone ?? 'room'}`;
    const connection = await authenticate(h, { uid, zone });
    const welcome = assertAuthenticated(h, connection, uid);
    await h.advance(1000);
    await connection.send({ type: 'auth', protocol: zone ? 6 : 4, token: h.token(uid) });
    assert.ok(last(connection, 'auth_refreshed'));
    assert.equal(connection.attachment().id, welcome.id);
    assert.equal(connection.attachment().sessionId, welcome.session.sessionId);
    assert.equal(session(h, uid).session_id, welcome.session.sessionId);
    assert.equal(connection.attachment().exp, Math.floor(h.now() / 1000) + 3600);
    await connection.send({ type: 'auth', protocol: zone ? 6 : 4, token: h.token(`${uid}-other`) });
    assert.equal(connection.client.closed, true);
    assert.equal(connection.client.closeInfo.code, 1008);
    assert.equal(session(h, `${uid}-other`), undefined);
    assert.equal(connection.attachment().uid, uid);
  }
});

test('P2 expired authenticated token cannot move or reward despite an unexpired resume lease', async t => {
  const h = harness(t);
  const uid = 'synthetic-p2-expiry-authority';
  const connection = await authenticate(h, { uid, token: h.token(uid, { exp: Math.floor(h.now() / 1000) + 1 }) });
  const before = position(connection.attachment());
  const coin = h.room().coinSnapshot()[0];
  await h.advance(1000);
  await connection.send({ type: 'collect', id: coin.id });
  assert.equal(connection.client.closed, true);
  assert.equal(connection.client.closeInfo.code, 1008);
  assert.deepEqual(position(connection.attachment()), before);
  assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, 0);
  assert.equal(h.room().coinSnapshot()[0].respawnAt, 0);
});

test('P2 malformed JSON, null, arrays, unknown and outbound-only packets fail closed', async t => {
  const h = harness(t);
  const frames = ['{not-json', 'null', '[]', '42', { type: 'synthetic_unknown_type' }, { type: 'welcome', score: 999999 }];
  for (const zone of [undefined, '4,4']) for (let i = 0; i < frames.length; i++) {
    const uid = `synthetic-p2-malformed-${zone ?? 'room'}-${i}`;
    const connection = await authenticate(h, { uid, zone });
    const before = position(connection.attachment());
    await rejectFrame(connection, frames[i]);
    assert.deepEqual(position(connection.attachment()), before);
    assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, 0);
  }
});

test('P2 schema rejects invalid scalar types and bounds without mutating gameplay state', async t => {
  const h = harness(t);
  const frames = [
    { type: 'collect', id: -1 }, { type: 'collect', id: 200 }, { type: 'collect', id: 1.5 }, { type: 'collect', id: '1' },
    { type: 'move', x: '1', y: 0, z: 0, r: 0 }, { type: 'move', x: null, y: 0, z: 0, r: 0 },
    { type: 'move', x: 0, y: 0, z: 0 }, { type: 'move', x: 749, y: 0, z: 0, r: 0 },
    { type: 'move', x: 0, y: 9, z: 0, r: 0 }, { type: 'move', x: 0, y: 0, z: 0, r: 10001 }
  ];
  for (let i = 0; i < frames.length; i++) {
    const connection = await authenticate(h, { uid: `synthetic-p2-schema-${i}` });
    const before = position(connection.attachment());
    await rejectFrame(connection, frames[i]);
    assert.deepEqual(position(connection.attachment()), before);
    assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', `synthetic-p2-schema-${i}`).toArray()[0].score, 0);
  }
});

test('P2 oversized ASCII and multibyte UTF-8 frames close before parsing or state changes', async t => {
  const h = harness(t);
  for (const [index, frame] of ['x'.repeat(8193), JSON.stringify({ type: 'auth', token: 'é'.repeat(5000) })].entries()) {
    assert.ok(Buffer.byteLength(frame, 'utf8') > 8192);
    const connection = await authenticate(h, { uid: `synthetic-p2-frame-${index}` });
    const before = position(connection.attachment());
    await connection.send(frame);
    assert.equal(connection.client.closed, true);
    assert.equal(connection.client.closeInfo.code, 1009);
    assert.deepEqual(position(connection.attachment()), before);
  }
});

test('P2 binary WebSocket frames cannot enter the text protocol or mutate state', async t => {
  const h = harness(t);
  const connection = await authenticate(h, { uid: 'synthetic-p2-binary-frame' });
  const before = position(connection.attachment());
  await connection.instance.webSocketMessage(connection.server, new Uint8Array([123, 125]).buffer);
  await h.settle();
  assert.equal(connection.client.closed, true);
  assert.equal(connection.client.closeInfo.code, 1003);
  assert.deepEqual(position(connection.attachment()), before);
});

test('P2 movement packet flood and authentication refresh flood are bounded independently', async t => {
  const h = harness(t);
  const mover = await authenticate(h, { uid: 'synthetic-p2-flood' });
  const before = position(mover.attachment());
  for (let i = 0; i < 100 && !mover.client.closed; i++) {
    await mover.send({ type: 'move', input: { x: 0, z: 0, jump: false }, seq: i });
  }
  assert.equal(mover.client.closed, true);
  assert.equal(mover.client.closeInfo.code, 1008);
  assert.deepEqual(position(mover.attachment()), before);
  const refresher = await authenticate(h, { uid: 'synthetic-p2-auth-flood' });
  for (let i = 0; i < 10 && !refresher.client.closed; i++) {
    await refresher.send({ type: 'auth', protocol: 4, token: h.token('synthetic-p2-auth-flood') });
  }
  assert.equal(refresher.client.closed, true);
  assert.equal(refresher.client.closeInfo.code, 1008);
  assert.ok(refresher.messages('auth_refreshed').length <= 2);
});

test('P2 spoofed UID, entitlement and score fields never grant client authority', async t => {
  const h = harness(t);
  const fields = [{ uid: 'synthetic-forged-uid' }, { entitlement: { vip1: true } }, { entitlements: { speedExpires: h.now() + 999999999 } }];
  for (let i = 0; i < fields.length; i++) {
    const uid = `synthetic-p2-auth-spoof-${i}`;
    const connection = await authenticate(h, { uid, authFields: fields[i] });
    await rejectFrame(connection, { type: 'auth', token: h.token(uid), protocol: 4, ...fields[i] });
    assert.equal(connection.messages('welcome').length, 0);
    assert.equal(session(h, uid), undefined);
  }
  const connection = await authenticate(h, { uid: 'synthetic-p2-score-spoof' });
  await rejectFrame(connection, { type: 'move', ...position(connection.attachment()), score: 999999 });
  assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', 'synthetic-p2-score-spoof').toArray()[0].score, 0);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_entitlements').toArray()[0].count, 0);
});

test('P2 concurrent same-UID authentication leaves exactly one durable owner and closes the old socket', async t => {
  const h = harness(t);
  const uid = 'synthetic-p2-concurrent-session';
  const connections = [await h.open(), await h.open()];
  await Promise.all(connections.map(connection => connection.send({ type: 'auth', token: h.token(uid), protocol: 4 })));
  const live = connections.filter(connection => !connection.client.closed);
  assert.equal(live.length, 1);
  const row = session(h, uid);
  assert.equal(row.session_id, live[0].attachment().sessionId);
  assert.ok(row.lease_expires > h.now());
  assert.equal(h.room().count(), 1);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_sessions WHERE uid=?', uid).toArray()[0].count, 1);
  assert.equal(connections.filter(connection => connection.client.closed).length, 1);
});

test('P2 duplicate UID in another zone revokes the first owner and late close cannot release the winner', async t => {
  const h = harness(t);
  const uid = 'synthetic-p2-cross-zone-owner';
  const old = await authenticate(h, { uid, zone: '4,4' });
  assertAuthenticated(h, old, uid);
  const winner = await authenticate(h, { uid, zone: '5,4' });
  const welcome = assertAuthenticated(h, winner, uid);
  assert.equal(old.client.closed, true);
  assert.equal(h.zone('4,4').count(), 0);
  assert.equal(h.zone('5,4').count(), 1);
  await old.close();
  assert.equal(session(h, uid).session_id, welcome.session.sessionId);
  assert.ok(session(h, uid).lease_expires > h.now());
  assert.equal(winner.client.closed, false);
});

test('P2 reconnect resume preserves server player identity and position while rotating the session', async t => {
  const h = harness(t);
  for (const zone of [undefined, '4,4']) {
    const uid = `synthetic-p2-resume-${zone ?? 'room'}`;
    const source = await authenticate(h, { uid, zone });
    const original = assertAuthenticated(h, source, uid);
    await h.advance(200);
    const requested = { ...position(source.attachment()), x: source.attachment().x + 1 };
    await h.moveTo(source, requested);
    assert.ok(Math.abs(source.attachment().x - requested.x) < 1e-9);
    const authoritative = position(source.attachment());
    await source.close();
    assert.equal(session(h, uid).lease_expires, 0);
    const resumed = await authenticate(h, { uid, zone, resumeToken: original.session.resumeToken });
    const welcome = assertAuthenticated(h, resumed, uid);
    assert.equal(welcome.id, original.id);
    assert.deepEqual(position(resumed.attachment()), authoritative);
    assert.notEqual(welcome.session.sessionId, original.session.sessionId);
    assert.notEqual(welcome.session.resumeToken, original.session.resumeToken);
    assert.equal(resumed.messages('welcome').length, 1);
  }
});

test('P2 wrong-UID and replayed resume tickets reject without evicting the valid owner', async t => {
  const h = harness(t);
  const uid = 'synthetic-p2-resume-protection';
  const source = await authenticate(h, { uid });
  const original = assertAuthenticated(h, source, uid);
  const wrongUid = await authenticate(h, { uid: 'synthetic-p2-ticket-thief', resumeToken: original.session.resumeToken });
  assert.equal(wrongUid.client.closed, true);
  assert.equal(wrongUid.messages('welcome').length, 0);
  assert.equal(session(h, 'synthetic-p2-ticket-thief'), undefined);
  assert.equal(source.client.closed, false);
  await source.close();
  const resumed = await authenticate(h, { uid, resumeToken: original.session.resumeToken });
  const current = assertAuthenticated(h, resumed, uid);
  const replay = await authenticate(h, { uid, resumeToken: original.session.resumeToken });
  assert.equal(replay.client.closed, true);
  assert.equal(replay.messages('welcome').length, 0);
  assert.equal(resumed.client.closed, false);
  assert.equal(session(h, uid).session_id, current.session.sessionId);
});

test('P2 persisted session resumes after a real GameRoom SQLite restart', async t => {
  const h = harness(t);
  const uid = 'synthetic-p2-durable-resume';
  const source = await authenticate(h, { uid });
  const original = assertAuthenticated(h, source, uid);
  await h.advance(200);
  await h.moveTo(source, { x: source.attachment().x + 1, z: source.attachment().z });
  const authoritative = position(source.attachment());
  h.restartRoom();
  await h.room().ready;
  const resumed = await authenticate(h, { uid, resumeToken: original.session.resumeToken });
  const welcome = assertAuthenticated(h, resumed, uid);
  assert.equal(welcome.id, original.id);
  assert.deepEqual(position(resumed.attachment()), authoritative);
  assert.notEqual(welcome.session.sessionId, original.session.sessionId);
});

test('P2 expired resume token cannot resurrect ownership or mutate retained state', async t => {
  const h = harness(t);
  const uid = 'synthetic-p2-expired-resume';
  const source = await authenticate(h, { uid });
  const original = assertAuthenticated(h, source, uid);
  await source.close();
  await h.setTime(original.session.resumeExpiresAt + 1);
  const rejected = await authenticate(h, { uid, resumeToken: original.session.resumeToken });
  assert.equal(rejected.client.closed, true);
  assert.equal(rejected.messages('welcome').length, 0);
  assert.equal(session(h, uid).session_id, original.session.sessionId);
  assert.equal(session(h, uid).lease_expires, 0);
});

test('P2 entitlement refresh reads verified backend payment state and logs omit tokens and secrets', async t => {
  const h = harness(t);
  const uid = 'synthetic-p2-entitlement-refresh';
  const token = h.token(uid);
  const connection = await authenticate(h, { uid, token, zone: '4,4' });
  assertAuthenticated(h, connection, uid);
  assert.equal(connection.attachment().speedExpires, 0);
  h.setSlipResult({ code: '200000', data: { amount: 10, transRef: 'synthetic-p2-speed-transaction' } });
  const form = new FormData();
  form.append('item', 'speed');
  form.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'synthetic.png', { type: 'image/png' }));
  const paid = await h.request('/verify-slip', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  assert.equal(paid.status, 200);
  const result = await paid.json();
  assert.ok(result.expiresAt > h.now());
  await connection.send({ type: 'auth', protocol: 6, token: h.token(uid) });
  assert.ok(last(connection, 'auth_refreshed'));
  assert.equal(connection.attachment().speedExpires, result.expiresAt);
  assert.equal(session(h, uid).session_id, last(connection, 'welcome').session.sessionId);
  const logs = JSON.stringify(h.records.logs);
  assert.equal(logs.includes(token), false);
  assert.equal(logs.includes('synthetic-slip-secret'), false);
  assert.ok(h.records.fetches.every(record => [CERTS_URL, SLIP_URL].includes(record.url)));
});

test('P2 asynchronous auth backlog closes the connection before queued verification can authorize it', async t => {
  const h = harness(t);
  for (const zone of [undefined, '4,4']) {
    const uid = `synthetic-p2-auth-backlog-${zone ?? 'room'}`;
    const connection = await h.open(zone ? `/play?zone=${encodeURIComponent(zone)}` : '/play');
    const frame = { type: 'auth', token: h.token(uid), protocol: zone ? 6 : 4 };
    await Promise.all(Array.from({ length: 65 }, () => connection.send(frame)));
    assert.equal(connection.client.closed, true);
    assert.equal(connection.client.closeInfo.code, 1008);
    assert.equal(connection.messages('welcome').length, 0);
    assert.equal(session(h, uid), undefined);
    assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_scores WHERE uid=?', uid).toArray()[0].count, 0);
  }
});

test('P2 an in-flight trusted certificate fetch cannot revive auth after the server deadline', async t => {
  for (const zone of [undefined, '4,4']) {
    const h = harness(t);
    const started = deferred(), released = deferred();
    const originalFetch = h.context.fetch;
    // Delay the existing isolated network fixture. Real RSA verification and
    // ownership acquisition remain untouched and execute after it resumes.
    h.context.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]) === CERTS_URL) {
        started.resolve();
        await released.promise;
      }
      return response;
    };
    const uid = `synthetic-p2-delayed-cert-${zone ?? 'room'}`;
    const connection = await h.open(zone ? `/play?zone=${encodeURIComponent(zone)}` : '/play');
    const verification = connection.send({ type: 'auth', token: h.token(uid), protocol: zone ? 6 : 4 });
    await started.promise;
    await h.advance(10_000);
    assert.equal(connection.client.closed, true);
    released.resolve();
    await verification;
    assert.equal(connection.messages('welcome').length, 0);
    assert.equal(session(h, uid), undefined);
    assert.equal(h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_scores WHERE uid=?', uid).toArray()[0].count, 0);
  }
});

test('P2 delayed durable acquire and validation replies cannot authorize a replaced zone generation', async t => {
  for (const operation of ['acquire', 'validate']) {
    const h = harness(t);
    const started = deferred(), released = deferred();
    const originalGet = h.env.ROOM.getByName.bind(h.env.ROOM);
    let delayed = false;
    h.env.ROOM.getByName = name => {
      const stub = originalGet(name);
      return { async fetch(request) {
        // The actual logical-server transaction executes first. Only delivery
        // of its positive response is delayed by this local RPC transport.
        const response = await stub.fetch(request);
        if (!delayed && new URL(request.url).pathname === `/_internal/session/${operation}`) {
          delayed = true;
          started.resolve();
          await released.promise;
        }
        return response;
      } };
    };
    const uid = `synthetic-p2-delayed-generation-${operation}`;
    const source = await h.open('/play?zone=4,4');
    const pending = source.send({ type: 'auth', token: h.token(uid), protocol: 6 });
    await started.promise;
    const replacement = await authenticate(h, { uid, zone: '5,4' });
    const current = assertAuthenticated(h, replacement, uid);
    released.resolve();
    await pending;
    assert.equal(source.client.closed, true);
    assert.equal(source.messages('welcome').length, 0);
    assert.equal(h.zone('4,4').count(), 0);
    assert.equal(h.zone('5,4').count(), 1);
    assert.equal(session(h, uid).session_id, current.session.sessionId);
    assert.ok(session(h, uid).lease_expires > h.now());
    await source.close();
    assert.equal(session(h, uid).session_id, current.session.sessionId);
    assert.ok(session(h, uid).lease_expires > h.now());
  }
});

test('P2 duplicate, stale and out-of-order movement sequences cannot mutate or rebroadcast position', async t => {
  const h = harness(t);
  const mover = await authenticate(h, { uid: 'synthetic-p2-sequence-mover' });
  const observer = await authenticate(h, { uid: 'synthetic-p2-sequence-observer' });
  observer.clear();
  await h.advance(200);
  const target = { ...position(mover.attachment()), x: mover.attachment().x + 1 };
  const { position: first } = await h.moveTo(mover, target, { seq: 10 });
  assert.deepEqual(position(mover.attachment()), first);
  assert.equal(observer.messages('move').length, 1);
  for (const seq of [10, 9, 0, 8]) {
    await h.advance(200);
    await mover.send({ type: 'move', input: { x: 1, z: 0, jump: false }, seq });
    assert.deepEqual(position(mover.attachment()), first);
    assert.equal(observer.messages('move').length, 1);
  }
  await h.advance(200);
  const { position: next } = await h.moveTo(mover, { x: first.x + 1, z: first.z }, { seq: 11 });
  assert.deepEqual(position(mover.attachment()), next);
  assert.equal(observer.messages('move').length, 2);
  assert.equal(mover.client.closed, false);
  assert.equal(mover.attachment().lastSequence, 11);
});

test('P2 coin request replay cannot consume another cycle or grant another score', async t => {
  const h = harness(t);
  const uid = 'synthetic-p2-coin-request-replay';
  const connection = await authenticate(h, { uid });
  const coin = h.room().coinSnapshot()[0];
  h.place(connection, { x: coin.x, y: 0, z: coin.z, r: 0 });
  const packet = { type: 'collect', id: 0, requestId: 'synthetic-coin-action-1' };
  await connection.send(packet);
  assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, 1);
  const before = h.room().coinSnapshot()[0];
  const events = connection.messages('coin_collected').length;
  await h.advance(60_000);
  const respawned = h.room().coinSnapshot()[0];
  h.place(connection, { x: respawned.x, y: 0, z: respawned.z, r: 0 });
  await connection.send(packet);
  assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, 1);
  assert.equal(h.room().coinSnapshot()[0].cycle, before.cycle);
  assert.equal(connection.messages('coin_collected').length, events);
  await connection.send({ ...packet, requestId: 'synthetic-coin-action-2' });
  assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, 2);
  assert.equal(h.room().coinSnapshot()[0].cycle, before.cycle + 1);
});

test('P2 Lucky Box action replay cannot repeat the claim, reward or broadcast', async t => {
  const h = harness(t);
  const uid = 'synthetic-p2-box-request-replay';
  const connection = await authenticate(h, { uid });
  const box = h.room().boxSnapshot();
  h.place(connection, { x: box.x, y: 0, z: box.z, r: 0 });
  const claim = { type: 'collect_box', requestId: 'synthetic-box-claim-1' };
  await connection.send(claim);
  assert.equal(connection.messages('box_spin_ready').length, 1);
  await connection.send(claim);
  assert.equal(connection.messages('box_spin_ready').length, 1);
  const spin = { type: 'spin_box', requestId: 'synthetic-box-spin-1' };
  await connection.send(spin);
  assert.equal(connection.messages('box_reward').length, 1);
  const reward = last(connection, 'box_reward').reward;
  const snapshot = h.room().boxSnapshot();
  const emitted = connection.messages().length;
  await connection.send(spin);
  assert.equal(connection.messages('box_reward').length, 1);
  assert.equal(connection.messages().length, emitted);
  assert.deepEqual(h.room().boxSnapshot(), snapshot);
  assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, reward);
});

test('P2 unknown signing-key traffic has bounded trusted refresh and rotated key IDs validate after refresh', async t => {
  const h = harness(t);
  const originalFetch = h.context.fetch;
  const rotatedKid = 'synthetic-p2-rotated-signing-kid';
  let exposeRotatedKid = false;
  h.context.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (String(args[0]) !== CERTS_URL) return response;
    const certs = await response.json();
    // The synthetic trusted endpoint rotates its key identifier. Both mapped
    // certificates contain the real fixture RSA public key, so this exercises
    // cache rotation without replacing or bypassing cryptographic verification.
    if (exposeRotatedKid) certs[rotatedKid] = Object.values(certs)[0];
    return Response.json(certs, { headers: { 'cache-control': 'public, max-age=3600' } });
  };
  const uid = 'synthetic-p2-key-rotation';
  assert.equal((await h.runtime.verifyFirebaseIdToken(h.token(uid), h.env.FIREBASE_PROJECT_ID)).uid, uid);
  const fetchCount = () => h.records.fetches.filter(record => record.url === CERTS_URL).length;
  assert.equal(fetchCount(), 1);
  const rotatedToken = h.token(uid, {}, { kid: rotatedKid });
  for (let attempt = 0; attempt < 10; attempt++) {
    await assert.rejects(h.runtime.verifyFirebaseIdToken(rotatedToken, h.env.FIREBASE_PROJECT_ID), /Unknown Firebase signing key/);
  }
  assert.equal(fetchCount(), 1);
  await h.advance(59_999);
  await assert.rejects(h.runtime.verifyFirebaseIdToken(rotatedToken, h.env.FIREBASE_PROJECT_ID), /Unknown Firebase signing key/);
  assert.equal(fetchCount(), 1);
  await h.advance(1);
  exposeRotatedKid = true;
  const verified = await Promise.all(Array.from({ length: 20 }, () =>
    h.runtime.verifyFirebaseIdToken(rotatedToken, h.env.FIREBASE_PROJECT_ID)));
  assert.ok(verified.every(result => result.uid === uid));
  assert.equal(fetchCount(), 2, 'Concurrent login verification shares exactly one trusted refresh');
  assert.equal((await h.runtime.verifyFirebaseIdToken(h.token(uid), h.env.FIREBASE_PROJECT_ID)).uid, uid);
  for (let attempt = 0; attempt < 10; attempt++) {
    await assert.rejects(h.runtime.verifyFirebaseIdToken(h.token(uid, {}, { kid: 'synthetic-p2-unknown-key' }), h.env.FIREBASE_PROJECT_ID), /Unknown Firebase signing key/);
  }
  assert.equal(fetchCount(), 2, 'Untrusted key IDs cannot cause another refresh inside the minute');
});
