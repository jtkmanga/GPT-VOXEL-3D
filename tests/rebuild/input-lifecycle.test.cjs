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

for (const interruption of ['blur', 'hidden', 'shop'])
test(`D014 ${interruption} sends idle intent without losing prediction history or newer jumps`, async () => {
  const { stagingClientFixture } = require('./staging-client-fixture.cjs');
  const f = await stagingClientFixture(), c = f.context;
  // Real controls + staging packet/prediction/reconciliation code; only DOM and transport are ports.
  const window = target(), document = target(), elements = new Map();
  document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, { ...target(), classList: { add() {}, remove() {} } });
    return elements.get(id);
  };
  c.window = window; c.document = document;
  vm.runInContext(fs.readFileSync('src/client/controls.js', 'utf8'), c);
  c.setupControls();
  const authored = fs.readFileSync('src/client/menu-shop.js', 'utf8');
  c.updateShopUI = () => {};
  for (const node of require('acorn').parse(authored, { ecmaVersion: 'latest' }).body) {
    if (['openShopModal', 'closeShopModal'].includes(node.id?.name)) vm.runInContext(authored.slice(node.start, node.end), c);
  }
  f.reset(); c.securePredictMovement(0);
  window.fire('keydown', { code: 'KeyW' });
  window.fire('keydown', { code: 'Space' });
  c.securePredictMovement(.02);
  assert.equal(c.syncMyPlayerData(true), true);
  assert.equal(f.sent[0].input.jump, true);
  assert.notEqual(f.sent[0].input.z, 0);
  const acknowledgedState = f.state();
  // This elapsed frame predates the interruption and must still reach authority once.
  c.securePredictMovement(.02);
  const history = f.read('({ frames: securePendingFrames, packets: securePendingInputs, seq: secureInputSequence, ack: secureLastAcknowledgedSequence })');
  if (interruption === 'blur') window.fire('blur');
  else if (interruption === 'hidden') { document.hidden = true; document.fire('visibilitychange'); }
  else c.openShopModal();
  assert.deepEqual(f.read('({ frames: securePendingFrames, packets: securePendingInputs, seq: secureInputSequence, ack: secureLastAcknowledgedSequence })'), history);
  assert.deepEqual(f.read('secureMovementIntent()'), { x: 0, z: 0, jump: false });
  assert.equal(c.syncMyPlayerData(true), true);
  assert.deepEqual(f.sent[1].input, { x: 0, z: 0, jump: false });
  assert.deepEqual(f.sent[1].frames, history.frames.filter(frame => frame.seq === 1).map(({ input, delta }) => ({ input, delta })));
  if (interruption === 'shop') c.closeShopModal();
  document.hidden = false;
  window.fire('keydown', { code: 'KeyW', repeat: true });
  c.securePredictMovement(.02);
  assert.equal(c.syncMyPlayerData(true), true);
  assert.ok(f.sent[2].frames.every(frame => frame.input.x === 0 && frame.input.z === 0 && !frame.input.jump));
  const remaining = f.read('securePendingFrames.filter(frame => frame.seq > 0)');
  let expected = acknowledgedState;
  for (const frame of remaining) expected = f.movement.integrateMovement(expected, frame.input, frame.delta, { ...c.secureMovementOptions(), speed: frame.speed });
  const ack = { ack: 0, player: acknowledgedState, movement: acknowledgedState };
  assert.equal(c.secureReconcileMovement(ack), true);
  assert.deepEqual(f.state(), JSON.parse(JSON.stringify(expected)));
  assert.deepEqual(f.read('securePendingFrames'), remaining);
  assert.deepEqual(f.read('securePendingInputs.map(packet => packet.seq)'), [1, 2]);
  assert.equal(f.read('secureLastAcknowledgedSequence'), 0);
  assert.equal(c.secureReconcileMovement(ack), false, 'duplicate ACK cannot replay history');
  assert.equal(f.read('secureJumpIntent'), false);
  // A fresh jump generation must survive the delayed ACK for a pre-interruption jump.
  c.isGrounded = true;
  window.fire('keydown', { code: 'Space' });
  assert.equal(f.read('secureJumpIntent'), true);
  assert.equal(c.secureReconcileMovement({ ...ack, ack: 1 }), true);
  assert.equal(f.read('secureJumpIntent'), true);
  window.fire('keydown', { code: 'KeyW' });
  assert.equal(c.syncMyPlayerData(true), true);
  assert.equal(f.sent.at(-1).input.jump, true);
  assert.notEqual(f.sent.at(-1).input.z, 0);
});

test('D017 touch-generated mouse events cannot replay a jump after landing', () => {
  const f = fixture(), c = f.context, jump = f.elements.get('btn-jump');
  let jumps = 0;
  c.audio.playJump = () => jumps++;
  let prevented = false;
  jump.fire('touchstart', { cancelable: true, preventDefault() { prevented = true; } });
  assert.equal(jumps, 1); assert.equal(prevented, true);
  // A delayed compatibility event may arrive after the prior jump has landed.
  c.isGrounded = true; c.playerVelocityY = 0;
  jump.fire('mousedown', { sourceCapabilities: { firesTouchEvents: true } });
  assert.equal(jumps, 1);
  assert.equal(c.isGrounded, true); assert.equal(c.playerVelocityY, 0);
  jump.fire('mousedown', { sourceCapabilities: { firesTouchEvents: false } });
  assert.equal(jumps, 2, 'physical mouse remains usable on a hybrid device');
  c.isGrounded = true;
  jump.fire('touchstart', { cancelable: true });
  assert.equal(jumps, 3, 'fresh touch still works');
});

test('D017 jump input without source capabilities retains mouse support', () => {
  const f = fixture(); let jumps = 0;
  f.context.audio.playJump = () => jumps++;
  f.elements.get('btn-jump').fire('mousedown');
  assert.equal(jumps, 1);
});
