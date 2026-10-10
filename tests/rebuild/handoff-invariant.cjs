'use strict';

// Observable CLIENT handoff lifecycle. This executes active browser functions,
// including their real ACK waiter, error handling, socket identity filter and
// final movement override. It makes no claim of backend owner-epoch enforcement.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const acorn = require('acorn');

const html = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
const source = scripts.at(-1)?.[1];
assert.ok(source, 'Active client JavaScript exists');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
function declaration(name) {
  const node = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node, `Actual client function ${name} exists`);
  return source.slice(node.start, node.end);
}
const movement = ast.body.find(n => n.type === 'ExpressionStatement' &&
  n.expression.type === 'AssignmentExpression' && n.expression.left.type === 'Identifier' &&
  n.expression.left.name === 'syncMyPlayerData');
assert.ok(movement, 'Actual secure movement override exists');
const executable = [
  'secureNormalizeZoneId', 'secureZoneFromPosition', 'secureZoneSocketUrl',
  'secureRememberStablePosition', 'secureCloseSocket', 'secureNormalizeLeaderboard',
  'secureHandleSocketMessage', 'secureOpenZoneSocket', 'secureWaitForHandoffResumeAck',
  'secureResumeHandoffOnTarget', 'secureBeginZoneHandoff', 'secureReturnToMenu'
].map(declaration).join('\n') + '\n' + source.slice(movement.start, movement.end);

async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
function fixture() {
  let now = 1_000_000, timerId = 0;
  const timers = new Map(), events = [], sockets = [];
  function record(kind, socket, packet) { events.push({ kind, socket: socket?.label, packet }); }
  class Socket {
    static OPEN = 1;
    constructor(url) {
      assert.equal(new URL(url).hostname, '127.0.0.1', 'Only virtual loopback socket allowed');
      this.url = url; this.label = sockets.length ? `target-${sockets.length}` : 'source';
      this.readyState = 0; sockets.push(this); record('created', this);
    }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(packet) { record('receive', this, packet); this.onmessage?.({ data: JSON.stringify(packet) }); }
    send(raw) { assert.equal(this.readyState, 1); record('send', this, JSON.parse(raw)); }
    close(code, reason) { this.readyState = 3; record('close', this, { code, reason }); this.onclose?.({ code, reason }); }
  }
  const old = new Socket('ws://127.0.0.1/play?zone=4%2C4'); old.readyState = 1;
  const playerPos = { x: 1, y: 0, z: -75, set(x, y, z) { Object.assign(this, { x, y, z }); } };
  const c = vm.createContext({
    WebSocket: Socket, Date: { now: () => now }, console: { warn() {}, error() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, requestAnimationFrame(callback) { callback(); },
    auth: { currentUser: { async getIdToken() { return 'synthetic-client-handoff-token'; } } },
    state: { isPlaying: true, isPaused: false, playerName: 'Baseline' },
    MAP_SIZE: 1500, SECURE_ZONE_GRID_SIZE: 10, SECURE_ZONE_SIZE: 150,
    SECURE_WORKER_WS_BASE: 'ws://127.0.0.1/play', secureNow: () => now,
    secureGameSocket: old, secureGameReady: true, secureCurrentZoneId: '4,4',
    secureHandoffInProgress: false, secureLastMoveSentAt: 0,
    secureLastStablePosition: { x: -1, y: 0, z: -75, r: 0 },
    secureHandoffResumeTimer: null, secureHandoffResumeResolve: null, secureHandoffResumeReject: null,
    secureIntentionalSockets: new WeakSet(), playerPos, playerRotation: 0, playerVel: { x: 2, z: 0 }, playerGroup: null,
    updateScoreDisplay() {}, secureSetServerNow() {}, secureDropRemoteSource() {}, secureClearRemoteState() {},
    secureApplyCoinSnapshot() {}, secureApplyLuckyBoxState() {}, updateLeaderboardUI() {},
    alert(message) { record('alert', null, message); },
    document: { getElementById() { return { classList: { add() {}, remove() {} } }; } }
  });
  vm.runInContext(executable, c, { filename: 'active-client-handoff.js' });
  const message = { from: '4,4', zone: '5,4', handoffToken: 'synthetic-one-use-ticket', expiresAt: now + 12000 };
  function sent(socket, type) { return events.filter(e => e.kind === 'send' && e.socket === socket.label && (!type || e.packet.type === type)); }
  async function begin({ confirmed = true } = {}) {
    const operation = c.secureBeginZoneHandoff(message);
    await flush();
    const target = sockets[1]; assert.ok(target, 'A target connection was created');
    target.open();
    assert.equal(sent(target, 'auth').length, 1);
    target.receive({ type: 'welcome', handoff: confirmed, zone: '5,4', id: 'same-player', players: [], coins: [], leaderboard: [] });
    await flush();
    return { operation, target };
  }
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const next = [...timers].filter(([, t]) => t.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      const [id, t] = next; timers.delete(id); now = t.due; t.callback(); await flush();
    }
    now = end; await flush();
  }
  function assertSourceRecovered(target) {
    assert.equal(target.readyState, 3, 'Unconfirmed target is closed');
    assert.equal(old.readyState, 1, 'Source remains usable');
    assert.equal(c.secureGameSocket, old, 'Only the source is selected for gameplay');
    assert.equal(c.secureCurrentZoneId, '4,4');
    assert.equal(c.secureHandoffInProgress, false);
    assert.equal(c.secureHandoffResumeResolve, null);
    assert.equal(c.secureHandoffResumeReject, null);
    assert.equal(sent(target, 'move').length, 0, 'Unconfirmed target never sends normal movement');
    assert.ok(sent(old, 'move').length > 0, 'Movement resumes through source');
    const closedAt = events.findIndex(e => e.kind === 'close' && e.socket === target.label);
    const movedAt = events.findIndex(e => e.kind === 'send' && e.socket === old.label && e.packet.type === 'move');
    assert.ok(closedAt >= 0 && movedAt > closedAt, 'Target closes before source gameplay resumes');
  }
  return { c, old, sockets, events, message, sent, begin, advance, assertSourceRecovered };
}

test('source stays open and movement is suppressed until real target resume ACK; duplicate starts do not open another target', async () => {
  const f = fixture();
  const { operation, target } = await f.begin();
  assert.equal(f.old.readyState, 1);
  assert.equal(f.c.secureHandoffInProgress, true);
  assert.equal(f.c.state.isPaused, false, 'Handoff keeps local rendering unpaused');
  assert.equal(f.sent(target, 'handoff_resume').length, 1, 'Actual helper requests resume');
  f.c.syncMyPlayerData(true);
  assert.equal(f.sent(f.old, 'move').length, 0);
  assert.equal(f.sent(target, 'move').length, 0);
  await f.c.secureBeginZoneHandoff(f.message);
  assert.equal(f.sockets.length, 2, 'Reentrant handoff creates no duplicate target');
  target.receive({ type: 'handoff_resumed', x: 1, y: 0, z: -75, r: 0, zone: '5,4' });
  await operation;
  assert.equal(f.old.readyState, 3, 'Source closes after successful ACK');
  assert.equal(target.readyState, 1); assert.equal(f.c.secureGameSocket, target);
  assert.equal(f.c.secureCurrentZoneId, '5,4'); assert.equal(f.c.state.isPlaying, true);
  assert.equal(f.c.secureHandoffInProgress, false);
  const ackAt = f.events.findIndex(e => e.kind === 'receive' && e.packet.type === 'handoff_resumed');
  const closeAt = f.events.findIndex(e => e.kind === 'close' && e.socket === f.old.label);
  const moveAt = f.events.findIndex(e => e.kind === 'send' && e.socket === target.label && e.packet.type === 'move');
  assert.ok(ackAt >= 0 && closeAt > ackAt && moveAt > closeAt, 'ACK → close source → target movement');
  assert.equal(f.sent(f.old, 'move').length, 0, 'Completed handoff has no duplicate client gameplay sender');
});

test('target resume rejection closes target before restoring source and stable position', async () => {
  const f = fixture(); const { operation, target } = await f.begin();
  target.receive({ type: 'handoff_resume_error', message: 'synthetic rejection', retryable: false });
  await operation; f.assertSourceRecovered(target);
  assert.equal(f.c.playerPos.x, -1); assert.equal(f.c.playerPos.z, -75);
  assert.equal(f.c.playerVel.x, 0); assert.equal(f.c.playerVel.z, 0);
});

test('ACK timeout fails closed and a late ACK on the inactive target cannot regain client ownership', async () => {
  const f = fixture(); const { operation, target } = await f.begin();
  await f.advance(3200); await operation; f.assertSourceRecovered(target);
  const before = f.sent(target, 'move').length;
  target.receive({ type: 'handoff_resumed', zone: '5,4' });
  await flush(); f.c.syncMyPlayerData(true);
  assert.equal(f.c.secureGameSocket, f.old); assert.equal(f.c.secureCurrentZoneId, '4,4');
  assert.equal(f.sent(target, 'move').length, before);
  assert.equal(f.old.readyState, 1);
});

test('welcome without handoff confirmation rolls back before unconfirmed target gameplay', async () => {
  const f = fixture(); const { operation, target } = await f.begin({ confirmed: false });
  await operation; f.assertSourceRecovered(target);
  assert.equal(f.sent(target, 'handoff_resume').length, 0);
});

test('resume failure with unavailable source closes target and disables gameplay', async () => {
  const f = fixture(); const { operation, target } = await f.begin();
  f.old.readyState = 3;
  target.receive({ type: 'handoff_resume_error', retryable: false });
  await operation;
  assert.equal(target.readyState, 3); assert.equal(f.c.state.isPlaying, false);
  assert.equal(f.c.secureGameReady, false); assert.equal(f.c.secureCurrentZoneId, null);
  f.c.syncMyPlayerData(true);
  assert.equal(f.sent(target, 'move').length, 0); assert.equal(f.sent(f.old, 'move').length, 0);
});

test('stepping back to source cancels target before source gameplay resumes', async () => {
  const f = fixture(); f.c.playerPos.x = -1;
  const { operation, target } = await f.begin(); await operation;
  f.assertSourceRecovered(target);
  assert.equal(f.sent(target, 'handoff_resume').length, 0);
  assert.equal(f.sent(f.old, 'handoff_cancel').length, 1);
});

test('invalid or expired transfer creates no target and preserves source', async () => {
  const f = fixture();
  for (const message of [{ ...f.message, expiresAt: 1 }, { ...f.message, handoffToken: '' }, { ...f.message, zone: '99,99' }]) {
    await f.c.secureBeginZoneHandoff(message);
    assert.equal(f.sockets.length, 1); assert.equal(f.c.secureGameSocket, f.old);
    assert.equal(f.old.readyState, 1); assert.equal(f.c.secureHandoffInProgress, false);
  }
});
