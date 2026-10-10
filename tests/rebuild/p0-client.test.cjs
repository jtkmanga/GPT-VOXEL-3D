'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const acorn = require('acorn');
const html = fs.readFileSync('index.html', 'utf8');
const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].pop()[1];
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
function activeFunction(name) {
  const node = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(node, `Active client function ${name} exists`);
  return source.slice(node.start, node.end);
}
function eventTarget() {
  const listeners = new Map();
  return {
    style: {},
    addEventListener(type, cb) { const list = listeners.get(type) || []; list.push(cb); listeners.set(type, list); },
    dispatch(type, e = {}) { for (const cb of listeners.get(type) || []) cb({ preventDefault() {}, stopPropagation() {}, ...e }); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
  };
}
function controls() {
  const window = eventTarget();
  const elements = new Map(['btn-jump', 'joystick-zone', 'joystick-handle'].map(id => [id, eventTarget()]));
  let jumpSounds = 0;
  const c = vm.createContext({ window, document: { getElementById: id => elements.get(id) }, keys: {}, joystickVec: { x: 0, y: 0 }, cameraYaw: 0, cameraPitch: 0.5,
    state: { isPlaying: true, isPaused: false }, isGrounded: true, playerVelocityY: 0, audio: { playJump() { jumpSounds++; } } });
  vm.runInContext(activeFunction('triggerJump') + '\n' + activeFunction('setupControls') + '\nsetupControls();', c);
  return { c, window, elements, jumpSounds: () => jumpSounds };
}
test('P0 controls: WASD and arrows press/release all four directions', () => {
  const { c, window } = controls();
  for (const [key, code] of [['w', 'KeyW'], ['s', 'KeyS'], ['a', 'KeyA'], ['d', 'KeyD'], ['w', 'ArrowUp'], ['s', 'ArrowDown'], ['a', 'ArrowLeft'], ['d', 'ArrowRight']]) {
    window.dispatch('keydown', { code }); assert.equal(c.keys[key], true);
    window.dispatch('keyup', { code }); assert.equal(c.keys[key], false);
  }
});
test('P0 controls: joystick clamps input and ignores unrelated finger release', () => {
  const { c, window, elements } = controls();
  const t = { identifier: 17, clientX: 500, clientY: 50 };
  elements.get('joystick-zone').dispatch('touchstart', { changedTouches: [t] });
  assert.equal(c.joystickVec.x, 1); assert.equal(c.joystickVec.y, 0);
  window.dispatch('touchend', { changedTouches: [{ identifier: 18 }] });
  assert.equal(c.joystickVec.x, 1);
  window.dispatch('touchcancel', { changedTouches: [t] });
  assert.equal(c.joystickVec.x, 0); assert.equal(c.joystickVec.y, 0);
});
test('P0 controls: jump applies only while grounded, playing and unpaused', () => {
  const { c, window, elements, jumpSounds } = controls();
  window.dispatch('keydown', { code: 'Space' });
  assert.equal(c.playerVelocityY, 16); assert.equal(c.isGrounded, false); assert.equal(jumpSounds(), 1);
  elements.get('btn-jump').dispatch('touchstart', { cancelable: true }); assert.equal(jumpSounds(), 1);
  c.isGrounded = true; c.state.isPaused = true;
  elements.get('btn-jump').dispatch('mousedown'); assert.equal(jumpSounds(), 1);
  c.state.isPaused = false; c.state.isPlaying = false;
  elements.get('btn-jump').dispatch('mousedown'); assert.equal(jumpSounds(), 1);
});
test('P0 client: socket startup sends backend token and selected name then handles welcome', { timeout: 2000 }, async t => {
  const instances = [], sent = [];
  let handled = 0, requestedRefresh;
  let resolveSocketCreated;
  const socketCreated = new Promise(resolve => { resolveSocketCreated = resolve; });
  const timers = new Set();
  t.after(() => { for (const id of timers) clearTimeout(id); });
  class FakeWebSocket { constructor(url) { this.url = url; instances.push(this); resolveSocketCreated(this); } send(raw) { sent.push(JSON.parse(raw)); } }
  const c = vm.createContext({ WebSocket: FakeWebSocket,
    setTimeout(callback, delay) { const id = setTimeout(callback, delay); timers.add(id); return id; },
    clearTimeout(id) { clearTimeout(id); timers.delete(id); }, console,
    auth: { currentUser: { async getIdToken(refresh) { requestedRefresh = refresh; return 'synthetic-client-token'; } } },
    state: { playerName: 'Baseline', isPlaying: true },
    secureNormalizeZoneId: value => /^\d,\d$/.test(value) ? value : null,
    secureZoneSocketUrl: zone => `ws://127.0.0.1/play?zone=${zone}`,
    secureCloseSocket() {}, secureHandleSocketMessage() { handled++; }, secureReturnToMenu() {}, alert() {},
    secureIntentionalSockets: new WeakSet(), secureGameSocket: null, secureGameReady: false, secureCurrentZoneId: null, secureHandoffInProgress: false });
  vm.runInContext(activeFunction('secureOpenZoneSocket'), c);
  const pending = c.secureOpenZoneSocket('5,5');
  // Wait for the observable construction event, not an assumed microtask count.
  // Startup rejection also fails this wait promptly; cleanup retains no timers.
  const ws = await Promise.race([socketCreated, pending.then(() => { throw new Error('Startup completed before simulated welcome'); })]);
  assert.ok(ws); assert.equal(ws, instances[0]); ws.onopen();
  assert.equal(requestedRefresh, false); assert.equal(sent[0].type, 'auth');
  assert.equal(sent[0].token, 'synthetic-client-token'); assert.equal(sent[0].name, 'Baseline');
  ws.onmessage({ data: JSON.stringify({ type: 'welcome', zone: '5,5', protocol: 4 }) });
  const result = await pending;
  assert.equal(result.ws, ws); assert.equal(c.secureGameReady, true); assert.equal(c.secureCurrentZoneId, '5,5'); assert.equal(handled, 1);
});
