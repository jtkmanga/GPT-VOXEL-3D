'use strict';

// Execute the active Worker bundle, Firebase verifier and SQLite session store.
// Only identity fixtures, server clock and WebSocket transport are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

const last = (connection, type) => connection.messages(type).at(-1);

async function transfer(t, uid, delay = 0) {
  const h = createHarness();
  t.after(() => h.close());
  const source = await h.connect({ uid, zone: '4,4' });
  assert.ok(last(source, 'welcome'), 'The actual source authenticated');
  h.place(source, { x: -1, y: 0, z: -75, r: 0 });
  await h.advance(200);
  await h.moveTo(source, { x: 1, y: 0, z: -75, r: 0 });
  const ticket = last(source, 'zone_change');
  assert.ok(ticket?.handoffToken, 'The actual source issued a handoff ticket');
  assert.equal(ticket.expiresAt, h.now() + 12_000);
  const issuedAt = h.now();
  const sessionId = source.attachment().sessionId;
  const row = () => h.room().sql.exec('SELECT * FROM voxel_sessions WHERE uid=?', uid).toArray()[0];
  assert.equal(row().owner, 'zone:4,4');
  assert.equal(row().session_id, sessionId);
  await h.advance(delay);
  const target = await h.connect({ uid, zone: '5,4', handoffToken: ticket.handoffToken });
  return { h, uid, source, target, ticket, issuedAt, sessionId, row, anchor: ticket.position };
}

function assertSourceOwner(f) {
  assert.equal(f.source.client.readyState, 1, 'Source stays connected before successful target resume');
  assert.equal(f.row().owner, 'zone:4,4', 'Persisted ownership remains with the source');
  assert.equal(f.row().session_id, f.sessionId);
  assert.ok(f.row().lease_expires > f.h.now());
  assert.equal(f.target.instance.count(), 0, 'Provisional/failed target is not an active owner');
  assert.equal(f.source.instance.count(), 1);
  assert.equal(f.target.messages('handoff_resumed').length, 0, 'Unconfirmed target receives no resume ACK');
  assert.equal(f.h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_sessions WHERE uid=?', f.uid).toArray()[0].count, 1);
}

function assertTargetOwner(f, expectedPosition = f.anchor) {
  assert.equal(f.target.messages('handoff_resumed').length, 1, 'Successful resume emits exactly one ACK');
  assert.equal(f.target.client.readyState, 1);
  assert.equal(f.source.client.readyState, 3, 'Successful target resume closes the source');
  assert.equal(f.row().owner, 'zone:5,4');
  assert.equal(f.row().session_id, f.sessionId);
  assert.ok(f.row().lease_expires > f.h.now());
  assert.equal(f.source.instance.count(), 0);
  assert.equal(f.target.instance.count(), 1);
  assert.equal(f.target.attachment().handoffResume, null);
  for (const key of ['x', 'y', 'z', 'r']) assert.equal(f.row()[key], expectedPosition[key]);
  assert.equal(f.h.room().sql.exec('SELECT COUNT(*) AS count FROM voxel_sessions WHERE uid=?', f.uid).toArray()[0].count, 1);
}

test('fresh target has a full nine-second window; ACK commits one owner before source close', async t => {
  const f = await transfer(t, 'synthetic-window-fresh');
  assert.equal(last(f.target, 'welcome')?.handoff, true);
  assert.equal(f.target.attachment().handoffResume.deadline, f.h.now() + 9000);
  assertSourceOwner(f);
  const events = [];
  f.target.client.addEventListener('message', event => {
    if (JSON.parse(event.data).type !== 'handoff_resumed') return;
    events.push({ kind: 'ack', owner: f.row().owner, sourceReadyState: f.source.client.readyState });
  });
  f.source.client.addEventListener('close', () => {
    events.push({ kind: 'source-close', owner: f.row().owner, sourceReadyState: f.source.client.readyState });
  });
  await f.h.advance(8999);
  await f.target.send({ type: 'handoff_resume', ...f.anchor });
  assertTargetOwner(f);
  // Assert after observation: Worker send/close intentionally catch transport
  // errors, so an assertion thrown inside a socket callback could be swallowed.
  assert.deepEqual(events, [
    { kind: 'ack', owner: 'zone:5,4', sourceReadyState: 1 },
    { kind: 'source-close', owner: 'zone:5,4', sourceReadyState: 3 }
  ]);
  await f.source.close();
  assertTargetOwner(f);
});

test('fresh target fails closed at the exact nine-second boundary and ignores a late frame', async t => {
  const f = await transfer(t, 'synthetic-window-nine-second-expiry');
  await f.h.advance(9000);
  await f.target.send({ type: 'handoff_resume', ...f.anchor });
  assert.equal(f.target.client.closeInfo?.code, 1008);
  assert.equal(last(f.target, 'handoff_resume_error')?.message, 'Handoff resume window expired');
  assertSourceOwner(f);
  await f.target.instance.webSocketMessage(f.target.server, JSON.stringify({ type: 'handoff_resume', ...f.anchor }));
  await f.h.settle();
  assertSourceOwner(f);
});

test('delayed target is bounded by the original ticket expiry and fails closed at that boundary', async t => {
  const f = await transfer(t, 'synthetic-window-ticket-expiry', 4000);
  assert.equal(last(f.target, 'welcome')?.handoff, true);
  assert.equal(f.target.attachment().handoffResume.deadline, f.ticket.expiresAt);
  assert.ok(f.ticket.expiresAt < f.h.now() + 9000, 'Authentication does not extend the original transfer ticket');
  assertSourceOwner(f);
  await f.h.setTime(f.ticket.expiresAt);
  await f.target.send({ type: 'handoff_resume', ...f.anchor });
  assert.equal(f.target.client.closeInfo?.code, 1008);
  assert.equal(last(f.target, 'handoff_resume_error')?.message, 'Handoff resume window expired');
  assertSourceOwner(f);
});

test('delayed target may resume before its ticket expires, after nine seconds elapsed from creation', async t => {
  const f = await transfer(t, 'synthetic-window-delayed-valid', 4000);
  await f.h.setTime(f.ticket.expiresAt - 1);
  assert.ok(f.h.now() - f.issuedAt > 9000);
  await f.target.send({ type: 'handoff_resume', ...f.anchor });
  assertTargetOwner(f);
});

test('actual resume rejects client position authority and preserves the server anchor', async t => {
  const f = await transfer(t, 'synthetic-window-speed-envelope');
  await f.h.advance(100);
  await f.target.send({ type: 'handoff_resume', ...f.anchor, x: f.anchor.x + 4.36 });
  assert.equal(last(f.target, 'handoff_resume_error')?.message, 'Invalid handoff resume position');
  assertSourceOwner(f);
  await f.target.send({ type: 'handoff_resume', ...f.anchor, y: f.anchor.y + 1.91 });
  assert.equal(last(f.target, 'handoff_resume_error')?.message, 'Invalid handoff resume position');
  assert.equal(f.target.messages('handoff_resume_error').length, 2);
  assertSourceOwner(f);
  // Compatible nearby hints may be received, but neither coordinates nor
  // rotation may override the position recorded by the source server.
  await f.target.send({ type: 'handoff_resume', ...f.anchor, x: f.anchor.x + 0.2, y: f.anchor.y + 0.2, r: 1000 });
  assertTargetOwner(f);
  assert.notEqual(f.row().r, 1000);
});

test('ticket expired before target authentication never creates another owner or resume ACK', async t => {
  const f = await transfer(t, 'synthetic-window-expired-auth', 12_000);
  assert.equal(f.target.client.closeInfo?.code, 1008);
  assert.equal(last(f.target, 'handoff_error')?.message, 'Zone handoff expired or invalid');
  assert.equal(f.target.messages('welcome').length, 0);
  assertSourceOwner(f);
});
