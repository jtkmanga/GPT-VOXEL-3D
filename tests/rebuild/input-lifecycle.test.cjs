'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function target() {
  const handlers = new Map();
  return { style: {}, hidden: false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
    fire(type, data = {}) { for (const fn of handlers.get(type) || []) fn({ preventDefault() {}, stopPropagation() {}, ...data }); }
  };
}
function fixture() {
  const window = target(), document = target(), elements = new Map();
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, target()); return elements.get(id); };
  const context = vm.createContext({ window, document, keys: { w: false, a: false, s: false, d: false },
    joystickVec: { x: 0, y: 0 }, cameraYaw: 0, cameraPitch: .5, secureJumpIntent: false,
    secureJumpHeld: false, state: { isPlaying: true, isPaused: false }, isGrounded: true,
    playerVelocityY: 0, audio: { playJump() {} },
    secureQueueJump() { context.secureJumpIntent = true; context.secureJumpHeld = true; } });
  vm.runInContext(fs.readFileSync('src/client/controls.js', 'utf8'), context);
  context.setupControls();
  const touch = (identifier, x = 95) => ({ identifier, clientX: x, clientY: 50, target: { closest: () => false } });
  return { context, window, document, elements, touch };
}
for (const interruption of ['blur', 'hidden']) test(`D012 ${interruption} releases movement, jump intent and camera gestures`, () => {
  const f = fixture(), c = f.context;
  f.window.fire('keydown', { code: 'KeyW' }); f.window.fire('keydown', { code: 'Space' });
  f.elements.get('joystick-zone').fire('touchstart', { changedTouches: [f.touch(1)] });
  f.window.fire('touchstart', { changedTouches: [f.touch(2)] });
  f.window.fire('mousedown', { clientX: 0, clientY: 0, target: { closest: () => false } });
  assert.equal(c.keys.w, true); assert.ok(c.joystickVec.x > 0); assert.equal(c.secureJumpIntent, true);
  if (interruption === 'blur') f.window.fire('blur');
  else { f.document.hidden = true; f.document.fire('visibilitychange'); }
  assert.ok(Object.values(c.keys).every(value => value === false));
  assert.equal(c.joystickVec.x, 0); assert.equal(c.joystickVec.y, 0);
  assert.equal(c.secureJumpIntent, false); assert.equal(c.secureJumpHeld, false);
  const yaw = c.cameraYaw;
  f.window.fire('touchmove', { changedTouches: [f.touch(1, 20), f.touch(2, 20)] });
  f.window.fire('mousemove', { clientX: 30, clientY: 30 });
  assert.equal(c.cameraYaw, yaw); assert.equal(c.joystickVec.x, 0);
  f.document.hidden = false; f.document.fire('visibilitychange');
  f.elements.get('joystick-zone').fire('touchstart', { changedTouches: [f.touch(3)] });
  assert.ok(c.joystickVec.x > 0, 'new gesture can begin after reset');
});
test('D012 touch cancellation affects only its owning joystick gesture', () => {
  const f = fixture();
  f.elements.get('joystick-zone').fire('touchstart', { changedTouches: [f.touch(1)] });
  f.window.fire('touchcancel', { changedTouches: [f.touch(2)] });
  assert.ok(f.context.joystickVec.x > 0);
  f.window.fire('touchcancel', { changedTouches: [f.touch(1)] });
  assert.equal(f.context.joystickVec.x, 0);
});

for (const [open, close] of [['openShopModal', 'closeShopModal'], ['openHomeConfirmModal', 'closeHomeConfirmModal']])
test(`D013 ${open} clears held input and resume requires a fresh gesture`, () => {
  const f = fixture(), c = f.context;
  const acorn = require('acorn');
  const authored = fs.readFileSync('src/client/menu-shop.js', 'utf8');
  c.updateShopUI = () => {};
  for (const id of ['shop-modal', 'exit-modal', 'player-nametag']) {
    f.document.getElementById(id).classList = { add() {}, remove() {} };
  }
  for (const node of acorn.parse(authored, { ecmaVersion: 'latest' }).body) {
    if ([open, close].includes(node.id?.name)) vm.runInContext(authored.slice(node.start, node.end), c);
  }
  f.window.fire('keydown', { code: 'KeyW' });
  f.elements.get('joystick-zone').fire('touchstart', { changedTouches: [f.touch(1)] });
  c.secureJumpIntent = true; c.secureJumpHeld = true;
  c[open]();
  assert.equal(c.state.isPaused, true); assert.equal(c.keys.w, false);
  assert.equal(c.joystickVec.x, 0); assert.equal(c.secureJumpIntent, false);
  f.window.fire('keydown', { code: 'KeyD' });
  f.elements.get('joystick-zone').fire('touchstart', { changedTouches: [f.touch(2)] });
  assert.equal(c.keys.d, false); assert.equal(c.joystickVec.x, 0);
  c[close]();
  f.window.fire('keydown', { code: 'KeyW', repeat: true });
  f.window.fire('touchmove', { changedTouches: [f.touch(1), f.touch(2)] });
  assert.equal(c.keys.w, false); assert.equal(c.joystickVec.x, 0);
  f.window.fire('keyup', { code: 'KeyW' }); f.window.fire('keydown', { code: 'KeyW' });
  f.elements.get('joystick-zone').fire('touchstart', { changedTouches: [f.touch(3)] });
  assert.equal(c.keys.w, true); assert.ok(c.joystickVec.x > 0);
});
