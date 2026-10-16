'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');

const clientRoot = path.resolve(__dirname, '../../src/client');
const modules = ['auth-state.js', 'firebase-multiplayer.js', 'menu-shop.js',
  'secure-entitlements-payment.js', 'secure-snapshots.js',
  'secure-socket-handoff.js', 'secure-menu-economy.js'];
const files = new Map(modules.map(name => {
  const source = fs.readFileSync(path.join(clientRoot, name), 'utf8');
  return [name, { source, ast: acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' }) }];
}));
function slice(name, node) { return files.get(name).source.slice(node.start, node.end); }
function declarations(name, predicate) {
  return files.get(name).ast.body.filter(predicate).map(node => slice(name, node)).join('\n');
}
const declarationSources = modules.map(name => declarations(name, node => node.type === 'FunctionDeclaration')).join('\n');
const globals = ['secure-entitlements-payment.js', 'secure-socket-handoff.js'].map(name => declarations(name,
  node => node.type === 'VariableDeclaration' && node.declarations.every(declaration =>
    declaration.id.type === 'Identifier' && /^(secure|SECURE_ZONE_)/.test(declaration.id.name)))).join('\n');
const authAst = files.get('auth-state.js').ast;
const authListener = authAst.body.filter(node => node.type === 'ExpressionStatement' &&
  node.expression.type === 'CallExpression' && node.expression.callee.type === 'MemberExpression' &&
  node.expression.callee.object.name === 'auth' && node.expression.callee.property.name === 'onAuthStateChanged');
assert.equal(authListener.length, 1, 'The existing SDK listener remains the single auth listener');
const stateNode = authAst.body.find(node => node.type === 'VariableDeclaration' &&
  node.declarations.some(declaration => declaration.id.name === 'state'));
assert.ok(stateNode, 'Actual client state initializer exists');
const scoreOverride = files.get('secure-entitlements-payment.js').ast.body.find(node =>
  node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' &&
  node.expression.left.name === 'loadScoreForCurrentId');
assert.ok(scoreOverride, 'Active server-authoritative score loader exists');
const movementOverride = files.get('secure-menu-economy.js').ast.body.find(node =>
  node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' &&
  node.expression.left.name === 'syncMyPlayerData');
assert.ok(movementOverride, 'Active socket movement override exists');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let round = 0; round < 16; round++) await Promise.resolve(); }

async function fixture() {
  const [protocol, config] = await Promise.all([
    import('../../src/shared/protocol.mjs'), import('../../src/shared/config.mjs')
  ]);
  let now = 1_900_000_000_000, nextTimerId = 0;
  const timers = new Map(), events = [], sockets = [], socketWaiters = [], elements = new Map(), authListeners = [];
  const requests = [];
  function element() {
    const classes = new Set();
    return { innerText: '', innerHTML: '', value: '', style: {}, children: [],
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
      appendChild(child) { this.children.push(child); }, addEventListener() {} };
  }
  const user = { uid: 'synthetic-client-p2-user', async getIdToken(refresh) {
    requests.push(refresh);
    return refresh ? 'synthetic-client-p2-refreshed-token' : 'synthetic-client-p2-token';
  } };
  const auth = { currentUser: user,
    onAuthStateChanged(callback) { authListeners.push(callback); },
    async signOut() { this.currentUser = null; for (const listener of authListeners) listener(null); } };
  class Socket {
    static OPEN = 1;
    constructor(url) {
      assert.equal(new URL(url).hostname, '127.0.0.1', 'The unit transport allows loopback only');
      this.url = url; this.readyState = 0; this.sent = []; this.closes = [];
      sockets.push(this); events.push({ kind: 'created', socket: this });
      socketWaiters.shift()?.resolve(this);
    }
    open() { this.readyState = 1; this.onopen?.(); }
    send(raw) { assert.equal(this.readyState, 1); const packet = JSON.parse(raw); this.sent.push(packet); events.push({ kind: 'send', socket: this, packet }); }
    receive(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3; this.closes.push({ code, reason }); events.push({ kind: 'close', socket: this, code });
      this.onclose?.({ code, reason });
    }
  }
  const c = vm.createContext({ protocol, config, WebSocket: Socket, auth,
    Date: { now: () => now }, Math, console: { warn() {}, error() {}, log() {} },
    setTimeout(callback, delay = 0) { const id = ++nextTimerId; timers.set(id, { callback, at: now + delay, interval: 0 }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval(callback, delay) { const id = ++nextTimerId; timers.set(id, { callback, at: now + delay, interval: delay }); return id; },
    clearInterval: id => timers.delete(id),
    requestAnimationFrame(callback) { callback(); },
    alert(message) { events.push({ kind: 'alert', message }); },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    MAP_SIZE: 1500, SECURE_WORKER_WS_BASE: 'ws://127.0.0.1/play',
    playerPos: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
    playerVel: { x: 0, z: 0 }, playerRotation: 0, playerGroup: null, otherPlayers: {}, coins: [], luckyBox: null
  });
  vm.runInContext(`${slice('auth-state.js', stateNode)}\nlet localGuestId = null;\n${globals}\n${declarationSources}\n${slice('secure-entitlements-payment.js', scoreOverride)}\n${slice('secure-menu-economy.js', movementOverride)}\n${slice('auth-state.js', authListener[0])}`, c,
    { filename: 'actual-P2-client-auth-session-functions.js' });
  c.secureOnIdentityChanged(user);
  vm.runInContext('state.isPlaying = true; state.userId = auth.currentUser.uid;', c);
  function evaluate(expression) { return vm.runInContext(expression, c); }
  function session(overrides = {}) {
    return { sessionId: 'synthetic-session', resumeToken: 'synthetic-resume-token',
      resumeExpiresAt: now + 120_000, tokenExpiresAt: now + 3600_000, ...overrides };
  }
  function welcome(zone = '4,4', metadata = session(), extra = {}) {
    return { type: 'welcome', protocol: 6, zone, id: 'synthetic-player', session: metadata,
      spawn: { x: -75, y: 0, z: -75, r: 0 }, players: [], coins: [], luckyBox: null, leaderboard: [], score: 0, serverNow: now, ...extra };
  }
  function nextSocket() { const waiting = deferred(); socketWaiters.push(waiting); return waiting.promise; }
  async function connect(zone = '4,4', metadata = session(), handoffToken = '', requireResume = false) {
    const created = nextSocket();
    const operation = c.secureOpenZoneSocket(zone, handoffToken, false, requireResume);
    operation.catch(() => {});
    const socket = await created;
    socket.open(); socket.receive(welcome(zone, metadata, { handoff: Boolean(handoffToken) }));
    await operation;
    return socket;
  }
  function fireNext() {
    const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(first, 'A real client timer was scheduled');
    const [id, timer] = first; now = timer.at;
    if (timer.interval) timer.at += timer.interval; else timers.delete(id);
    return timer.callback();
  }
  async function advance(ms) {
    const until = now + ms;
    for (let fired = 0; [...timers.values()].some(timer => timer.at <= until); fired++) {
      assert.ok(fired < 100, 'Client timer fixture must remain bounded');
      await fireNext(); await flush();
    }
    now = until; await flush();
  }
  return { c, auth, user, authListeners, requests, sockets, timers, events, elements,
    evaluate, session, welcome, nextSocket, connect, fireNext, advance, now: () => now };
}

test('P2 client resume tickets are scoped to SDK UID and normalized zone and expire on server time', async () => {
  const f = await fixture();
  const metadata = f.session();
  f.c.secureRememberSession('4,4', metadata);
  assert.equal(f.c.secureGetResumeTicket('4,4').resumeToken, metadata.resumeToken);
  assert.equal(f.c.secureGetResumeTicket('04,04').sessionId, metadata.sessionId);
  assert.equal(f.c.secureGetResumeTicket('5,4'), null);
  assert.equal(f.c.secureGetResumeTicket('4,4', 'synthetic-other-uid'), null);
  assert.equal(f.c.secureSessionKey('10,0'), '');
  assert.equal(f.c.secureSessionKey('4,4', null), '');
  f.c.secureRememberSession('5,4', { ...metadata, resumeExpiresAt: f.now() });
  assert.equal(f.c.secureGetResumeTicket('5,4'), null);
  await f.advance(120_000);
  assert.equal(f.c.secureGetResumeTicket('4,4'), null);
  assert.equal(f.evaluate('secureSessionTickets.size'), 0);
});

test('P2 client auth uses protocol six and handoff capability excludes reconnect capability', async () => {
  const f = await fixture();
  f.c.secureRememberSession('4,4', f.session());
  const initial = await f.connect();
  assert.equal(initial.sent[0].type, 'auth');
  assert.equal(initial.sent[0].protocol, 6);
  assert.equal(initial.sent[0].token, 'synthetic-client-p2-token');
  assert.equal(initial.sent[0].resumeToken, 'synthetic-resume-token');
  assert.equal(Object.hasOwn(initial.sent[0], 'uid'), false);
  f.c.secureRememberSession('5,4', f.session({ resumeToken: 'synthetic-target-resume-token' }));
  const target = await f.connect('5,4', f.session(), 'synthetic-handoff-token');
  assert.equal(target.sent[0].handoffToken, 'synthetic-handoff-token');
  assert.equal(target.sent[0].protocol, 6);
  assert.equal(Object.hasOwn(target.sent[0], 'resumeToken'), false);
});

test('P2 client same-UID refresh sends an SDK token and reschedules only after backend ACK', async () => {
  const f = await fixture();
  const socket = await f.connect('4,4', f.session({ tokenExpiresAt: f.now() + 61_000 }));
  assert.equal(f.timers.size, 1);
  await f.advance(1000);
  assert.deepEqual(f.requests, [false, true]);
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(socket.sent[1], { type: 'auth', token: 'synthetic-client-p2-refreshed-token', protocol: 6 });
  assert.equal(f.timers.size, 0, 'No speculative refresh timer can run without server ACK');
  const refreshed = f.session({ sessionId: 'synthetic-refreshed-session', resumeToken: 'synthetic-refreshed-resume' });
  socket.receive({ type: 'auth_refreshed', session: refreshed,
    entitlements: { speedExpires: f.now() + 10_000, coinExpires: 0, vip1Expires: 0 }, serverNow: f.now() });
  assert.equal(f.timers.size, 1);
  assert.equal(f.c.secureGetResumeTicket('4,4').resumeToken, refreshed.resumeToken);
  assert.equal(f.evaluate('state.shop.speedBuffExpires'), f.now() + 10_000);
});

test('P2 client lease notices cannot postpone or repeat the Firebase refresh timer', async () => {
  const f = await fixture();
  const metadata = f.session({ tokenExpiresAt: f.now() + 61_000 });
  const socket = await f.connect('4,4', metadata);
  const due = [...f.timers.values()][0].at;
  await f.advance(500);
  socket.receive({ type: 'auth_refreshed', session: { ...metadata, resumeExpiresAt: f.now() + 120_000 } });
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].at, due);
  await f.advance(500);
  assert.deepEqual(f.requests, [false, true]);
  assert.equal(f.timers.size, 0);
  socket.receive({ type: 'auth_refreshed', session: { ...metadata, resumeExpiresAt: f.now() + 120_000 } });
  assert.equal(f.timers.size, 0, 'A lease-only ACK with unchanged token expiry cannot start another refresh');
  assert.equal(socket.sent.length, 2);
});

test('P2 client UID switch while refreshing cannot transmit another account token', async () => {
  const f = await fixture();
  const socket = await f.connect('4,4', f.session({ tokenExpiresAt: f.now() + 61_000 }));
  const token = deferred();
  f.user.getIdToken = () => token.promise;
  const refresh = f.fireNext();
  f.auth.currentUser = { uid: 'synthetic-other-client-uid', async getIdToken() { return 'synthetic-other-token'; } };
  token.resolve('synthetic-other-token');
  await refresh;
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.readyState, 3);
  assert.equal(socket.closes[0].code, 1008);
  assert.equal(f.evaluate('state.isPlaying'), false);
  assert.equal(f.timers.size, 0);
});

test('P2 client account changes before token resolution or welcome fail closed', async () => {
  const f = await fixture();
  const token = deferred();
  f.user.getIdToken = () => token.promise;
  const operation = f.c.secureOpenZoneSocket('4,4');
  const rejection = assert.rejects(operation);
  f.auth.currentUser = { uid: 'synthetic-other-client-uid' };
  token.resolve('synthetic-other-token');
  await rejection;
  assert.equal(f.sockets.length, 0);

  const second = await fixture();
  const created = second.nextSocket();
  const handshake = second.c.secureOpenZoneSocket('4,4');
  const handshakeRejection = assert.rejects(handshake);
  const socket = await created;
  socket.open();
  second.auth.currentUser = { uid: 'synthetic-other-client-uid' };
  socket.receive(second.welcome());
  await handshakeRejection;
  assert.equal(socket.readyState, 3);
  assert.equal(second.evaluate('secureGameSocket'), null);
  assert.equal(second.evaluate('secureGameReady'), false);
  assert.equal(second.timers.size, 0);
});

test('P2 client late open and welcome callbacks cannot revive a timed-out socket', async () => {
  const f = await fixture();
  const created = f.nextSocket();
  const operation = f.c.secureOpenZoneSocket('4,4');
  const rejection = assert.rejects(operation);
  const socket = await created;
  await f.advance(10_000);
  await rejection;
  assert.equal(socket.readyState, 3);
  socket.onopen();
  socket.receive(f.welcome());
  assert.equal(socket.sent.length, 0);
  assert.equal(f.evaluate('secureGameSocket'), null);
  assert.equal(f.evaluate('secureGameReady'), false);
  assert.equal(f.evaluate('secureSessionTickets.size'), 0);
  assert.equal(f.timers.size, 0);
});

test('P2 client required resume rejects missing, expired and opening-race expired tickets without fresh auth', async () => {
  const f = await fixture();
  await assert.rejects(f.c.secureOpenZoneSocket('4,4', '', false, true));
  assert.equal(f.sockets.length, 0);
  assert.equal(f.requests.length, 0);
  f.c.secureRememberSession('4,4', f.session({ resumeExpiresAt: f.now() + 20 }));
  const created = f.nextSocket();
  const pending = f.c.secureOpenZoneSocket('4,4', '', false, true);
  const rejection = assert.rejects(pending);
  const socket = await created;
  await f.advance(21);
  socket.open();
  await rejection;
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.readyState, 3);
  assert.equal(f.c.secureGetResumeTicket('4,4'), null);
  assert.equal(f.timers.size, 0);
});

test('P2 client reconnect uses a retained resume ticket and policy rejection never reconnects', async () => {
  const f = await fixture();
  const original = await f.connect();
  const created = f.nextSocket();
  original.close(1006, 'Synthetic network loss');
  await f.advance(250);
  const resumed = await created;
  resumed.open();
  assert.equal(resumed.sent[0].resumeToken, 'synthetic-resume-token');
  assert.equal(resumed.sent[0].protocol, 6);
  resumed.receive(f.welcome('4,4', f.session({ resumeToken: 'synthetic-rotated-ticket' })));
  await flush();
  assert.equal(f.evaluate('secureGameSocket'), resumed);
  assert.equal(f.evaluate('state.serverPlayerId'), 'synthetic-player');
  assert.equal(f.evaluate('state.isPlaying'), true);
  assert.equal(f.c.secureGetResumeTicket('4,4').resumeToken, 'synthetic-rotated-ticket');
  resumed.close(1008, 'Synthetic policy rejection');
  await flush();
  assert.equal(f.evaluate('state.isPlaying'), false);
  await f.advance(2000);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.timers.size, 0);
});

test('D029 menu exit during reconnect backoff cannot reopen a socket or revive gameplay', async () => {
  const f = await fixture();
  const original = await f.connect();
  original.close(1006, 'Synthetic network loss');
  assert.equal(f.evaluate('state.isPlaying'), true);
  f.c.secureReturnToMenu();
  await flush(); await f.advance(5000);
  assert.equal(f.evaluate('state.isPlaying'), false);
  assert.equal(f.evaluate('state.isPaused'), false);
  assert.equal(f.evaluate('secureGameSocket'), null);
  assert.equal(f.evaluate('secureGameReady'), false);
  assert.equal(f.sockets.length, 1, 'cancelled backoff must not create a replacement');
  assert.equal(f.timers.size, 0);
});

test('D030 menu exit during reconnect authentication rejects late welcome and releases resources', async () => {
  const f = await fixture();
  const original = await f.connect();
  const created = f.nextSocket();
  original.close(1006, 'Synthetic network loss');
  await f.advance(250);
  const resumed = await created;
  resumed.open();
  assert.equal(resumed.sent.length, 1, 'resume authentication has started');
  assert.equal(f.evaluate('state.isPlaying'), true);
  f.c.secureReturnToMenu();
  await flush();
  assert.equal(resumed.readyState, 3, 'pending socket closes immediately');
  const sentBeforeLateCallbacks = resumed.sent.length;
  resumed.onopen();
  resumed.receive(f.welcome());
  await flush(); await f.advance(120_000);
  assert.equal(resumed.sent.length, sentBeforeLateCallbacks);
  // Tickets expire lazily through the authored accessor, not a cleanup timer.
  assert.equal(f.c.secureGetResumeTicket('4,4'), null);
  assert.equal(f.evaluate('state.isPlaying'), false);
  assert.equal(f.evaluate('state.isPaused'), false);
  assert.equal(f.evaluate('secureGameSocket'), null);
  assert.equal(f.evaluate('secureGameReady'), false);
  assert.equal(f.evaluate('secureSessionTickets.size'), 0);
  assert.equal(f.sockets.length, 2, 'late callbacks must not start another connection');
  assert.equal(f.timers.size, 0);
});

test('P2 client cancelled reconnect and expired ticket cannot fall back to a new session', async () => {
  const f = await fixture();
  assert.equal(await f.c.secureResumeDisconnectedSocket('4,4', f.user.uid), false);
  assert.equal(f.sockets.length, 0);
  f.c.secureRememberSession('4,4', f.session());
  const operation = f.c.secureResumeDisconnectedSocket('4,4', f.user.uid);
  f.c.secureCancelReconnect();
  await f.advance(250);
  assert.equal(await operation, false);
  assert.equal(f.sockets.length, 0);
  await f.advance(120_000);
  assert.equal(await f.c.secureResumeDisconnectedSocket('4,4', f.user.uid), false);
  assert.equal(f.sockets.length, 0);
});

test('P2 client logout uses the single existing SDK listener and clears socket timers and tickets', async () => {
  const f = await fixture();
  const socket = await f.connect();
  assert.equal(f.authListeners.length, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.evaluate('secureSessionTickets.size'), 1);
  f.c.logoutGoogle();
  await flush();
  assert.equal(f.auth.currentUser, null);
  assert.equal(socket.readyState, 3);
  assert.equal(socket.closes.length, 1);
  assert.equal(socket.closes[0].code, 1008);
  assert.equal(f.timers.size, 0);
  assert.equal(f.evaluate('secureSessionTickets.size'), 0);
  assert.equal(f.evaluate('secureGameSocket'), null);
  assert.equal(f.evaluate('state.isPlaying'), false);
  f.c.logoutGoogle();
  await flush();
  assert.equal(socket.closes.length, 1);
  assert.equal(f.authListeners.length, 1);
});

async function pendingHandoff(f) {
  const source = await f.connect('4,4');
  f.c.playerPos.set(1, 0, -75);
  const created = f.nextSocket();
  const settled = { value: false };
  const operation = f.c.secureBeginZoneHandoff({ from: '4,4', zone: '5,4',
    handoffToken: 'synthetic-p2-pending-handoff', expiresAt: f.now() + 12_000 });
  operation.then(() => { settled.value = true; }, () => { settled.value = true; });
  const target = await created;
  target.open();
  target.receive(f.welcome('5,4', f.session({ sessionId: 'synthetic-target-session', resumeToken: 'synthetic-target-resume' }),
    { handoff: true, fromZone: '4,4' }));
  await flush();
  assert.equal(target.sent.filter(packet => packet.type === 'handoff_resume').length, 1);
  assert.equal(source.readyState, 1, 'Source remains available while target resume ACK is pending');
  assert.equal(settled.value, false);
  return { source, target, settled, operation };
}

function assertCancelledHandoff(f, handoff) {
  assert.equal(handoff.source.readyState, 3);
  assert.equal(handoff.target.readyState, 3);
  assert.equal(handoff.settled.value, true, 'Cancelled ACK waiter must settle the handoff rather than hang');
  assert.equal(f.evaluate('secureGameSocket'), null);
  assert.equal(f.evaluate('secureGameReady'), false);
  assert.equal(f.evaluate('secureHandoffInProgress'), false);
  assert.equal(f.evaluate('secureHandoffResumeResolve'), null);
  assert.equal(f.evaluate('secureHandoffResumeReject'), null);
  assert.equal(f.evaluate('state.isPlaying'), false);
  assert.equal(f.timers.size, 0, 'All source/target token-refresh and ACK timers must stop');
}

test('P2 client logout while target resume ACK is pending closes both sockets and settles cancellation', async () => {
  const f = await fixture();
  const handoff = await pendingHandoff(f);
  await f.auth.signOut();
  await flush();
  assertCancelledHandoff(f, handoff);
  assert.equal(f.evaluate('secureSessionTickets.size'), 0);
  const wireEvents = handoff.source.sent.length + handoff.target.sent.length;
  handoff.target.receive({ type: 'handoff_resumed', zone: '5,4', x: 1, y: 0, z: -75, r: 0 });
  await flush();
  assertCancelledHandoff(f, handoff);
  assert.equal(handoff.source.sent.length + handoff.target.sent.length, wireEvents);
  await handoff.operation;
});

test('P2 client UID switch during pending handoff cannot recover the old-account source socket', async () => {
  const f = await fixture();
  const handoff = await pendingHandoff(f);
  f.auth.currentUser = { uid: 'synthetic-p2-switched-account', async getIdToken() { return 'synthetic-other-account-token'; } };
  // Invoke the actual identity-change handler called by the single SDK listener.
  // Rendering an unrelated account's profile is outside this ownership test.
  f.c.secureOnIdentityChanged(f.auth.currentUser);
  await flush();
  assertCancelledHandoff(f, handoff);
  assert.equal(f.evaluate('secureSessionTickets.size'), 0);
  handoff.target.receive({ type: 'handoff_resumed', zone: '5,4', x: 1, y: 0, z: -75, r: 0 });
  await flush();
  assertCancelledHandoff(f, handoff);
  assert.equal(handoff.target.sent.some(packet => packet.token === 'synthetic-other-account-token'), false);
  await handoff.operation;
});

test('P2 client returning to menu during pending handoff closes both sockets and rejects late ACK ownership', async () => {
  const f = await fixture();
  const handoff = await pendingHandoff(f);
  f.c.secureReturnToMenu();
  await flush();
  assertCancelledHandoff(f, handoff);
  handoff.target.receive({ type: 'handoff_resumed', zone: '5,4', x: 1, y: 0, z: -75, r: 0 });
  await flush();
  assertCancelledHandoff(f, handoff);
  await handoff.operation;
});

test('P2 client logout before target welcome cancels both connections without waiting for timeout', async () => {
  const f = await fixture();
  const source = await f.connect('4,4');
  f.c.playerPos.set(1, 0, -75);
  const created = f.nextSocket();
  const settled = { value: false };
  const operation = f.c.secureBeginZoneHandoff({ from: '4,4', zone: '5,4',
    handoffToken: 'synthetic-p2-before-welcome-handoff', expiresAt: f.now() + 12_000 });
  operation.then(() => { settled.value = true; }, () => { settled.value = true; });
  const target = await created;
  target.open();
  assert.equal(target.sent[0].type, 'auth');
  await f.auth.signOut();
  await flush();
  assertCancelledHandoff(f, { source, target, settled });
  target.receive(f.welcome('5,4', f.session(), { handoff: true, fromZone: '4,4' }));
  await flush();
  assertCancelledHandoff(f, { source, target, settled });
  await operation;
});

test('P2 client menu cancellation during SDK token await cannot create another socket afterward', async () => {
  const f = await fixture();
  const token = deferred();
  f.user.getIdToken = () => token.promise;
  const operation = f.c.secureOpenZoneSocket('4,4');
  const rejection = assert.rejects(operation);
  f.c.secureReturnToMenu();
  token.resolve('synthetic-client-p2-token');
  await rejection;
  assert.equal(f.sockets.length, 0);
  assert.equal(f.evaluate('secureGameSocket'), null);
  assert.equal(f.evaluate('state.isPlaying'), false);
  assert.equal(f.timers.size, 0);
});

test('P2 client logout cancels a retryable handoff ACK backoff without stranded timers', async () => {
  const f = await fixture();
  const handoff = await pendingHandoff(f);
  handoff.target.receive({ type: 'handoff_resume_error', message: 'Synthetic retry', retryable: true });
  await flush();
  assert.ok([...f.timers.values()].some(timer => timer.at === f.now() + 120));
  await f.auth.signOut();
  await flush();
  assertCancelledHandoff(f, handoff);
  assert.equal(handoff.target.sent.filter(packet => packet.type === 'handoff_resume').length, 1);
  await handoff.operation;
});

test('P2 client logout cancels a reconnect backoff before another connection is constructed', async () => {
  const f = await fixture();
  const source = await f.connect('4,4');
  source.close(1006, 'Synthetic network loss');
  assert.ok([...f.timers.values()].some(timer => timer.at === f.now() + 250));
  await f.auth.signOut();
  await flush();
  assert.equal(f.timers.size, 0);
  assert.equal(f.evaluate('secureReconnectInProgress'), false);
  assert.equal(f.evaluate('secureClientWaiters.size'), 0);
  assert.equal(f.evaluate('secureGameSocket'), null);
  assert.equal(f.evaluate('state.isPlaying'), false);
  assert.equal(f.evaluate('secureSessionTickets.size'), 0);
  await f.advance(2000);
  assert.equal(f.sockets.length, 1);
});
