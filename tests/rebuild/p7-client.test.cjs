'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const THREE = require('three');
const protocol = require('../../src/shared/protocol.mjs');
const config = require('../../src/shared/config.mjs');
const catalog = require('../../src/shared/catalog.mjs');
const movement = require('../../src/shared/movement.mjs');
const source = file => fs.readFileSync(path.resolve(__dirname, '../../src/client', file), 'utf8');
async function flush() { for (let round = 0; round < 12; round++) await Promise.resolve(); }

function fixture(serverId = 'vip1') {
  let now = 1_900_000_000_000, timerId = 0, entitlement = 0, fetchError = false;
  const timers = new Map(), requests = [], sockets = [], alerts = [], elements = new Map(), events = [], socketWaiters = [];
  const user = { uid: 'synthetic-p7-client-user', async getIdToken(refresh) {
    events.push({ kind: 'token', refresh }); return 'synthetic-p7-sdk-token';
  } };
  const auth = { currentUser: user };
  const state = { selectedServerId: serverId, isPlaying: false, isPaused: false, isLoggedIn: true,
    playerName: 'P7 Player', score: 0, userVipSubscriptions: {},
    shop: { speedBuffExpires: 0, coinBuffExpires: 0 }, vipServers: { vip1: { count: 0, max: 100 } } };
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { style: {}, value: '', innerText: '', innerHTML: '', src: '', disabled: false,
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) } });
    }
    return elements.get(id);
  }
  class Socket {
    static OPEN = 1;
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
      events.push({ kind: 'socket', socket: this });
      socketWaiters.shift()?.(this);
    }
    open() { this.readyState = 1; this.onopen?.(); }
    send(raw) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(raw)); }
    receive(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
  }
  const context = vm.createContext({ protocol, config, catalog, movement, THREE, auth, state, WebSocket: Socket,
    console: { warn() {}, error() {} }, Date: { now: () => now },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() { throw Error('Unexpected interval in fixture'); }, clearInterval() {},
    requestAnimationFrame: fn => fn(), document: { getElementById: element },
    playerPos: new THREE.Vector3(), playerVel: { x: 0, z: 0 }, playerRotation: 0,
    playerVelocityY: 0, isGrounded: true, playerGroup: null, otherPlayers: {}, coins: [],
    MAP_SIZE: 1500, keys: { w: true }, joystickVec: { x: 0, y: 0 }, cameraYaw: 0,
    removeAllOtherPlayers() {}, updateScoreDisplay() {}, updateLeaderboardUI() {},
    secureApplyLuckyBoxState() {}, updateShopUI() {}, renderServersUI() { events.push({ kind: 'render' }); },
    initServerMapData(id) { events.push({ kind: 'map', id }); },
    screen: {}, audio: { playStart() { events.push({ kind: 'start' }); } },
    syncMyPlayerData(force) { events.push({ kind: 'sync', force }); },
    localStorage: { removeItem() {} }, alert: message => alerts.push(message),
    async fetch(url, options) {
      requests.push({ url, options });
      assert.equal(options.headers.Authorization, 'Bearer synthetic-p7-sdk-token');
      if (/\/payment-qr$/.test(url)) {
        assert.equal(options.method, 'POST');
        return { ok: false, status: 503, async json() {
          return { ok: false, error: 'Production payment is disabled' };
        } };
      }
      assert.match(url, /\/entitlements$/, 'Only entitlement or fail-closed payment QR requests are allowed');
      assert.equal(options.method, 'GET');
      if (fetchError) throw Error('Synthetic entitlement outage');
      return { ok: true, async json() { return { ok: true, entitlements: { vip1Expires: entitlement },
        servers: { vip1: { count: 0, max: 100 } }, serverNow: now }; } };
    }
  });
  for (const file of ['secure-entitlements-payment.js', 'secure-snapshots.js', 'secure-socket-handoff.js'])
    vm.runInContext(source(file), context, { filename: file });
  // Execute the actual startup override without invoking its unrelated 3D boot.
  const startup = source('secure-wheel-startup.js');
  const node = acorn.parse(startup, { ecmaVersion: 'latest' }).body.find(node =>
    node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' && node.expression.left.name === 'startGame');
  assert.ok(node); vm.runInContext(startup.slice(node.start, node.end), context);
  const evaluate = expression => vm.runInContext(expression, context);
  const session = overrides => ({ sessionId: 'synthetic-p7-session', resumeToken: 'synthetic-p7-resume',
    resumeExpiresAt: now + 120_000, tokenExpiresAt: now + 3_600_000, ...overrides });
  const welcome = overrides => ({ type: 'welcome', protocol: 4, server: 'vip1', id: 'synthetic-p7-player',
    spawn: { x: 0, y: 0, z: 0, r: 0 }, players: [], coins: [], leaderboard: [],
    score: 0, serverNow: now, session: session(), ...overrides });
  function nextSocket() { return new Promise(resolve => socketWaiters.push(resolve)); }
  async function begin(requireResume = false) {
    const created = nextSocket();
    const operation = context.secureOpenZoneSocket('5,5', '', false, requireResume);
    operation.catch(() => {});
    const socket = await Promise.race([created, operation.then(() => { throw Error('Socket startup completed before construction'); })]);
    socket.open();
    return { operation, socket };
  }
  function runNextTimer() {
    const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    now = timer.at; timers.delete(id); return timer.fn();
  }
  return { context, evaluate, auth, user, state, sockets, requests, alerts, timers, events, element, session, welcome, begin, runNextTimer, nextSocket,
    grant(expiry = now + 30 * 24 * 60 * 60_000) { entitlement = expiry; }, failFetch() { fetchError = true; }, now: () => now };
}

test('P7 client selects VIP only from a fresh trusted entitlement response and ignores forged cached flags', async () => {
  const f = fixture('free1'); f.state.userVipSubscriptions.vip1 = { expireTime: Infinity };
  assert.equal(await f.context.selectVipServer('vip1'), false);
  assert.equal(f.state.selectedServerId, 'free1'); assert.equal(f.requests.length, 1);
  f.grant(); assert.equal(await f.context.selectVipServer('vip1'), true);
  assert.equal(f.state.selectedServerId, 'vip1');
  assert.equal(await f.context.selectVipServer('vip2'), false); assert.equal(f.requests.length, 2);
});

test('P7 client entitlement outage and same-UID SDK-object changes cannot authorize VIP selection', async () => {
  const outage = fixture('free1'); outage.grant(); outage.failFetch();
  assert.equal(await outage.context.selectVipServer(), false); assert.equal(outage.state.selectedServerId, 'free1');
  const changed = fixture('free1'); changed.grant();
  changed.user.getIdToken = async () => { changed.auth.currentUser = { ...changed.user }; return 'synthetic-p7-sdk-token'; };
  assert.equal(await changed.context.selectVipServer(), false); assert.equal(changed.requests.length, 0);
});

test('P7 VIP socket uses separate server routing and protocol four without trusting client VIP or payment flags', async () => {
  const f = fixture(), { operation, socket } = await f.begin();
  const url = new URL(socket.url); assert.equal(url.searchParams.get('server'), 'vip1');
  assert.equal(url.searchParams.has('zone'), false); assert.equal(socket.secureServerId, 'vip1');
  assert.deepEqual(socket.sent[0], { type: 'auth', token: 'synthetic-p7-sdk-token', protocol: 4, name: 'P7 Player' });
  socket.receive(f.welcome()); await operation;
  assert.equal(f.evaluate('secureGameReady'), true); assert.equal(f.evaluate('secureGameSocket'), socket);
  f.context.securePredictMovement(.05);
  assert.ok(f.context.playerPos.z < 0, 'VIP reuses the actual authoritative-intent prediction kernel');
});

test('P7 VIP rejects wrong room/protocol/handoff welcomes and never follows saved-Zone redirects', async () => {
  for (const fields of [{ server: 'free1' }, { server: undefined }, { protocol: 6 }, { protocol: undefined }, { handoff: true }]) {
    const f = fixture(), { operation, socket } = await f.begin();
    socket.receive(f.welcome(fields)); await assert.rejects(operation);
    assert.equal(socket.readyState, 3); assert.equal(f.evaluate('secureGameReady'), false);
  }
  const f = fixture(), { operation, socket } = await f.begin();
  socket.receive({ type: 'auth_error', resumeZone: '8,8' }); await assert.rejects(operation);
  assert.equal(f.sockets.length, 1);
  await assert.rejects(f.context.secureOpenZoneSocket('5,5', 'synthetic-forged-handoff'));
});

test('P7 Free and VIP resume tickets cannot cross rooms and VIP remains scoped to the SDK UID', async () => {
  const f = fixture('free1');
  f.context.secureRememberSession('5,5', f.session({ resumeToken: 'synthetic-free-resume' }));
  f.state.selectedServerId = 'vip1'; assert.equal(f.context.secureGetResumeTicket('5,5'), null);
  f.context.secureRememberSession('5,5', f.session({ resumeToken: 'synthetic-vip-resume' }));
  assert.equal(f.context.secureGetResumeTicket('4,4').resumeToken, 'synthetic-vip-resume');
  assert.equal(f.context.secureGetResumeTicket('5,5', 'synthetic-other-uid'), null);
  const { operation, socket } = await f.begin(true); assert.equal(socket.sent[0].resumeToken, 'synthetic-vip-resume');
  socket.receive(f.welcome()); await operation;
  f.state.selectedServerId = 'free1'; assert.equal(f.context.secureGetResumeTicket('5,5').resumeToken, 'synthetic-free-resume');
  assert.equal(f.context.secureGetResumeTicket('4,4'), null);
});

test('P7 VIP SDK token refresh retains protocol four and resume session metadata', async () => {
  const f = fixture(), { operation, socket } = await f.begin();
  socket.receive(f.welcome({ session: f.session({ tokenExpiresAt: f.now() + 61_000 }) })); await operation;
  await f.runNextTimer(); await flush();
  assert.deepEqual(socket.sent.at(-1), { type: 'auth', token: 'synthetic-p7-sdk-token', protocol: 4 });
  socket.receive({ type: 'auth_refreshed', session: f.session({ resumeToken: 'synthetic-vip-refreshed' }),
    entitlements: { vip1Expires: f.now() + 60_000 }, serverNow: f.now() });
  assert.equal(f.context.secureGetResumeTicket('5,5').resumeToken, 'synthetic-vip-refreshed');
});

test('P7 disconnected VIP resumes the same authoritative room/session and never opens a Free Zone', { timeout: 3000 }, async () => {
  const f = fixture(), { operation, socket } = await f.begin(); socket.receive(f.welcome()); await operation;
  f.state.isPlaying = true; const created = f.nextSocket(); socket.close(1006);
  assert.equal(f.evaluate('secureGameReady'), false); await f.runNextTimer();
  const recovered = await created; recovered.open();
  assert.equal(new URL(recovered.url).searchParams.get('server'), 'vip1');
  assert.equal(recovered.sent[0].protocol, 4); assert.equal(recovered.sent[0].resumeToken, 'synthetic-p7-resume');
  recovered.receive(f.welcome({ resumed: true })); await flush();
  assert.equal(f.evaluate('secureGameSocket'), recovered); assert.equal(f.evaluate('secureGameReady'), true);
  assert.equal(f.sockets.length, 2); assert.equal(f.alerts.length, 0);
});

test('P7 server selection changes fence pending sockets and prevent cross-room reconnect', async () => {
  const f = fixture(), { operation, socket } = await f.begin();
  f.state.selectedServerId = 'free1'; socket.receive(f.welcome()); await assert.rejects(operation);
  assert.equal(f.evaluate('secureGameSocket'), null); assert.equal(socket.readyState, 3);
  const r = fixture(); r.context.secureRememberSession('5,5', r.session());
  r.state.isPlaying = true; const reconnect = r.context.secureResumeDisconnectedSocket('5,5', r.user.uid, 'vip1');
  r.state.selectedServerId = 'free1'; await r.runNextTimer(); assert.equal(await reconnect, false);
  assert.equal(r.sockets.length, 0);
});

test('P7 VIP world never starts Free Zone handoffs or ghost subscriptions', async () => {
  const f = fixture(), { operation, socket } = await f.begin(); socket.receive(f.welcome()); await operation;
  f.state.isPlaying = true;
  socket.receive({ type: 'zone_change', from: '5,5', zone: '6,5', handoffToken: 'synthetic-forged-free-transfer', expiresAt: f.now() + 10_000 });
  socket.receive({ type: 'ghost_snapshot', zone: '6,5', players: [{ id: 'synthetic-ghost', name: 'Ghost' }] });
  await f.context.secureBeginZoneHandoff({ zone: '6,5', handoffToken: 'synthetic-forged-free-transfer' });
  assert.equal(f.sockets.length, 1); assert.equal(f.evaluate('secureHandoffInProgress'), false);
  assert.equal(f.evaluate('secureGhostMembersByZone.size'), 0);
});

test('P7 actual VIP start revalidates entitlement and enters the separately authenticated gameplay room', { timeout: 3000 }, async () => {
  const f = fixture(); f.grant(); const created = f.nextSocket(), start = f.context.startGame();
  const socket = await Promise.race([created, start.then(() => { throw Error(`Start completed before socket construction: ${f.alerts}`); })]);
  socket.open(); socket.receive(f.welcome()); await start;
  assert.equal(f.state.isPlaying, true); assert.equal(f.events.find(event => event.kind === 'map').id, config.SERVER_WORLD_SEED);
  assert.equal(config.SERVER_WORLD_SEED, 'free1'); assert.equal(new URL(socket.url).searchParams.get('server'), 'vip1');
  assert.equal(f.element('start-screen').classList.contains('hidden'), true);
  assert.equal(f.element('game-hud').classList.contains('hidden'), false);
  const expired = fixture(); expired.state.userVipSubscriptions.vip1 = { expireTime: Infinity };
  await expired.context.startGame(); assert.equal(expired.sockets.length, 0); assert.equal(expired.state.isPlaying, false);
});

test('P7 stale account or overlapping startup cannot close or overwrite a newer active VIP session', { timeout: 3000 }, async () => {
  for (const replacement of ['account', 'epoch']) {
    const f = fixture(); f.grant(); let release;
    f.user.getIdToken = () => new Promise(resolve => { release = resolve; });
    const oldStart = f.context.startGame(); assert.ok(release);
    if (replacement === 'account') f.auth.currentUser = { uid: 'synthetic-p7-replacement-user', async getIdToken() { return 'synthetic-p7-sdk-token'; } };
    else f.user.getIdToken = async () => 'synthetic-p7-sdk-token';
    const created = f.nextSocket(), newStart = f.context.startGame();
    const socket = await Promise.race([created, newStart.then(() => { throw Error(`Replacement start failed: ${f.alerts}`); })]);
    socket.open(); socket.receive(f.welcome()); await newStart;
    release('synthetic-p7-sdk-token'); await oldStart;
    assert.equal(socket.readyState, 1, replacement); assert.equal(f.evaluate('secureGameSocket'), socket);
    assert.equal(f.evaluate('secureGameReady'), true); assert.equal(f.state.isPlaying, true);
    assert.equal(f.element('game-hud').classList.contains('hidden'), false); assert.equal(f.alerts.length, 0);
    assert.equal(f.sockets.length, 1);
  }
});

test('P7 VIP Slip2Go checkout ignores forged client price and fails closed while production payment is disabled', async () => {
  const f = fixture();
  f.context.openPaymentModal('vip1', 1, 'Forged price');
  await flush();
  assert.equal(f.state.pendingPayment, null);
  assert.equal(f.element('promptpay-qr-img').src, '');
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].url, /\/payment-qr$/);
  assert.equal(f.requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { item: 'vip1' });
  assert.ok(f.alerts.some(message => /disabled|PromptPay/i.test(message)));
  assert.equal(f.context.grantPurchasedItem(), false);
  assert.deepEqual(f.state.userVipSubscriptions, {});
});

test('P7 server chooser advertises unlimited Free players and VIP 100 seats at 50 THB per month', () => {
  const html = source('index.template.html'); assert.match(html, /Free Server ฟรีไม่จำกัด/);
  assert.match(html, /ไม่จำกัดผู้เล่น/); assert.match(html, /0\/100/); assert.match(html, /50 บาท\/เดือน/);
  assert.equal(catalog.PAYMENT_CATALOG.vip1.price, 50); assert.equal(config.VIP_ENTITLEMENT_CAP, 100);
  assert.equal(catalog.PAYMENT_CATALOG.vip1.duration, 30 * 24 * 60 * 60_000);
});
