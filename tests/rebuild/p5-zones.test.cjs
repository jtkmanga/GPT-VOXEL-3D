'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

// Actual Worker dispatch, RSA verification, SQLite ownership/economy and the
// shared physics kernel execute here. Only transport, credentials and clock
// are isolated fixtures; no routing, ownership or snapshot method is replaced.
const last = (socket, type) => socket.messages(type).at(-1);
const plain = value => JSON.parse(JSON.stringify(value));
const position = player => Object.fromEntries(['x', 'y', 'z', 'r'].map(axis => [axis, player[axis]]));
const boxState = box => Object.fromEntries(Object.entries(box).filter(([key]) => key !== 'serverNow'));
const zoneAt = ({ x, z }) => `${Math.min(9, Math.max(0, Math.floor((x + 750) / 150)))},${Math.min(9, Math.max(0, Math.floor((z + 750) / 150)))}`;
const owner = (h, uid) => h.room().sql.exec('SELECT * FROM voxel_sessions WHERE uid=?', uid).toArray()[0];
const score = (h, uid) => Number(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0]?.score || 0);

function harness(t) {
  const h = createHarness();
  t.after(() => h.close());
  return h;
}

async function authenticate(h, uid, zone, extra = {}) {
  const socket = await h.open(`/play?zone=${encodeURIComponent(zone)}`);
  await socket.send({ type: 'auth', protocol: 6, token: h.token(uid), ...extra });
  return socket;
}

async function admitted(h, uid, zone, extra = {}) {
  const socket = await authenticate(h, uid, zone, extra);
  assert.ok(last(socket, 'welcome'), 'the actual Firebase verifier admits the synthetic identity');
  assert.equal(socket.client.readyState, 1);
  return socket;
}

async function activeZones(h, zone) {
  const response = await h.room().fetch(new Request(`https://internal/_internal/active-zones${zone ? `?zone=${encodeURIComponent(zone)}` : ''}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  return body.zones;
}

async function cross(h, source, uid, targetX) {
  await h.advance(200);
  await h.moveTo(source, { x: targetX, y: 0, z: -75, r: 0 });
  const ticket = last(source, 'zone_change');
  assert.ok(ticket?.handoffToken, 'real server movement across the boundary issues a ticket');
  const target = await admitted(h, uid, ticket.zone, { handoffToken: ticket.handoffToken });
  assert.equal(target.instance.count(), 0, 'a provisional target has no active ownership');
  assert.equal(source.client.readyState, 1);
  await target.send({ type: 'handoff_resume', seq: source.attachment().motion.seq + 1 });
  assert.equal(target.messages('handoff_resumed').length, 1);
  assert.equal(source.client.readyState, 3);
  assert.equal(owner(h, uid).owner, `zone:${ticket.zone}`);
  assert.deepEqual(position(target.attachment()), plain(ticket.position));
  return { target, ticket };
}

test('P5 real boundary crossing transfers one durable owner and preserves player identity and server anchor', async t => {
  const h = harness(t), uid = 'synthetic-p5-crossing';
  const source = await admitted(h, uid, '4,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  const id = source.attachment().id, sessionId = source.attachment().sessionId;
  const { target } = await cross(h, source, uid, 1);
  assert.equal(target.attachment().id, id);
  assert.equal(owner(h, uid).session_id, sessionId);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_sessions WHERE uid=?', uid).toArray()[0].n, 1);
  assert.equal(h.zone('4,4').count() + h.zone('5,4').count(), 1);
  await source.close();
  assert.equal(owner(h, uid).owner, 'zone:5,4', 'late old close cannot release the successor');
});

test('P5 rapid alternating boundary crossings never create duplicate owners or reuse a ticket', async t => {
  const h = harness(t), uid = 'synthetic-p5-rapid-crossings';
  let socket = await admitted(h, uid, '4,4');
  h.place(socket, { x: -1, y: 0, z: -75, r: 0 });
  const id = socket.attachment().id, sessionId = socket.attachment().sessionId;
  const tickets = new Set();
  for (let index = 0; index < 6; index++) {
    const source = socket;
    const result = await cross(h, source, uid, index % 2 ? -1 : 1);
    socket = result.target;
    assert.equal(tickets.has(result.ticket.handoffToken), false);
    tickets.add(result.ticket.handoffToken);
    assert.equal(socket.attachment().id, id);
    assert.equal(owner(h, uid).session_id, sessionId);
    assert.equal(h.zone('4,4').count() + h.zone('5,4').count(), 1);
    assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_sessions WHERE uid=?', uid).toArray()[0].n, 1);
  }
});

test('P5 a dropped target ACK cannot restore source ownership or grant a consumed ticket twice', async t => {
  const h = harness(t), uid = 'synthetic-p5-dropped-ack';
  const source = await admitted(h, uid, '4,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  const sourceResume = last(source, 'welcome').session.resumeToken;
  const { target, ticket } = await cross(h, source, uid, 1);
  // Delivery loss hides the ACK from the simulated client, never from the
  // server's transaction: its committed owner must remain the target.
  target.client.inbox.length = 0;
  const oldReconnect = await authenticate(h, uid, '4,4', { resumeToken: sourceResume });
  assert.equal(oldReconnect.client.closeInfo?.code, 1008);
  assert.equal(oldReconnect.messages('welcome').length, 0);
  const replay = await authenticate(h, uid, '5,4', { handoffToken: ticket.handoffToken });
  assert.equal(replay.client.closeInfo?.code, 1008);
  assert.equal(replay.messages('welcome').length, 0);
  assert.equal(owner(h, uid).owner, 'zone:5,4');
  assert.equal(target.client.readyState, 1);
  assert.equal(h.zone('4,4').count() + h.zone('5,4').count(), 1);
});

test('P5 reconnect while a target is provisional fences its old grant and keeps a single owner', async t => {
  const h = harness(t), uid = 'synthetic-p5-reconnect-in-flight';
  const source = await admitted(h, uid, '4,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await h.moveTo(source, { x: 1, z: -75 });
  const ticket = last(source, 'zone_change');
  const provisional = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken });
  const resumeToken = source.attachment().resumeToken;
  assert.equal(owner(h, uid).owner, 'zone:4,4');
  await source.close();
  const replacement = await admitted(h, uid, '4,4', { resumeToken });
  assert.notEqual(replacement.attachment().sessionId, provisional.attachment().sessionId);
  await provisional.send({ type: 'handoff_resume' });
  assert.equal(provisional.client.closeInfo?.code, 1008);
  assert.equal(provisional.messages('handoff_resumed').length, 0);
  assert.equal(owner(h, uid).session_id, replacement.attachment().sessionId);
  assert.equal(h.zone('4,4').count() + h.zone('5,4').count(), 1);
});

test('P5 late target resume after cancellation stays fail closed and preserves the source', async t => {
  const h = harness(t), uid = 'synthetic-p5-cancel-late-resume';
  const source = await admitted(h, uid, '4,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await h.moveTo(source, { x: 1, z: -75 });
  const ticket = last(source, 'zone_change');
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken });
  await source.send({ type: 'handoff_cancel' });
  assert.ok(last(source, 'handoff_cancelled'));
  assert.equal(source.attachment().x, -1);
  await target.send({ type: 'handoff_resume' });
  assert.equal(target.client.closeInfo?.code, 1008);
  assert.equal(target.messages('handoff_resumed').length, 0);
  assert.equal(owner(h, uid).owner, 'zone:4,4');
  assert.equal(source.client.readyState, 1);
  assert.equal(h.zone('4,4').count() + h.zone('5,4').count(), 1);
});

test('P5 expired handoff cannot enter the active-zone routing set or duplicate ownership', async t => {
  const h = harness(t), uid = 'synthetic-p5-expired-handoff';
  const source = await admitted(h, uid, '4,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await h.moveTo(source, { x: 1, z: -75 });
  const ticket = last(source, 'zone_change');
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken });
  assert.deepEqual(await activeZones(h), ['4,4']);
  await h.setTime(ticket.expiresAt);
  await target.send({ type: 'handoff_resume' });
  assert.equal(target.client.closeInfo?.code, 1008);
  assert.equal(owner(h, uid).owner, 'zone:4,4');
  assert.deepEqual(await activeZones(h), ['4,4']);
});

test('P5 same-zone movement fans out only inside the unchanged 120-unit radius', async t => {
  const h = harness(t);
  const mover = await admitted(h, 'synthetic-p5-nearby-mover', '4,4');
  const near = await admitted(h, 'synthetic-p5-nearby-near', '4,4');
  const far = await admitted(h, 'synthetic-p5-nearby-far', '4,4');
  h.place(mover, { x: -145, y: 0, z: -75, r: 0 });
  h.place(near, { x: -135, y: 0, z: -75, r: 0 });
  h.place(far, { x: -5, y: 0, z: -75, r: 0 });
  for (const socket of [mover, near, far]) socket.clear();
  await h.advance(200);
  await h.moveTo(mover, { x: -144, z: -75 });
  assert.ok(near.messages('move').some(message => message.player.id === mover.attachment().id));
  assert.equal(far.messages('move').length, 0);
  assert.ok(last(mover, 'move')?.ack >= 0, 'self reconciliation still receives its authoritative ACK');
});

test('P5 same-zone peers receive one removal when an already visible player leaves proximity', async t => {
  const h = harness(t);
  const mover = await admitted(h, 'synthetic-p5-leave-mover', '4,4');
  const observer = await admitted(h, 'synthetic-p5-leave-observer', '4,4');
  h.place(mover, { x: -28, y: 0, z: -75, r: 0 });
  h.place(observer, { x: -147, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await h.moveTo(mover, { x: -27.5, z: -75 });
  assert.ok(observer.messages('move').some(message => message.player.id === mover.attachment().id));
  observer.clear();
  await h.advance(200);
  await h.moveTo(mover, { x: -25.5, z: -75 });
  assert.equal(observer.messages('move').length, 0);
  assert.equal(observer.messages('leave').filter(message => message.id === mover.attachment().id).length, 1);
  await h.advance(200);
  await h.moveTo(mover, { x: -24.5, z: -75 });
  assert.equal(observer.messages('leave').filter(message => message.id === mover.attachment().id).length, 1);
});

test('P5 diagonal proximity uses a circle and emits one entry and exit when intent crosses its edge', async t => {
  const h = harness(t);
  const mover = await admitted(h, 'synthetic-p5-diagonal-mover', '4,4');
  const observer = await admitted(h, 'synthetic-p5-diagonal-observer', '4,4');
  // Both players are inside the same 150-unit zone and are less than 120
  // apart on each axis. Their diagonal distance nevertheless starts >120.
  h.place(mover, { x: -61, y: 0, z: -61, r: 0 });
  h.place(observer, { x: -149, y: 0, z: -149, r: 0 });
  observer.clear();
  await h.advance(200);
  await h.moveTo(mover, { x: -62, z: -62 });
  assert.equal(observer.messages('move').length, 0);
  assert.equal(observer.messages('join').length, 0);
  await h.advance(500);
  await h.moveTo(mover, { x: -66, z: -66 });
  assert.ok(Math.hypot(mover.attachment().x - observer.attachment().x, mover.attachment().z - observer.attachment().z) < 120);
  assert.equal(observer.messages('join').filter(message => message.player.id === mover.attachment().id).length, 1);
  assert.ok(observer.messages('move').some(message => message.player.id === mover.attachment().id));
  observer.clear();
  await h.advance(500);
  await h.moveTo(mover, { x: -61, z: -61 });
  assert.ok(Math.hypot(mover.attachment().x - observer.attachment().x, mover.attachment().z - observer.attachment().z) > 120);
  assert.equal(observer.messages('move').length, 0);
  assert.equal(observer.messages('leave').filter(message => message.id === mover.attachment().id).length, 1);
});

test('P5 adjacent border snapshots expose nearby players and exclude distant observers', async t => {
  const h = harness(t);
  const source = await admitted(h, 'synthetic-p5-border-source', '4,4');
  const near = await admitted(h, 'synthetic-p5-border-near', '5,4');
  const far = await admitted(h, 'synthetic-p5-border-far', '5,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  h.place(near, { x: 1, y: 0, z: -75, r: 0 });
  h.place(far, { x: 145, y: 0, z: -75, r: 0 });
  near.clear(); far.clear();
  await h.advance(1);
  await source.instance.flushBorderSnapshot(true);
  await h.settle();
  const nearGhost = near.messages('ghost_snapshot').find(message => message.zone === '4,4');
  const farGhost = far.messages('ghost_snapshot').find(message => message.zone === '4,4');
  assert.ok(nearGhost?.players.some(player => player.id === source.attachment().id));
  // An unchanged empty projection is a suppressed delta. A far recipient
  // never receives the source player, whether it needs an empty update or not.
  assert.equal(Boolean(farGhost?.players.some(player => player.id === source.attachment().id)), false);
  assert.equal(far.messages('ghost_snapshot').length, 0);
});

test('P5 observer motion updates cached border visibility without unnecessary source snapshot RPCs', async t => {
  const h = harness(t);
  const source = await admitted(h, 'synthetic-p5-cache-source', '4,4');
  const observer = await admitted(h, 'synthetic-p5-cache-observer', '5,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  h.place(observer, { x: 117, y: 0, z: -75, r: 0 });
  await h.advance(1);
  await source.instance.flushBorderSnapshot(true);
  await h.settle();
  assert.ok(last(observer, 'ghost_snapshot').players.some(player => player.id === source.attachment().id));
  observer.clear(); h.records.routes.length = 0;
  await h.advance(200);
  await h.moveTo(observer, { x: 120, z: -75 });
  const removed = observer.messages('ghost_snapshot').find(message => message.zone === '4,4');
  assert.ok(removed, 'observer movement must update its cached subscription');
  assert.equal(removed.players.some(player => player.id === source.attachment().id), false);
  assert.equal(h.records.routes.filter(route => route.name === 'free-zone-4,4' && route.path === '/_internal/border-state').length, 0);
  observer.clear();
  await h.advance(500);
  await h.moveTo(observer, { x: 117, z: -75 });
  assert.ok(observer.messages('ghost_snapshot').some(message => message.zone === '4,4' && message.players.some(player => player.id === source.attachment().id)));
});

test('P5 source snapshots prune players outside the recipient zone bounds before inter-zone delivery', async t => {
  const h = harness(t);
  const near = await admitted(h, 'synthetic-p5-payload-near', '4,4');
  const far = await admitted(h, 'synthetic-p5-payload-far', '4,4');
  const receiver = await admitted(h, 'synthetic-p5-payload-receiver', '5,4');
  h.place(near, { x: -1, y: 0, z: -75, r: 0 });
  h.place(far, { x: -145, y: 0, z: -75, r: 0 });
  h.place(receiver, { x: 1, y: 0, z: -75, r: 0 });
  await h.advance(1);
  await near.instance.flushBorderSnapshot(true);
  const stored = receiver.instance.ctx.storage.sql.exec('SELECT * FROM voxel_border_snapshots WHERE source_zone=?', '4,4').toArray()[0];
  const payload = JSON.parse(stored.players);
  assert.ok(payload.some(player => player.id === near.attachment().id));
  assert.equal(payload.some(player => player.id === far.attachment().id), false);
  assert.equal(payload.length, 1, 'inter-zone workload includes only reachable source entities');
  assert.ok(stored.revision > 0);
  assert.equal(stored.server_now, h.now());
});

test('P5 unchanged ghost projections suppress redundant deltas while changed snapshots use current server time', async t => {
  const h = harness(t);
  const source = await admitted(h, 'synthetic-p5-delta-source', '4,4');
  const observer = await admitted(h, 'synthetic-p5-delta-observer', '5,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  h.place(observer, { x: 1, y: 0, z: -75, r: 0 });
  await h.advance(1);
  await source.instance.flushBorderSnapshot(true);
  assert.ok(last(observer, 'ghost_snapshot').players.some(player => player.id === source.attachment().id));
  observer.clear();
  await h.advance(100);
  await source.instance.flushBorderSnapshot(true);
  assert.equal(observer.messages('ghost_snapshot').length, 0, 'timestamp-only changes do not duplicate entity projections');
  await h.advance(200);
  await h.moveTo(source, { x: -2, z: -75 });
  await source.instance.flushBorderSnapshot(true);
  const changed = last(observer, 'ghost_snapshot');
  assert.ok(changed.players.some(player => player.id === source.attachment().id && Math.abs(player.x + 2) < 1e-9));
  assert.equal(changed.serverNow, h.now(), 'cached source timestamps must not rewind client economy timers');
});

test('P5 stale cached projections expire fail closed and recover only from a fresh authoritative snapshot', async t => {
  const h = harness(t);
  const source = await admitted(h, 'synthetic-p5-cache-expiry-source', '4,4');
  const observer = await admitted(h, 'synthetic-p5-cache-expiry-observer', '5,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  h.place(observer, { x: 1, y: 0, z: -75, r: 0 });
  await h.advance(1);
  await source.instance.flushBorderSnapshot(true);
  assert.ok(last(observer, 'ghost_snapshot').players.some(player => player.id === source.attachment().id));
  observer.clear();
  const { BORDER_SNAPSHOT_INTERVAL_MS } = require('../../src/shared/config.mjs');
  await h.advance(4 * BORDER_SNAPSHOT_INTERVAL_MS + 1);
  await observer.send({ type: 'move', input: { x: 0, z: 0, jump: false }, seq: 0 });
  const expired = observer.messages('ghost_snapshot').find(message => message.zone === '4,4');
  assert.ok(expired);
  assert.equal(expired.players.some(player => player.id === source.attachment().id), false);
  assert.equal(expired.serverNow, h.now());
  assert.equal(owner(h, source.attachment().uid).owner, 'zone:4,4', 'cache expiry changes no ownership');
  observer.clear();
  await source.instance.flushBorderSnapshot(true);
  assert.ok(last(observer, 'ghost_snapshot').players.some(player => player.id === source.attachment().id));
});

test('P5 stale border snapshots cannot restore an old player after a newer departure snapshot', async t => {
  const h = harness(t);
  const source = await admitted(h, 'synthetic-p5-stale-source', '4,4');
  const observer = await admitted(h, 'synthetic-p5-stale-observer', '5,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  h.place(observer, { x: 1, y: 0, z: -75, r: 0 });
  await h.advance(1);
  await source.instance.flushBorderSnapshot(true);
  assert.ok(last(observer, 'ghost_snapshot').players.some(player => player.id === source.attachment().id));
  const oldSnapshot = source.instance.visibility.snapshot();
  await h.advance(1);
  await source.close();
  assert.equal(last(observer, 'ghost_snapshot').players.some(player => player.id === source.attachment().id), false);
  observer.clear();
  const response = await observer.instance.fetch(new Request('https://zone.internal/_internal/border-snapshot', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(oldSnapshot)
  }));
  assert.ok(response.status >= 200 && response.status < 300);
  assert.equal(observer.messages('ghost_snapshot').some(message => message.players.some(player => player.id === source.attachment().id)), false);
});

test('P5 a real checkpoint RPC cannot overwrite a newer incoming ghost projection', async t => {
  const h = harness(t);
  const source = await admitted(h, 'synthetic-p5-race-source', '4,4');
  const observer = await admitted(h, 'synthetic-p5-race-observer', '5,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  h.place(observer, { x: 1, y: 0, z: -75, r: 0 });
  await h.advance(1);
  await source.instance.flushBorderSnapshot(true);
  assert.ok(last(observer, 'ghost_snapshot').players.some(player => player.id === source.attachment().id));

  let release, entered;
  const delivery = new Promise(resolve => { release = resolve; });
  const held = new Promise(resolve => { entered = resolve; });
  const getByName = h.env.ROOM.getByName.bind(h.env.ROOM);
  let intercepted = false;
  // Pause one real internal request at its transport boundary. It still
  // reaches the actual SQL coordinator and returns its unmodified result.
  h.env.ROOM.getByName = name => {
    const stub = getByName(name);
    return { async fetch(request) {
      if (!intercepted && new URL(request.url).pathname === '/_internal/session/checkpoint' &&
          (await request.clone().json()).uid === observer.attachment().uid) {
        intercepted = true;
        entered();
        await delivery;
      }
      return stub.fetch(request);
    } };
  };
  await h.advance(200);
  const movement = observer.instance.webSocketMessage(observer.server,
    JSON.stringify({ type: 'move', input: { x: 0, z: 0, jump: false }, seq: 0 }));
  await held;
  observer.clear();
  await source.instance.flushBorderSnapshot(true, source.server);
  assert.equal(last(observer, 'ghost_snapshot').players.some(player => player.id === source.attachment().id), false);
  assert.equal(observer.attachment().ghostViews['4,4'], '[]');
  release();
  await movement;
  await h.settle();
  assert.equal(observer.attachment().ghostViews['4,4'], '[]', 'the latest serialized projection survives the awaited checkpoint');
  observer.clear();
  await source.instance.flushBorderSnapshot(true);
  assert.ok(last(observer, 'ghost_snapshot').players.some(player => player.id === source.attachment().id));
  assert.equal(owner(h, observer.attachment().uid).owner, 'zone:5,4');
});

test('P5 target resume refreshes economy changed after provisional welcome before ownership ACK', async t => {
  const h = harness(t), uid = 'synthetic-p5-world-gap';
  const source = await admitted(h, uid, '4,4');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await h.moveTo(source, { x: 1, z: -75 });
  const ticket = last(source, 'zone_change');
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken });
  const provisional = plain(last(target, 'welcome'));
  assert.equal(target.instance.count(), 0);
  const collector = await h.open('/play');
  await collector.send({ type: 'auth', protocol: 4, token: h.token('synthetic-p5-world-gap-collector') });
  assert.ok(last(collector, 'welcome'));
  const coin = h.room().coinSnapshot()[0];
  h.place(collector, { x: coin.x, y: 0, z: coin.z, r: 0 });
  await collector.send({ type: 'collect', id: coin.id, requestId: 'synthetic-p5-world-gap-coin' });
  const box = h.room().boxSnapshot();
  h.place(collector, { x: box.x, y: 0, z: box.z, r: 0 });
  await collector.send({ type: 'collect_box', requestId: 'synthetic-p5-world-gap-box' });
  assert.ok(last(collector, 'box_spin_ready'));
  await collector.send({ type: 'spin_box', requestId: 'synthetic-p5-world-gap-spin' });
  assert.ok(last(collector, 'box_reward'));
  assert.notEqual(h.room().coinSnapshot()[coin.id].cycle, provisional.coins[coin.id].cycle);
  assert.notEqual(h.room().boxSnapshot().cycle, provisional.luckyBox.cycle);
  target.clear();
  await target.send({ type: 'handoff_resume' });
  const messages = target.messages(), ackIndex = messages.findIndex(message => message.type === 'handoff_resumed');
  assert.ok(ackIndex >= 0);
  for (const type of ['coin_state', 'box_state', 'score', 'leaderboard'])
    assert.ok(messages.findIndex(message => message.type === type) >= 0 && messages.findIndex(message => message.type === type) < ackIndex,
      `${type} must refresh before target gameplay acknowledges ownership`);
  const refreshed = last(target, 'coin_state');
  assert.equal(refreshed.coins.length, 200);
  assert.deepEqual(refreshed.coins, plain(h.room().coinSnapshot()));
  assert.deepEqual(boxState(last(target, 'box_state').box), boxState(plain(h.room().boxSnapshot())));
  assert.equal(last(target, 'score').score, score(h, uid));
  assert.deepEqual(last(target, 'leaderboard').top, plain(h.room().top()));
  assert.ok(last(target, 'leaderboard').top.some(row => row.score > 1));
  assert.equal(refreshed.serverNow, h.now());
  assert.deepEqual(position(target.attachment()), plain(ticket.position));
  assert.equal(source.client.readyState, 3);
  assert.equal(owner(h, uid).owner, 'zone:5,4');
  assert.equal(h.zone('4,4').count() + h.zone('5,4').count(), 1);
});

test('P5 failed post-transfer world snapshot cannot ACK gameplay or restore a late source owner', async t => {
  const h = harness(t), uid = 'synthetic-p5-world-refresh-failure';
  const source = await admitted(h, uid, '4,4');
  const oldResume = source.attachment().resumeToken;
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await h.moveTo(source, { x: 1, z: -75 });
  const ticket = last(source, 'zone_change');
  const target = await admitted(h, uid, '5,4', { handoffToken: ticket.handoffToken });
  target.clear();
  // Actual SQLite query failure reaches the real private world-state handler;
  // it must neither return a fabricated snapshot nor authorize its target.
  h.room().sql.exec('ALTER TABLE voxel_coins RENAME TO synthetic_p5_unavailable_coins');
  await target.send({ type: 'handoff_resume' });
  assert.equal(target.client.closeInfo?.code, 1011);
  assert.equal(target.messages('handoff_resumed').length, 0);
  assert.equal(target.messages('coin_state').length, 0);
  assert.equal(target.instance.count(), 0);
  assert.equal(owner(h, uid).owner, 'zone:5,4');
  assert.equal(owner(h, uid).lease_expires, 0, 'the failed committed target releases its live lease');
  assert.equal(source.client.closeInfo?.code, 1008);
  await source.instance.webSocketMessage(source.server, JSON.stringify({ type: 'handoff_cancel' }));
  await h.settle();
  assert.equal(source.messages('handoff_cancelled').length, 0);
  assert.equal(owner(h, uid).owner, 'zone:5,4');
  assert.equal(h.zone('4,4').count() + h.zone('5,4').count(), 0);
  h.room().sql.exec('ALTER TABLE synthetic_p5_unavailable_coins RENAME TO voxel_coins');
  const staleReconnect = await authenticate(h, uid, '4,4', { resumeToken: oldResume });
  assert.equal(staleReconnect.client.closeInfo?.code, 1008);
  assert.equal(staleReconnect.messages('welcome').length, 0);
  assert.equal(owner(h, uid).owner, 'zone:5,4');
});

test('P5 nonadjacent or oversized border sources cannot inject ghost players', async t => {
  const h = harness(t);
  const observer = await admitted(h, 'synthetic-p5-invalid-border', '5,4');
  observer.clear();
  const player = { id: 'synthetic-injected-ghost', x: 90, y: 0, z: -75, r: 0, name: 'Synthetic' };
  for (const [sourceZone, players, status] of [['0,0', [player], 403], ['4,4', Array.from({ length: 141 }, () => player), 413]]) {
    const response = await observer.instance.fetch(new Request('https://zone.internal/_internal/border-snapshot', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceZone, players, serverNow: h.now() })
    }));
    assert.equal(response.status, status);
  }
  assert.equal(observer.messages('ghost_snapshot').length, 0);
});

test('P5 initial admission and an economy broadcast never instantiate unused zones', async t => {
  const h = harness(t), uid = 'synthetic-p5-bounded-fanout';
  const player = await admitted(h, uid, '4,4');
  assert.deepEqual([...new Set(h.records.routes.filter(route => route.binding === 'ZONE').map(route => route.name))], ['free-zone-4,4']);
  h.records.routes.length = 0;
  const coin = h.room().coinSnapshot()[0];
  h.place(player, { x: coin.x, y: 0, z: coin.z, r: 0 });
  await player.send({ type: 'collect', id: coin.id, requestId: 'synthetic-p5-bounded-claim' });
  assert.equal(score(h, uid), 1);
  const destinations = [...new Set(h.records.routes.filter(route => route.binding === 'ZONE').map(route => route.name))];
  assert.ok(destinations.length <= 1);
  assert.ok(destinations.every(name => name === 'free-zone-4,4'));
  assert.equal(h.room().coinSnapshot().length, 200);
});

test('P5 active routing derives ownership from durable sessions and survives coordinator restart', async t => {
  const h = harness(t);
  const a = await admitted(h, 'synthetic-p5-registry-a', '4,4');
  await admitted(h, 'synthetic-p5-registry-b', '4,4');
  const b = await admitted(h, 'synthetic-p5-registry-c', '5,4');
  await admitted(h, 'synthetic-p5-registry-d', '9,9');
  assert.deepEqual((await activeZones(h)).sort(), ['4,4', '5,4', '9,9']);
  assert.deepEqual(await activeZones(h, '4,4'), ['5,4']);
  h.restartRoom();
  await h.settle();
  assert.deepEqual((await activeZones(h)).sort(), ['4,4', '5,4', '9,9']);
  assert.equal(owner(h, a.attachment().uid).owner, 'zone:4,4');
  await b.close();
  assert.deepEqual((await activeZones(h)).sort(), ['4,4', '9,9']);
});

test('P5 an expired durable lease is removed from fanout without creating a parallel registry authority', async t => {
  const h = harness(t);
  const socket = await admitted(h, 'synthetic-p5-lease-expiry', '4,4');
  const deadline = owner(h, socket.attachment().uid).lease_expires;
  assert.deepEqual(await activeZones(h), ['4,4']);
  await h.setTime(deadline);
  assert.deepEqual(await activeZones(h), []);
  h.records.routes.length = 0;
  await h.room().sendAllZones({ type: 'leaderboard', top: [] });
  assert.equal(h.records.routes.filter(route => route.binding === 'ZONE').length, 0);
});

test('P5 mixed live and expired leases cannot revive an idle player through count or border visibility', async t => {
  const h = harness(t);
  const expired = await admitted(h, 'synthetic-p5-mixed-expired', '4,4');
  h.place(expired, { x: -5, y: 0, z: -75, r: 0 });
  await h.setTime(owner(h, expired.attachment().uid).lease_expires);
  const live = await admitted(h, 'synthetic-p5-mixed-live', '4,4');
  const receiver = await admitted(h, 'synthetic-p5-mixed-receiver', '5,4');
  h.place(live, { x: -10, y: 0, z: -75, r: 0 });
  h.place(receiver, { x: 5, y: 0, z: -75, r: 0 });
  assert.equal(live.instance.count(), 1);
  assert.equal(last(live, 'welcome').players.some(player => player.id === expired.attachment().id), false);
  const state = await live.instance.fetch(new Request('https://zone.internal/_internal/border-state?destination=5%2C4'));
  const snapshot = await state.json();
  assert.equal(snapshot.players.some(player => player.id === expired.attachment().id), false);
  receiver.clear();
  await h.advance(1);
  await live.instance.flushBorderSnapshot(true);
  const ghosts = receiver.messages('ghost_snapshot');
  assert.ok(ghosts.some(message => message.players.some(player => player.id === live.attachment().id)));
  assert.equal(ghosts.some(message => message.players.some(player => player.id === expired.attachment().id)), false);
  await expired.send({ type: 'move', input: { x: 0, z: 0, jump: false }, seq: 0 });
  assert.equal(expired.client.closeInfo?.code, 1008);
  assert.equal(owner(h, live.attachment().uid).owner, 'zone:4,4');
});

test('P5 active-zone discovery fails closed when its authoritative ownership query fails', async t => {
  const h = harness(t);
  await admitted(h, 'synthetic-p5-registry-failure', '4,4');
  h.room().sql.exec('ALTER TABLE voxel_sessions RENAME TO synthetic_p5_unavailable_sessions');
  const response = await h.room().fetch(new Request('https://internal/_internal/active-zones?zone=4,4'));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(JSON.stringify(body).includes('voxel_sessions'), false, 'internal SQL details must not leak');
  h.records.routes.length = 0;
  await assert.rejects(() => h.room().sendAllZones({ type: 'leaderboard', top: [] }));
  assert.equal(h.records.routes.filter(route => route.binding === 'ZONE').length, 0);
});

test('P5 logical economy and seeded map remain shared across active zones and handoff', async t => {
  const h = harness(t), uid = 'synthetic-p5-world-continuity';
  const source = await admitted(h, uid, '4,4');
  const distant = await admitted(h, 'synthetic-p5-world-distant', '9,9');
  const baseline = plain(last(source, 'welcome'));
  assert.equal(baseline.coins.length, 200);
  assert.equal(new Set(baseline.coins.map(coin => coin.id)).size, 200);
  assert.deepEqual(last(distant, 'welcome').coins, baseline.coins);
  assert.deepEqual(boxState(last(distant, 'welcome').luckyBox), boxState(baseline.luckyBox));
  assert.equal(last(distant, 'welcome').luckyBox.serverNow, h.now());
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  const { target } = await cross(h, source, uid, 1);
  assert.deepEqual(last(target, 'welcome').coins, baseline.coins);
  assert.deepEqual(boxState(last(target, 'welcome').luckyBox), boxState(baseline.luckyBox));
  assert.equal(last(target, 'welcome').luckyBox.serverNow, h.now());
  // P4 stores only changed cooldown/cycle rows; canonical COINS supplies the
  // untouched identities. Handoff cannot materialize or duplicate resources.
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_coins').toArray()[0].n, 0);
  assert.equal(h.room().coinSnapshot().length, 200);
  assert.equal(new Set(h.room().coinSnapshot().map(coin => coin.id)).size, 200);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_lucky_box').toArray()[0].n, 1);
  for (const zone of ['4,4', '5,4', '9,9']) {
    assert.deepEqual(h.zone(zone).ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('voxel_coins','voxel_lucky_box','voxel_scores')").toArray(), []);
  }
  const { SERVER_WORLD, COINS } = require('../../src/worker/world.mjs');
  const { MOVEMENT } = require('../../src/shared/movement.mjs');
  const { SERVER_MAP_SIZE } = require('../../src/shared/config.mjs');
  assert.ok(SERVER_WORLD.buildings.length > 0 && SERVER_WORLD.trees.length > 0);
  assert.equal(COINS.length, 200);
  assert.equal(MOVEMENT.bounds, SERVER_MAP_SIZE / 2 - 2);
  for (const [x, z] of COINS) assert.ok(zoneAt({ x, z }).match(/^\d,\d$/));
});

test('P5 distinct active zones receive one global reward result without per-zone resource duplication', async t => {
  const h = harness(t);
  const coin = h.room().coinSnapshot()[1], zone = zoneAt(coin);
  const collector = await admitted(h, 'synthetic-p5-global-collector', zone);
  const distant = await admitted(h, 'synthetic-p5-global-observer', zone === '9,9' ? '0,0' : '9,9');
  h.place(collector, { x: coin.x, y: 0, z: coin.z, r: 0 });
  collector.clear(); distant.clear(); h.records.routes.length = 0;
  await collector.send({ type: 'collect', id: coin.id, requestId: 'synthetic-p5-global-resource' });
  assert.equal(score(h, 'synthetic-p5-global-collector'), 1);
  assert.equal(h.room().coinSnapshot().length, 200);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_economy_actions WHERE uid=?', 'synthetic-p5-global-collector').toArray()[0].n, 1);
  assert.ok(distant.messages('leaderboard').some(message => message.top.some(row => row.score === 1)));
  assert.equal(distant.messages('coin_collected').length, 0, 'distant resource removals have no unnecessary proximity fanout');
  const routed = h.records.routes.filter(route => route.binding === 'ZONE' && route.path === '/_internal/world-event');
  assert.ok(routed.every(route => [`free-zone-${zone}`, `free-zone-${distant.attachment().zoneId}`].includes(route.name)));
});
