'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createHarness, CERTS_URL, SLIP_URL } = require('./harness.cjs');

// P9 executes the actual bundled Worker, verified synthetic RSA identities,
// transactional SQLite, signed provider-neutral events and real DO handlers.
// Origins, Firebase public identifiers and payment signatures here are explicit
// local fixtures. No external service, deployed resource or payment is used.
const PROJECT_ID = 'rebuild-staging-fixture';
const ORIGIN = 'https://gpt-voxel-3d-staging-fixture.invalid';
const WORKER_NAME = 'gpt-voxel-3d-staging-fixture';
const FIREBASE = Object.freeze({ apiKey: 'synthetic-public-staging-key',
  authDomain: `${PROJECT_ID}.firebaseapp.com`, projectId: PROJECT_ID,
  appId: '1:123456:web:abcdef123456' });
const APP_CHECK = Object.freeze({ provider: 'recaptcha-enterprise', siteKey: '6L' + 'A'.repeat(38) });
const MONTH = 30 * 24 * 60 * 60 * 1000;
const BOX_COOLDOWN = 4 * 60 * 60 * 1000;
const last = (socket, type) => socket.messages(type).at(-1);
const plain = value => JSON.parse(JSON.stringify(value));
const position = p => Object.fromEntries(['x', 'y', 'z', 'r'].map(key => [key, Number(p[key])]));
const zoneAt = p => `${Math.floor((p.x + 750) / 150)},${Math.floor((p.z + 750) / 150)}`;
const contact = p => ({ x: p.x, y: 0, z: p.z, r: 0 });
const session = (p, changes = {}) => ({ uid: p.uid, sessionId: p.sessionId,
  owner: p.zoneId ? `zone:${p.zoneId}` : 'room', ...changes });

function fixture(t, env = {}) {
  const h = createHarness({ workerOrigin: ORIGIN, defaultTokenProject: PROJECT_ID,
    env: { APP_ENV: 'staging',
    STAGING_WORKER_NAME: WORKER_NAME, STAGING_WORKER_ORIGIN: ORIGIN,
    ALLOWED_ORIGIN: ORIGIN, FIREBASE_PROJECT_ID: PROJECT_ID,
    FIREBASE_PUBLIC_CONFIG: JSON.stringify(FIREBASE),
    FIREBASE_APP_CHECK_SITE_KEY: APP_CHECK.siteKey,
    STAGING_AUTH_MODE: 'popup', PAYMENT_MODE: 'provider-neutral-test', ...env } });
  t.after(() => h.close());
  return h;
}
async function admitted(h, uid, input = {}) {
  const socket = await h.connect({ uid, zone: '4,4', ...input });
  assert.ok(last(socket, 'welcome'), 'actual staging RSA verifier admits only the signed fixture');
  assert.equal(socket.client.readyState, 1);
  return socket;
}
async function privateCheckpoint(h, payload) {
  const response = await h.room().fetch(new Request('https://internal/_internal/session/checkpoint', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  }));
  return { status: response.status, body: await response.json() };
}
function restartZone(h, zone) {
  const entry = h.env.ZONE.object(`free-zone-${zone}`);
  entry.instance = new h.runtime.ZoneRoom(entry.ctx, h.env);
  return entry.instance;
}
async function livePacket(h, instance, socket, payload) {
  await instance.webSocketMessage(socket.server, typeof payload === 'string' ? payload : JSON.stringify(payload));
  await h.settle();
}
function event(h, uid, changes = {}) {
  return { eventId: `p9-event:${uid}:1`, subscriptionId: `p9-subscription:${uid}`, uid,
    version: 1, status: 'active', product: 'vip1', amount: 50, currency: 'THB',
    periodStart: h.now() - 1000, periodEnd: h.now() - 1000 + MONTH, ...changes };
}
function signed(h, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const timestamp = headers['x-provider-timestamp'] ?? String(Math.floor(h.now() / 1000));
  const signature = createHmac('sha256', h.env.PAYMENT_WEBHOOK_SECRET)
    .update(timestamp + '.' + body).digest('hex');
  return { method: 'POST', body, headers: { 'content-type': 'application/json',
    'x-provider-timestamp': timestamp, 'x-provider-signature': signature, ...headers } };
}
const webhook = (h, payload, headers) => h.request('/payments/webhook', signed(h, payload, headers));
async function activated(h, uid, changes = {}) {
  const payload = event(h, uid, changes), response = await webhook(h, payload);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  return payload;
}
function count(room, table) { return room.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0].n; }
function failWrite(room, table, operation, trigger) {
  room.sql.exec(`CREATE TRIGGER ${trigger} BEFORE ${operation} ON ${table}
    BEGIN SELECT RAISE(ABORT,'synthetic P9 SQLite outage'); END`);
}

test('P9 staging public manifest exposes only configured browser fields, never privileged bindings', async t => {
  const h = fixture(t);
  h.env.ASSETS = { async fetch(request) {
    assert.equal(new URL(request.url).origin, ORIGIN);
    return new Response('<!doctype html><title>synthetic staging asset</title>');
  } };
  const response = await h.request('/staging-config');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(value, { environment: 'staging', workerName: WORKER_NAME,
    workerOrigin: ORIGIN, firebase: FIREBASE, appCheck: APP_CHECK, authMode: 'popup' });
  const text = JSON.stringify(value);
  for (const secret of [h.env.PAYMENT_WEBHOOK_SECRET, h.env.SLIP2GO_API_SECRET,
    h.env.PAYMENT_RECEIVER_ACCOUNT]) assert.equal(text.includes(secret), false);
  assert.equal(h.records.routes.length, 0, 'reading public config cannot touch storage');
  assert.equal(h.records.fetches.length, 0);
  assert.equal((await h.request('/')).status, 200);
  assert.match(await (await h.request('/health')).text(), /staging/i);
});

test('P9 a named staging host cannot downgrade to legacy routing if every staging selector is removed', async t => {
  const h=fixture(t,{APP_ENV:undefined,STAGING_WORKER_NAME:undefined,STAGING_WORKER_ORIGIN:undefined,
    FIREBASE_PUBLIC_CONFIG:undefined,STAGING_AUTH_MODE:undefined,PAYMENT_MODE:undefined});
  for(const path of ['/health','/staging-config','/verify-slip','/play?zone=4,4']) {
    assert.equal((await h.request(path,{headers:{Upgrade:'websocket'}})).status,503);
  }
  assert.equal((await webhook(h,event(h,'p9-missing-all-stage-markers'))).status,503);
  assert.equal(h.records.routes.length,0);
  assert.equal(h.records.fetches.length,0);
});

test('P9 missing, production-crossover and incoherent staging config fail closed before resources are routed', async t => {
  const invalid = [
    { APP_ENV: undefined }, { APP_ENV: 'production' }, { APP_ENV: 'unknown' },
    { STAGING_WORKER_NAME: undefined }, { STAGING_WORKER_ORIGIN: undefined },
    { FIREBASE_PUBLIC_CONFIG: undefined }, { FIREBASE_PROJECT_ID: undefined },
    { FIREBASE_APP_CHECK_SITE_KEY: undefined },
    { STAGING_AUTH_MODE: undefined }, { PAYMENT_MODE: undefined },
    { STAGING_WORKER_NAME: 'voxel-run-v2-demo' }, { FIREBASE_PROJECT_ID: 'lucky-game-6936b',
      FIREBASE_PUBLIC_CONFIG: JSON.stringify({ ...FIREBASE, projectId: 'lucky-game-6936b',
        authDomain: 'lucky-game-6936b.firebaseapp.com' }) },
    { STAGING_WORKER_ORIGIN: 'http://gpt-voxel-3d-staging-fixture.example.invalid' },
    { STAGING_WORKER_ORIGIN: 'https://localhost' },
    { STAGING_WORKER_ORIGIN: 'https://127.0.0.1' },
    { STAGING_WORKER_ORIGIN: `${ORIGIN}/play` },
    { ALLOWED_ORIGIN: 'https://unrelated.invalid' },
    { FIREBASE_PUBLIC_CONFIG: '{' },
    { FIREBASE_PUBLIC_CONFIG: JSON.stringify({ ...FIREBASE, projectId: 'unrelated-project' }) },
    { FIREBASE_PUBLIC_CONFIG: JSON.stringify({ ...FIREBASE, private_key: 'synthetic-forbidden-field' }) },
    { FIREBASE_APP_CHECK_SITE_KEY: 'invalid-site-key' },
    { STAGING_AUTH_MODE: 'untrusted-mode' }, { PAYMENT_MODE: 'production' }
  ];
  for (const [index, config] of invalid.entries()) {
    const h = fixture(t, config);
    for (const [path, headers] of [['/staging-config', {}], ['/play?zone=4,4', { Upgrade: 'websocket' }],
      ['/payments/webhook', {}], ['/verify-slip', {}]]) {
      const response = await h.request(path, { headers });
      assert.equal(response.status, 503, `invalid config ${index} must reject ${path}`);
      const text = await response.text();
      assert.equal(text.includes('synthetic-forbidden-field'), false);
      assert.equal(text.includes(h.env.PAYMENT_WEBHOOK_SECRET), false);
    }
    assert.equal(h.records.routes.length, 0);
    assert.equal(h.records.fetches.length, 0);
  }
});

test('P9 configured staging exposes read-only probes but rejects cross-origin protected routes before any DO', async t => {
  const h = fixture(t);
  for (const path of ['/health', '/staging-config']) {
    const response = await h.request(path, { headers: { Origin: 'https://production-client.invalid' } });
    assert.equal(response.status, 200, path);
  }
  for (const path of ['/entitlements', '/payments/webhook', '/play?zone=4,4']) {
    const response = await h.request(path, { headers: { Origin: 'https://production-client.invalid',
      ...(path.startsWith('/play') ? { Upgrade: 'websocket' } : {}) } });
    assert.equal(response.status, 403, path);
  }
  const wrongHost = await h.worker.fetch(new Request('https://voxel-run-v2-demo.example.invalid/play', {
    headers: { Origin: ORIGIN, Upgrade: 'websocket' }
  }), h.env);
  assert.equal(wrongHost.status, 503);
  assert.equal(h.records.routes.length, 0);
  assert.equal(h.records.fetches.length, 0);
});

test('P9 staging legacy real-payment path is unavailable even if unexpected legacy bindings are present', async t => {
  const h = fixture(t);
  const form = new FormData();
  form.append('item', 'vip1');
  form.append('file', new File(['synthetic-not-a-real-slip'], 'fixture.png', { type: 'image/png' }));
  const response = await h.request('/verify-slip', { method: 'POST', body: form,
    headers: { Authorization: `Bearer ${h.token('p9-no-charge')}` } });
  assert.equal(response.status, 503);
  assert.equal(h.records.fetches.some(fetch => fetch.url === SLIP_URL), false);
  assert.equal(h.records.fetches.length, 0, 'payment-disabled boundary runs before credential verification/network');
  assert.equal(h.records.routes.length, 0);
});

test('P9 missing staging APP_ENV cannot downgrade to legacy payment or authenticated mutation routing', async t => {
  const h = fixture(t, { APP_ENV: undefined });
  const form = new FormData();
  form.append('item', 'vip1');
  form.append('file', new File(['synthetic-downgrade-probe'], 'fixture.png', { type: 'image/png' }));
  const slip = await h.request('/verify-slip', { method: 'POST', body: form,
    headers: { Authorization: `Bearer ${h.token('p9-no-staging-downgrade')}` } });
  assert.equal(slip.status, 503);
  const payment = await webhook(h, event(h, 'p9-no-staging-downgrade'));
  assert.equal(payment.status, 503);
  const socket = await h.request('/play?zone=4,4', { headers: { Upgrade: 'websocket' } });
  assert.equal(socket.status, 503);
  assert.equal(h.records.fetches.length, 0, 'missing flag cannot expose legacy payment or Firebase network path');
  assert.equal(h.records.routes.length, 0, 'missing flag cannot mutate any DO');
});

test('P9 verified staging UID is authoritative; forged identity fields and cross-project auth are rejected', async t => {
  const h = fixture(t), uid = 'p9-auth-owner';
  for (const forged of [{ uid: 'forged-victim' }, { playerId: 'forged-player' },
    { sessionId: 'forged-session' }, { vip: true }, { score: 999999 }]) {
    const socket = await h.open('/play?zone=4,4');
    await socket.send({ type: 'auth', token: h.token(uid), ...forged });
    assert.equal(socket.messages('welcome').length, 0);
  }
  const wrongProject = await h.connect({ uid, zone: '4,4', token: h.token(uid, {
    aud: 'lucky-game-6936b', iss: 'https://securetoken.google.com/lucky-game-6936b' }) });
  assert.equal(wrongProject.client.closed, true);
  assert.equal(h.room().sessions.row(uid), undefined);
  assert.equal(h.room().sessions.row('forged-victim'), undefined);
  const valid = await admitted(h, uid);
  assert.equal(valid.attachment().uid, uid);
  assert.equal(h.room().sessions.row(uid).player_id, last(valid, 'welcome').id);
  assert.ok(h.records.fetches.some(fetch => fetch.url === CERTS_URL));
});

test('P9 expired, invalid signature and malformed Firebase tokens cannot acquire a staging session', async t => {
  const h = fixture(t), uid = 'p9-invalid-auth';
  const valid = h.token(uid), changedSignature = valid.slice(0, valid.lastIndexOf('.') + 1) + 'A'.repeat(342);
  const tokens = [h.token(uid, { exp: Math.floor(h.now() / 1000) }),
    'not-a-firebase-token', 'a.b.c', changedSignature,
    h.token(uid, {}, { alg: 'none' }), h.token(uid, { sub: '' })];
  for (const token of tokens) {
    const connection = await h.connect({ uid, zone: '4,4', token });
    assert.equal(connection.messages('welcome').length, 0);
    assert.equal(connection.client.closed, true);
    assert.equal(h.room().sessions.row(uid), undefined);
  }
  assert.equal(count(h.room(), 'voxel_sessions'), 0);
  assert.equal(count(h.room(), 'voxel_vip_seats'), 0);
});

test('P9 same-origin fetch without Origin verifies token UID rather than a query UID', async t => {
  const h = fixture(t), owner = 'p9-http-owner', victim = 'p9-http-victim';
  await activated(h, victim);
  const response = await h.worker.fetch(new Request(`${ORIGIN}/entitlements?uid=${victim}`, {
    headers: { Authorization: `Bearer ${h.token(owner)}` }
  }), h.env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.entitlements.vip1Expires, 0);
  assert.equal(h.room().vip.entitlement(victim).active, true,
    'victim has entitlement, but query UID cannot select it for another verified account');
  const invalid = await h.worker.fetch(new Request(`${ORIGIN}/entitlements?uid=${victim}`, {
    headers: { Authorization: 'Bearer malformed-synthetic-token' }
  }), h.env);
  assert.equal(invalid.status, 401);
});

test('P9 public HTTP and protocol cannot expose private save/VIP mutation paths or overwrite economy', async t => {
  const h = fixture(t), uid = 'p9-public-mutation', player = await admitted(h, uid);
  const before = h.room().sessions.row(uid), routes = h.records.routes.length;
  const payload = { uid, sessionId: before.session_id, owner: before.owner, revision: 999,
    position: { x: 700, y: 0, z: 700, r: 0 }, score: 999999, vip: true, paid: true, reward: 999999 };
  for (const path of ['session/checkpoint', 'grant-payment', 'vip/apply-event', 'vip/admit']) {
    const response = await h.request(`/_internal/${path}`, { method: 'POST', body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${h.token(uid)}` } });
    assert.equal(response.status, 404);
  }
  assert.equal(h.records.routes.length, routes);
  for (const packet of [{ type: 'save', ...payload }, { type: 'move', seq: 0, x: 700, z: 700 },
    { type: 'collect', id: 0, reward: 999999 }, { type: 'spin_box', vip: true }]) {
    await livePacket(h, h.zone('4,4'), player, packet);
    assert.deepEqual(h.room().sessions.row(uid), before);
    assert.equal(h.room().economy.score(uid), 0);
    assert.equal(h.room().entitlementSnapshot(uid).vip1Expires, 0);
  }
  assert.equal(count(h.room(), 'voxel_economy_actions'), 0);
});

test('P9 staging duplicate reconnect rotates one generation and fences old tickets/sockets after reconstruction', async t => {
  const h = fixture(t), uid = 'p9-reconnect-generation';
  const first = await admitted(h, uid), old = first.attachment();
  await first.close();
  const second = await h.open('/play?zone=4,4');
  await second.send({ type: 'auth', token: h.token(uid), protocol: 6, resumeToken: old.resumeToken });
  assert.ok(last(second, 'welcome'));
  const winner = second.attachment(), durable = h.room().sessions.row(uid);
  assert.notEqual(winner.sessionId, old.sessionId);
  assert.equal(winner.id, old.id);
  const replay = await h.open('/play?zone=4,4');
  await replay.send({ type: 'auth', token: h.token(uid), protocol: 6, resumeToken: old.resumeToken });
  assert.equal(replay.client.closed, true);
  assert.deepEqual(h.room().sessions.row(uid), durable);
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  const current = restartZone(h, '4,4');
  await livePacket(h, current, first, { type: 'move', seq: 99, input: { x: 1, z: 0, jump: false } });
  await current.webSocketClose(first.server); await h.settle();
  assert.deepEqual(h.room().sessions.row(uid), durable);
  assert.equal(h.room().sessions.validate(session(winner)), true);
  assert.equal(current.count(), 1);
});

test('P9 concurrent same-UID fresh login replacements leave one stable identity and one current owner', async t => {
  const h = fixture(t), uid = 'p9-parallel-reconnect';
  const first = await admitted(h, uid), id = first.attachment().id;
  const results = await Promise.all(Array.from({ length: 5 }, () => h.connect({ uid, zone: '4,4' })));
  const active = results.filter(socket => socket.client.readyState === 1);
  assert.equal(active.length, 1);
  assert.equal(active[0].attachment().id, id);
  assert.equal(h.room().sessions.row(uid).session_id, active[0].attachment().sessionId);
  assert.equal(count(h.room(), 'voxel_sessions'), 1);
  assert.equal(h.zone('4,4').count(), 1);
  assert.equal(first.client.closed, true);
});

test('P9 new/returning staging player preserves authored position, score and identity through restart/reconnect', async t => {
  const h = fixture(t), uid = 'p9-persistence-returning';
  const socket = await admitted(h, uid);
  assert.equal(last(socket, 'welcome').score, 0);
  await h.advance(200);
  await socket.send({ type: 'move', seq: 0, input: { x: .1, z: 0, jump: false } });
  assert.equal(last(socket, 'move').ack, 0);
  const coin = h.room().coinSnapshot().find(coin => zoneAt(coin) === '4,4');
  assert.ok(coin, 'deterministic generated coin exists in the authenticated zone');
  h.place(socket, contact(coin));
  await h.advance(200);
  await socket.send({ type: 'collect', id: coin.id, requestId: 'p9-returning-coin' });
  assert.equal(h.room().economy.score(uid), 1);
  const saved = h.room().sessions.row(uid), id = socket.attachment().id;
  await socket.close();
  await h.advance(120001);
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  restartZone(h, '4,4');
  const returning = await admitted(h, uid);
  assert.equal(returning.attachment().id, id);
  assert.notEqual(returning.attachment().sessionId, saved.session_id);
  assert.deepEqual(position(returning.attachment()), position(saved));
  assert.equal(last(returning, 'welcome').score, 1);
  assert.equal(h.room().sessions.row(uid).save_revision, saved.save_revision);
  assert.equal(count(h.room(), 'voxel_economy_actions'), 1);
});

test('P9 trusted staging checkpoint RPC is duplicate-safe, out-of-order-safe and retryable after real rollback', async t => {
  const h = fixture(t), uid = 'p9-save-retry';
  const socket = await admitted(h, uid), player = socket.attachment();
  const initial = h.room().sessions.row(uid), payload = session(player, {
    revision: initial.save_revision + 3, position: { ...position(player), x: -70 } });
  failWrite(h.room(), 'voxel_sessions', 'UPDATE', 'p9_save_abort');
  assert.equal((await privateCheckpoint(h, payload)).status, 503);
  assert.deepEqual(h.room().sessions.row(uid), initial);
  h.room().sql.exec('DROP TRIGGER p9_save_abort');
  assert.equal((await privateCheckpoint(h, payload)).body.ok, true);
  const saved = h.room().sessions.row(uid);
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  await h.advance(1000);
  const duplicate = await privateCheckpoint(h, payload);
  assert.equal(duplicate.body.ok, true); assert.equal(duplicate.body.replayed, true);
  assert.deepEqual(h.room().sessions.row(uid), saved, 'duplicate cannot refresh or roll back the persisted save');
  for (const revision of [initial.save_revision, initial.save_revision + 1, initial.save_revision + 2]) {
    assert.equal((await privateCheckpoint(h, { ...payload, revision, position: { ...payload.position, x: -90 } })).status, 409);
    assert.deepEqual(h.room().sessions.row(uid), saved);
  }
  assert.equal((await privateCheckpoint(h, { ...payload, position: { ...payload.position, x: -71 } })).status, 409);
  assert.deepEqual(h.room().sessions.row(uid), saved);
});

test('P9 trusted checkpoint rejects malformed state, spoofed session/UID and economy overwrite fields', async t => {
  const h = fixture(t), uid = 'p9-save-forgery';
  const socket = await admitted(h, uid), player = socket.attachment(), before = h.room().sessions.row(uid);
  const payload = session(player, { position: position(player), revision: before.save_revision + 1 });
  const bad = [{ ...payload, uid: 'forged-victim' }, { ...payload, sessionId: 'old-generation' },
    { ...payload, owner: 'zone:5,4' }, { ...payload, revision: '1' },
    { ...payload, position: { ...payload.position, x: '1' } },
    { ...payload, position: { ...payload.position, y: 99 } },
    { ...payload, position: { ...payload.position, inventory: [] } },
    ...['score', 'balance', 'reward', 'vip', 'inventory', 'playerId', 'resumeToken']
      .map(field => ({ ...payload, [field]: 999999 }))];
  for (const invalid of bad) {
    assert.equal((await privateCheckpoint(h, invalid)).status, 409);
    assert.deepEqual(h.room().sessions.row(uid), before);
  }
  assert.equal(h.room().economy.score(uid), 0);
  assert.equal(h.room().entitlementSnapshot(uid).vip1Expires, 0);
  assert.equal(count(h.room(), 'voxel_economy_actions'), 0);
});

test('P9 authenticated staging Free users share coins/Lucky Box and cannot duplicate resources or cooldown on restart', async t => {
  const h = fixture(t), room = h.room(), coin = room.coinSnapshot()[31], box = room.boxSnapshot();
  assert.equal(room.coinSnapshot().length, 200);
  const coinZone = zoneAt(coin), boxZone = zoneAt(box);
  const first = await admitted(h, 'p9-free-coin-first', { zone: coinZone });
  const other = await admitted(h, 'p9-free-coin-other', { zone: coinZone });
  const winner = await admitted(h, 'p9-free-box', { zone: boxZone });
  assert.equal(last(first, 'welcome').entitlements.vip1Expires, 0);
  assert.deepEqual(plain(last(first, 'welcome').coins), plain(last(other, 'welcome').coins));
  assert.deepEqual(position(last(first, 'welcome').luckyBox), position(last(winner, 'welcome').luckyBox));
  h.place(first, contact(coin)); h.place(other, contact(coin)); h.place(winner, contact(box));
  const at = h.now();
  await Promise.all([first.send({ type: 'collect', id: coin.id, requestId: 'p9-shared-coin-first' }),
    other.send({ type: 'collect', id: coin.id, requestId: 'p9-shared-coin-other' })]);
  assert.equal(room.economy.score('p9-free-coin-first') + room.economy.score('p9-free-coin-other'), 1);
  assert.equal(room.coinSnapshot()[coin.id].respawnAt, at + 60000);
  assert.ok(first.messages('coin_collected').some(message => message.id === coin.id));
  assert.ok(other.messages('coin_collected').some(message => message.id === coin.id));
  await winner.send({ type: 'collect_box', requestId: 'p9-shared-box' });
  assert.equal(room.boxSnapshot().active, false);
  assert.equal(room.boxSnapshot().nextSpawnAt, at + BOX_COOLDOWN);
  const savedBox = plain(room.boxSnapshot());
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  const current = restartZone(h, boxZone);
  await livePacket(h, current, winner, { type: 'spin_box', requestId: 'p9-shared-spin' });
  const reward = last(winner, 'box_reward')?.reward;
  assert.ok([100, 500, 1000, 5000, 9999].includes(reward));
  await livePacket(h, current, winner, { type: 'spin_box', requestId: 'p9-shared-spin-replay' });
  assert.equal(h.room().economy.score('p9-free-box'), reward);
  assert.equal(h.room().boxSnapshot().nextSpawnAt, savedBox.nextSpawnAt);
  const observer = await admitted(h, 'p9-free-late-observer', { zone: '9,9' });
  assert.equal(last(observer, 'welcome').luckyBox.nextSpawnAt, at + BOX_COOLDOWN);
  assert.equal(last(observer, 'welcome').luckyBox.active, false);
  assert.ok(last(observer, 'welcome').leaderboard.some(row => row.score === reward));
  assert.equal(h.room().vip.count(), 0, 'Free admission never consumes VIP capacity');
});

test('P9 staging world movement/names respect proximity and retain server validation', async t => {
  const h = fixture(t), observer = await admitted(h, 'p9-near-observer', { name: 'Observer' });
  const near = await admitted(h, 'p9-near-player', { name: '  Thai\u202e\u0000 Player  ' });
  const far = await admitted(h, 'p9-far-player', { name: 'Far player' });
  h.place(observer, { x: -149, y: 0, z: -149, r: 0 });
  h.place(near, { x: -148, y: 0, z: -149, r: 0 });
  h.place(far, { x: -1, y: 0, z: -1, r: 0 });
  observer.clear(); far.clear(); near.clear();
  await h.advance(200);
  await near.send({ type: 'move', seq: 0, input: { x: 0, z: 0, jump: false } });
  assert.equal(last(near, 'move').ack, 0);
  const publicNear = observer.messages('join').find(message => message.player?.id === near.attachment().id)?.player;
  const movedNear = observer.messages('move').find(message => message.player?.id === near.attachment().id);
  assert.ok(publicNear || movedNear, 'near observer receives authoritative name/movement visibility');
  if (publicNear) assert.equal(publicNear.name, 'Thai Player');
  assert.equal(near.attachment().nickname, 'Thai Player');
  assert.equal(far.messages('move').some(message => message.player?.id === near.attachment().id), false);
  assert.equal(far.messages('join').some(message => message.player?.id === near.attachment().id), false);
  const before = h.room().sessions.row('p9-near-player');
  await near.send({ type: 'move', seq: 1, input: { x: 999, z: 0, jump: false } });
  assert.deepEqual(h.room().sessions.row('p9-near-player'), before);
});

test('P9 staging signed sandbox entitlement activation is idempotent and requires no browser payment flag', async t => {
  const h = fixture(t), uid = 'p9-vip-signed';
  const denied = await h.connect({ uid, server: 'vip1' });
  assert.equal(denied.messages('welcome').length, 0); assert.equal(denied.client.closed, true);
  const payload = await activated(h, uid);
  const retry = await webhook(h, payload);
  assert.equal(retry.status, 200); assert.equal((await retry.json()).replayed, true);
  assert.equal(count(h.room(), 'voxel_vip_events'), 1);
  assert.equal(count(h.room(), 'voxel_vip_subscriptions'), 1);
  const socket = await admitted(h, uid, { server: 'vip1', zone: undefined });
  assert.equal(last(socket, 'welcome').server, 'vip1');
  assert.equal(last(socket, 'welcome').entitlements.vip1Expires, payload.periodEnd);
  assert.equal(h.room().vip.count(), 1);
  assert.equal(h.records.fetches.every(fetch => fetch.url === CERTS_URL), true);
});

test('P9 sandbox provider webhook without browser Origin still requires exact signed bytes; missing secret fails closed', async t => {
  const h = fixture(t), payload = event(h, 'p9-backend-event');
  const input = signed(h, payload);
  const response = await h.worker.fetch(new Request(`${ORIGIN}/payments/webhook`, input), h.env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  const replay = await h.worker.fetch(new Request(`${ORIGIN}/payments/webhook`, input), h.env);
  assert.equal((await replay.json()).replayed, true);
  const unsigned = await h.worker.fetch(new Request(`${ORIGIN}/payments/webhook`, {
    method: 'POST', body: JSON.stringify({ ...payload, eventId: 'p9-unsigned-backend' }),
    headers: { 'content-type': 'application/json' }
  }), h.env);
  assert.equal(unsigned.status, 401);
  assert.equal(count(h.room(), 'voxel_vip_events'), 1);
  const unconfigured = fixture(t, { PAYMENT_WEBHOOK_SECRET: undefined });
  const unavailable = await unconfigured.request('/payments/webhook', input);
  assert.equal(unavailable.status, 503);
  assert.equal(unconfigured.records.routes.length, 0);
  assert.equal(unconfigured.records.fetches.length, 0);
});

test('P9 staging rejects unsigned/tampered/replayed provider events, forged amount/result and VIP flags without writes', async t => {
  const h = fixture(t), uid = 'p9-vip-forged', payload = event(h, uid);
  const variants = [
    signed(h, payload, { 'x-provider-signature': '0'.repeat(64) }),
    signed(h, payload, { 'x-provider-timestamp': String(Math.floor(h.now() / 1000) - 301) }),
    signed(h, { ...payload, amount: 1 }), signed(h, { ...payload, paid: true }),
    signed(h, { ...payload, vip: true }), signed(h, { ...payload, currency: 'USD' }),
    { ...signed(h, payload), body: JSON.stringify({ ...payload, uid: 'forged-target' }) }
  ];
  for (const input of variants) {
    const response = await h.request('/payments/webhook', input);
    assert.ok([400, 401].includes(response.status));
  }
  const forged = await h.open('/play?server=vip1');
  await forged.send({ type: 'auth', token: h.token(uid), vip: true, paid: true, entitlement: payload.periodEnd });
  assert.equal(forged.messages('welcome').length, 0);
  assert.equal(count(h.room(), 'voxel_vip_events'), 0);
  assert.equal(count(h.room(), 'voxel_vip_subscriptions'), 0);
  assert.equal(h.room().vip.count(), 0);
  await h.room('vip1').ready;
  assert.equal(count(h.room('vip1'), 'voxel_scores'), 0);
});

test('P9 staging provider event rollback/retry survives authority restart without duplicate entitlement', async t => {
  const h = fixture(t), payload = event(h, 'p9-event-rollback');
  await h.room().ready;
  failWrite(h.room(), 'voxel_vip_events', 'INSERT', 'p9_event_abort');
  const failed = await webhook(h, payload); assert.equal(failed.status, 503);
  assert.equal(count(h.room(), 'voxel_vip_events'), 0);
  assert.equal(count(h.room(), 'voxel_vip_subscriptions'), 0);
  assert.equal(h.room().vip.entitlement(payload.uid).active, false);
  h.room().sql.exec('DROP TRIGGER p9_event_abort');
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  const retry = await webhook(h, payload); assert.equal(retry.status, 200);
  const repeated = await webhook(h, payload); assert.equal((await repeated.json()).replayed, true);
  assert.equal(count(h.room(), 'voxel_vip_events'), 1);
  assert.equal(count(h.room(), 'voxel_vip_subscriptions'), 1);
  assert.equal(h.room().vip.entitlement(payload.uid).expiresAt, payload.periodEnd);
});

test('P9 staging VIP reconnect/expiry/revocation preserves generation fencing through both DO restarts', async t => {
  const h = fixture(t), uid = 'p9-vip-lifecycle';
  const expiresAt = h.now() + 60000, payload = await activated(h, uid, {
    periodStart: expiresAt - MONTH, periodEnd: expiresAt });
  const first = await admitted(h, uid, { server: 'vip1', zone: undefined });
  await h.advance(200);
  await first.send({ type: 'move', seq: 0, input: { x: .1, z: 0, jump: false } });
  const old = first.attachment(), saved = h.room('vip1').sessions.row(uid);
  const current = await admitted(h, uid, { server: 'vip1', zone: undefined });
  assert.equal(first.client.closed, true);
  assert.equal(current.attachment().id, old.id);
  assert.notEqual(current.attachment().sessionId, old.sessionId);
  assert.deepEqual(position(current.attachment()), position(saved));
  assert.equal(h.room().vip.count(), 1);
  h.restartRoom({ keepSockets: true }); await h.room().ready;
  const restored = h.restartRoom({ keepSockets: true, server: 'vip1' }); await restored.ready;
  const durable = restored.sessions.row(uid);
  await livePacket(h, restored, first, { type: 'move', seq: 100, input: { x: 1, z: 0, jump: false } });
  await restored.webSocketClose(first.server); await h.settle();
  assert.deepEqual(restored.sessions.row(uid), durable);
  assert.equal(h.room().vip.count(), 1);
  await h.setTime(expiresAt);
  await livePacket(h, restored, current, { type: 'move', seq: 1, input: { x: 1, z: 0, jump: false } });
  assert.equal(current.client.closed, true);
  assert.deepEqual(restored.sessions.row(uid), durable);
  assert.equal(h.room().vip.count(), 0);
  const expired = await webhook(h, { ...payload, eventId: 'p9-vip-expired', version: 2, status: 'expired' });
  assert.equal(expired.status, 200);
  const reactivated = await activated(h, uid, { eventId: 'p9-vip-renewed', version: 3 });
  const renewed = await admitted(h, uid, { server: 'vip1', zone: undefined });
  const revoked = await webhook(h, { ...reactivated, eventId: 'p9-vip-revoked', version: 4, status: 'revoked' });
  assert.equal(revoked.status, 200);
  assert.equal(renewed.client.closed, true);
  assert.equal(h.room().vip.count(), 0);
  const oldReplay = await webhook(h, reactivated);
  assert.equal((await oldReplay.json()).replayed, true);
  assert.equal(h.room().vip.entitlement(uid).active, false, 'paid activation receipt replay cannot undo later revocation');
  const rejected = await h.connect({ uid, server: 'vip1' });
  assert.equal(rejected.messages('welcome').length, 0);
  const free = await admitted(h, uid, { zone: '4,4' });
  assert.equal(last(free, 'welcome').entitlements.vip1Expires, 0);
});

test('P9 actual staging concurrent VIP admission enforces 100 seats, rejects 101st and releases/rejoins safely', async t => {
  const h = fixture(t), users = Array.from({ length: 101 }, (_, index) => `p9-capacity-${index}`);
  await Promise.all(users.map(uid => activated(h, uid)));
  const admissions = await Promise.all(users.map(uid => h.connect({ uid, server: 'vip1' })));
  const accepted = admissions.filter(socket => last(socket, 'welcome'));
  const rejected = admissions.filter(socket => !last(socket, 'welcome'));
  assert.equal(accepted.length, 100);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].client.closed, true);
  assert.equal(h.room().vip.count(), 100);
  assert.equal(h.room('vip1').count(), 100);
  assert.equal(count(h.room(), 'voxel_vip_seats'), 100);
  const retryUid = users[admissions.indexOf(rejected[0])];
  const extra = await h.connect({ uid: retryUid, server: 'vip1' });
  assert.equal(extra.messages('welcome').length, 0);
  assert.equal(h.room().vip.count(), 100);
  const released = accepted[0], oldSeat = released.attachment();
  await released.close();
  assert.equal(h.room().vip.count(), 99);
  const rejoin = await admitted(h, retryUid, { server: 'vip1', zone: undefined });
  assert.equal(h.room().vip.count(), 100);
  await h.room('vip1').webSocketClose(released.server); await h.settle();
  assert.equal(h.room().vip.count(), 100, 'late old close cannot release another/current seat');
  assert.equal(h.room().vip.validate({ uid: oldSeat.uid, sessionId: oldSeat.sessionId }).ok, false);
  assert.equal(rejoin.client.readyState, 1);
  assert.equal(count(h.room(), 'voxel_vip_events'), 101);
  assert.equal(h.records.fetches.some(fetch => fetch.url === SLIP_URL), false);
});
