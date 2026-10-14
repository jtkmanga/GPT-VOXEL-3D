'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const THREE = require('three');
const protocol = require('../../src/shared/protocol.mjs');
const { normalizePlayerName } = require('../../src/worker/spatial.mjs');
const root = path.resolve(__dirname, '../../src/client');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');

async function flush() { for (let round = 0; round < 12; round++) await Promise.resolve(); }

function socketFixture() {
  const sockets = [], events = [], requests = [], tickets = new Map(), timers = new Map();
  let nextTimer = 0;
  const user = { uid: 'synthetic-p6-client-user', async getIdToken(refresh) {
    requests.push(refresh); return 'synthetic-p6-sdk-token';
  } };
  const auth = { currentUser: user };
  class Socket {
    static OPEN = 1;
    constructor(url) {
      assert.equal(new URL(url).hostname, '127.0.0.1');
      this.url = url; this.readyState = 0; this.sent = [];
      sockets.push(this); events.push({ kind: 'created', socket: this });
    }
    open() { this.readyState = 1; this.onopen?.(); }
    send(raw) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(raw)); }
    receive(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
    close(code = 1000) {
      if (this.readyState === 3) return;
      this.readyState = 3; events.push({ kind: 'closed', socket: this });
      this.beforeClose?.(); this.onclose?.({ code });
    }
  }
  const context = vm.createContext({ auth, protocol, WebSocket: Socket,
    state: { isPlaying: true, playerName: 'Test Player' },
    secureGameSocket: null, secureGameReady: false, secureCurrentZoneId: '4,4',
    secureHandoffInProgress: false, secureIntentionalSockets: new WeakSet(),
    SECURE_ZONE_GRID_SIZE: 10, SECURE_ZONE_SIZE: 150, MAP_SIZE: 1500,
    SECURE_WORKER_WS_BASE: 'ws://127.0.0.1/play',
    secureNow: () => 1_900_000_000_000,
    console: { warn() {}, error() {} },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    secureCloseSocket(ws, code) { context.secureIntentionalSockets.add(ws); ws.close(code); },
    alert() {}, secureReturnToMenu() {}
  });
  for (const name of ['secure-snapshots.js', 'secure-socket-handoff.js'])
    vm.runInContext(source(name), context, { filename: name });
  // Transport tests exercise the authored open/auth/redirect lifecycle. Rendering
  // and token-refresh clocks are independent browser ports in this fixture.
  context.secureHandleSocketMessage = message => events.push({ kind: 'welcome', message });
  context.secureTrackAuthenticatedSocket = () => {};
  context.secureGetResumeTicket = zone => tickets.get(zone) || null;
  const welcome = zone => ({ type: protocol.WS_MESSAGE.WELCOME, zone });
  const redirect = zone => ({ type: protocol.WS_MESSAGE.AUTH_ERROR, resumeZone: zone, message: 'Saved Zone differs' });
  async function begin(zone = '4,4', handoff = '', requireResume = false) {
    const operation = context.secureOpenZoneSocket(zone, handoff, false, requireResume);
    operation.catch(() => {}); await flush();
    const socket = sockets.at(-1); assert.ok(socket); socket.open();
    return { operation, socket };
  }
  return { context, auth, user, tickets, sockets, events, requests, timers, welcome, redirect, begin,
    cancelEpoch() { vm.runInContext('secureClientConnectionEpoch++', context); } };
}

test('P6 actual fresh login follows the saved authoritative Zone once after closing its pending socket', async () => {
  const f = socketFixture(), { operation, socket } = await f.begin();
  assert.equal(Object.hasOwn(socket.sent[0], 'resumeToken'), false);
  assert.equal(Object.hasOwn(socket.sent[0], 'uid'), false);
  socket.receive(f.redirect('7,2')); await flush();
  assert.equal(f.sockets.length, 2); assert.equal(socket.readyState, 3);
  const target = f.sockets[1];
  assert.equal(new URL(target.url).searchParams.get('zone'), '7,2');
  assert.ok(f.events.findIndex(event => event.kind === 'closed') <
    f.events.findIndex(event => event.kind === 'created' && event.socket === target));
  socket.receive(f.welcome('4,4'));
  assert.equal(f.context.secureGameSocket, null, 'A late welcome from the redirected socket owns no session');
  target.open(); target.receive(f.welcome('7,2'));
  const result = await operation;
  assert.equal(result.ws, target); assert.equal(result.welcome.zone, '7,2');
  assert.equal(f.context.secureGameSocket, target); assert.equal(f.context.secureGameReady, true);
  assert.equal(f.timers.size, 0);
});

test('P6 a second saved-Zone redirect is rejected and cannot create a retry loop', async () => {
  const f = socketFixture(), { operation, socket } = await f.begin();
  socket.receive(f.redirect('7,2')); await flush();
  const target = f.sockets[1]; target.open(); target.receive(f.redirect('8,2'));
  await assert.rejects(operation, /Saved Zone differs/);
  assert.equal(f.sockets.length, 2); assert.equal(target.readyState, 3);
  assert.equal(f.context.secureGameSocket, null); assert.equal(f.timers.size, 0);
});

test('P6 handoff, required resume and opportunistic resume never follow a saved-Zone redirect', async () => {
  for (const kind of ['handoff', 'required', 'opportunistic']) {
    const f = socketFixture();
    if (kind !== 'handoff') f.tickets.set('4,4', { resumeToken: 'synthetic-p6-resume' });
    const { operation, socket } = await f.begin('4,4', kind === 'handoff' ? 'synthetic-p6-handoff' : '', kind === 'required');
    socket.receive(f.redirect('7,2'));
    await assert.rejects(operation, /Saved Zone differs/);
    assert.equal(f.sockets.length, 1, kind); assert.equal(socket.readyState, 3);
  }
});

test('P6 malformed, noncanonical, unchanged or non-auth saved-Zone redirects fail closed', async () => {
  for (const packet of [
    { resumeZone: '07,02' }, { resumeZone: '10,0' }, { resumeZone: '4,4' },
    { resumeZone: { zone: '7,2' } }, { resumeZone: '7,2', type: protocol.WS_MESSAGE.SERVER_ERROR },
    { resumeZone: '7,2', type: protocol.WS_MESSAGE.HANDOFF_ERROR }
  ]) {
    const f = socketFixture(), { operation, socket } = await f.begin();
    socket.receive({ ...f.redirect('7,2'), ...packet });
    await assert.rejects(operation, /Saved Zone differs/);
    assert.equal(f.sockets.length, 1); assert.equal(socket.readyState, 3);
  }
});

test('P6 account object, UID and epoch changes fence saved-Zone recovery', async () => {
  for (const kind of ['same-uid-new-sdk-object', 'other-uid', 'epoch', 'close-race']) {
    const f = socketFixture(), { operation, socket } = await f.begin();
    if (kind === 'same-uid-new-sdk-object') f.auth.currentUser = { ...f.user };
    if (kind === 'other-uid') f.auth.currentUser = { ...f.user, uid: 'synthetic-other-uid' };
    if (kind === 'epoch') f.cancelEpoch();
    if (kind === 'close-race') socket.beforeClose = () => { f.auth.currentUser = { ...f.user }; };
    socket.receive(f.redirect('7,2'));
    await assert.rejects(operation);
    assert.equal(f.sockets.length, 1, kind); assert.equal(f.context.secureGameSocket, null);
  }
});

test('P6 identity or epoch replacement during redirect token loading cannot open or adopt a recovered session', async () => {
  for (const kind of ['account', 'epoch']) {
    const f = socketFixture(), { operation, socket } = await f.begin();
    let release;
    f.user.getIdToken = () => new Promise(resolve => { release = resolve; });
    socket.receive(f.redirect('7,2'));
    if (kind === 'account') f.auth.currentUser = { ...f.user };
    else f.cancelEpoch();
    release('synthetic-late-token');
    await assert.rejects(operation);
    assert.equal(f.sockets.length, 1); assert.equal(f.context.secureGameSocket, null);
    assert.equal(f.context.secureGameReady, false);
  }
});

test('P6 identity or epoch replacement before redirected welcome cannot adopt the pending saved session', async () => {
  for (const kind of ['account', 'epoch']) {
    const f = socketFixture(), { operation, socket } = await f.begin();
    socket.receive(f.redirect('7,2')); await flush();
    const target = f.sockets[1]; target.open();
    if (kind === 'account') f.auth.currentUser = { ...f.user };
    else f.cancelEpoch();
    target.receive(f.welcome('7,2'));
    await assert.rejects(operation);
    assert.equal(target.readyState, 3); assert.equal(f.context.secureGameSocket, null);
    assert.equal(f.context.secureGameReady, false); assert.equal(f.timers.size, 0);
  }
});

function nameplateFixture() {
  const localTag = { style: {} }, state = { isPlaying: true, isPaused: false };
  const camera = new THREE.PerspectiveCamera(65, 2, .1, 1000);
  camera.position.set(0, 6, 12); camera.lookAt(0, 2, 0); camera.updateMatrixWorld();
  const playerPos = new THREE.Vector3(0, 0, 0), otherPlayers = {};
  function add(id, x, z) {
    const entry = { mesh: { position: new THREE.Vector3(x, 0, z) }, nameTagEl: { style: {} } };
    otherPlayers[id] = entry; return entry.nameTagEl;
  }
  const context = vm.createContext({ THREE, state, camera, playerPos, otherPlayers, staticMapObjects: [], nameplateOccluders: [],
    document: { getElementById(id) { assert.equal(id, 'player-nametag'); return localTag; } },
    renderer: { domElement: { getBoundingClientRect: () => ({ width: 800, height: 400, left: 20, top: 30 }) } }
  });
  const authored = source('wheel-frame.js');
  const node = acorn.parse(authored, { ecmaVersion: 'latest' }).body.find(node =>
    node.type === 'FunctionDeclaration' && node.id.name === 'updatePlayerNametagPosition');
  assert.ok(node); vm.runInContext(authored.slice(node.start, node.end), context);
  return { localTag, state, context, add, update: () => context.updatePlayerNametagPosition() };
}

test('P6 actual world nameplates appear only inside gameplay, unpaused, nearby, in front and onscreen', () => {
  const f = nameplateFixture();
  const near = f.add('near', 0, -10), boundary = f.add('boundary', 0, -28);
  const far = f.add('far', 0, -28.001), behind = f.add('behind', 0, 20), offscreen = f.add('offscreen', 27, 0);
  f.update();
  assert.equal(f.localTag.style.display, 'block'); assert.equal(near.style.display, 'block');
  assert.equal(boundary.style.display, 'block'); assert.equal(far.style.display, 'none');
  assert.equal(behind.style.display, 'none'); assert.equal(offscreen.style.display, 'none');
  assert.match(near.style.left, /^\d+(\.\d+)?px$/);
  for (const mode of ['menu', 'pause', 'missing-camera', 'missing-renderer']) {
    f.state.isPlaying = mode !== 'menu'; f.state.isPaused = mode === 'pause';
    if (mode === 'missing-camera') f.context.camera = null;
    if (mode === 'missing-renderer') f.context.renderer = null;
    f.update();
    for (const tag of [f.localTag, near, boundary, far, behind, offscreen]) assert.equal(tag.style.display, 'none', mode);
  }
});

test('P6 world nameplate style remains white text with transparent background and no border', () => {
  const html = source('index.template.html');
  const css = /\.name-tag\s*\{([^}]+)\}/.exec(html)?.[1]; assert.ok(css);
  assert.match(css, /color:\s*#ffffff\s*;/i); assert.match(css, /background:\s*transparent\s*;/);
  assert.match(css, /border:\s*none\s*;/); assert.match(css, /padding:\s*0\s*;/);
  const markup = /<div id="player-nametag"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
  assert.match(markup, /^\s*<span id="nametag-text">[^<]*<\/span>\s*$/);
});

test('P6 display names normalize whitespace, remove control/direction text and cap Unicode code points', () => {
  assert.equal(normalizePlayerName('  Alice\u0000\u202e\u200b  Bob\n '), 'Alice Bob');
  assert.equal(normalizePlayerName('😀'.repeat(20)), '😀'.repeat(12));
  assert.equal(normalizePlayerName('ผู้เล่น'), 'ผู้เล่น');
  assert.equal(normalizePlayerName(''), 'Player');
  assert.equal(normalizePlayerName({ name: 'Administrator' }), 'Player');
  assert.equal(normalizePlayerName('', '\u0000\u202e  Safe\u200b  Name '), 'Safe Name');
  assert.equal(normalizePlayerName('', { name: 'Administrator' }), 'Player');
  assert.ok([...normalizePlayerName('  abcdefghijklmnop  ')].length <= 12);
});

 test('D006 remote nameplates hide behind map geometry and recover when the obstruction moves', () => {
  const f = nameplateFixture(), tag = f.add('occluded', 0, -10);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(8, 12, 1), new THREE.MeshBasicMaterial());
  wall.position.set(0, 4, 0); wall.updateMatrixWorld(true);
  f.context.staticMapObjects.push(wall);
  f.update(); assert.equal(tag.style.display, 'none');
  wall.position.x = 40; wall.updateMatrixWorld(true);
  f.update(); assert.equal(tag.style.display, 'block');
  wall.position.set(0, 4, -20); wall.updateMatrixWorld(true);
  f.update(); assert.equal(tag.style.display, 'block', 'geometry behind the name must not occlude it');
  wall.geometry.dispose(); wall.material.dispose();
});


test('D007 distant geometry is culled once per frame for multiple names and moving geometry is reconsidered', () => {
  const f = nameplateFixture();
  const tags = Array.from({ length: 20 }, (_, i) => f.add(String(i), 0, -10));
  let updates = 0, rays = 0;
  const wall = new THREE.Mesh(new THREE.BoxGeometry(8, 12, 1), new THREE.MeshBasicMaterial());
  wall.position.set(1000, 4, 0);
  const update = wall.updateWorldMatrix.bind(wall), raycast = wall.raycast.bind(wall);
  wall.updateWorldMatrix = (...args) => { updates++; return update(...args); };
  wall.raycast = (...args) => { rays++; return raycast(...args); };
  f.context.staticMapObjects.push(wall);
  f.update();
  assert.equal(updates, 1); assert.equal(rays, 0);
  assert.ok(tags.every(tag => tag.style.display === 'block'));
  wall.position.x = 0;
  f.update();
  assert.equal(updates, 2); assert.equal(rays, 20);
  assert.ok(tags.every(tag => tag.style.display === 'none'));
  wall.visible = false;
  f.update();
  assert.equal(f.context.nameplateOccluders.length, 0);
  assert.ok(tags.every(tag => tag.style.display === 'block'));
  wall.geometry.dispose(); wall.material.dispose();
});

test('D007 static map cleanup empties the reusable shortlist and tree-sized geometry occludes', () => {
  const f = nameplateFixture(), tag = f.add('tree', 0, -10);
  const trunk = new THREE.Mesh(new THREE.BoxGeometry(2, 10, 2), new THREE.MeshBasicMaterial());
  trunk.position.set(0, 5, 0);
  f.context.staticMapObjects.push(trunk);
  f.update(); assert.equal(tag.style.display, 'none');
  const authored = source('world.js');
  const node = acorn.parse(authored, { ecmaVersion: 'latest' }).body.find(node =>
    node.type === 'FunctionDeclaration' && node.id.name === 'clearStaticMapObjects');
  const removed = [];
  Object.assign(f.context, { scene: { remove: object => removed.push(object) }, buildings: [{}], trees: [{}] });
  vm.runInContext(authored.slice(node.start, node.end), f.context);
  f.context.clearStaticMapObjects();
  assert.deepEqual(removed, [trunk]);
  for (const key of ['staticMapObjects', 'nameplateOccluders', 'buildings', 'trees'])
    assert.equal(f.context[key].length, 0, key);
  f.update(); assert.equal(tag.style.display, 'block');
  trunk.geometry.dispose(); trunk.material.dispose();
});
