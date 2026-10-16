'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const acorn = require('acorn');
const { stagingClientFixture } = require('./staging-client-fixture.cjs');
async function fixture() {
  const f = await stagingClientFixture(), c = f.context, frames = [], elements = new Map();
  let rewards = 0, draws = 0;
  c.document.getElementById = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { style: {}, innerText: '', innerHTML: '', classList: {
        add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value)
      } });
    }
    return elements.get(id);
  };
  c.performance = { now: () => 0 }; c.currentWheelAngle = 0;
  c.WHEEL_ITEMS = [{ value: 100 }, { value: 500 }];
  c.drawLuckyWheel = () => draws++;
  c.audio.playWheelTick = () => {}; c.audio.playReward = () => rewards++; c.audio.playBoxHit = () => {};
  c.requestAnimationFrame = fn => frames.push(fn);
  const source = fs.readFileSync('src/client/secure-wheel-startup.js', 'utf8');
  const node = acorn.parse(source, { ecmaVersion: 'latest' }).body.find(node => node.id?.name === 'secureAnimateWheelToReward');
  vm.runInContext(source.slice(node.start, node.end), c);
  const wheelSource = fs.readFileSync('src/client/wheel-frame.js', 'utf8');
  const closeNode = acorn.parse(wheelSource, { ecmaVersion: 'latest' }).body.find(node => node.id?.name === 'closeWheelModal');
  vm.runInContext(wheelSource.slice(closeNode.start, closeNode.end), c);
  c.luckyBox = {}; c.triggerLuckyBoxModal(); c.state.wheelSpinning = true;
  return { ...f, frames, elements, rewards: () => rewards, draws: () => draws };
}
test('D025 matching expired-claim rejection offers return to gameplay without a reward', async () => {
  const f = await fixture(), c = f.context;
  c.console = { warn() {} }; c.state.wheelSpinning = false;
  c.spinWheel(); const requestId = f.sent.at(-1).requestId;
  c.secureHandleSocketMessage({ type: 'box_error', requestId: 'synthetic-old', message: 'Lucky Box claim expired' });
  assert.equal(c.state.wheelSpinning, true);
  assert.equal(f.elements.get('btn-close-wheel').classList.contains('hidden'), true);
  c.secureHandleSocketMessage({ type: 'box_error', requestId, message: 'Lucky Box claim expired' });
  assert.equal(c.state.wheelSpinning, false);
  assert.equal(f.elements.get('btn-close-wheel').classList.contains('hidden'), false);
  assert.equal(f.elements.get('btn-spin-wheel').classList.contains('hidden'), true);
  assert.equal(f.elements.get('btn-close-wheel').innerText, 'เล่นต่อ');
  assert.equal(c.state.score, 0); assert.equal(f.rewards(), 0); assert.equal(f.frames.length, 0);
  c.closeWheelModal();
  assert.equal(c.state.isPaused, false);
  assert.equal(f.elements.get('wheel-modal').classList.contains('hidden'), true);
  c.triggerLuckyBoxModal();
  assert.equal(f.elements.get('btn-close-wheel').innerText, 'รับรางวัล & เล่นต่อ');
  assert.equal(f.elements.get('btn-close-wheel').classList.contains('hidden'), true);
  assert.equal(f.elements.get('btn-spin-wheel').classList.contains('hidden'), false);
});
test('D021 returning to menu cancels wheel UI and stale animation completion', async () => {
  const f = await fixture(), c = f.context;
  c.secureAnimateWheelToReward(100); const stale = f.frames.shift();
  c.secureReturnToMenu();
  assert.equal(f.elements.get('wheel-modal').classList.contains('hidden'), true);
  assert.equal(c.state.wheelSpinning, false); assert.equal(c.state.wheelReward, null);
  const draws = f.draws(); stale(4000);
  assert.equal(f.draws(), draws); assert.equal(f.rewards(), 0);
});
test('D021 old animation cannot overwrite a newer session/modal or reward animation', async () => {
  const f = await fixture(), c = f.context;
  c.secureAnimateWheelToReward(100); const stale = f.frames.shift();
  c.secureReturnToMenu(); c.state.isPlaying = true; c.luckyBox = {};
  c.triggerLuckyBoxModal(); c.state.wheelSpinning = true;
  c.secureAnimateWheelToReward(500); const current = f.frames.shift();
  const angle = c.currentWheelAngle, draws = f.draws(); stale(4000);
  assert.equal(c.currentWheelAngle, angle); assert.equal(f.draws(), draws);
  assert.equal(c.state.wheelSpinning, true); assert.equal(f.rewards(), 0);
  current(4000);
  assert.equal(c.state.wheelSpinning, false); assert.equal(f.rewards(), 1);
  assert.match(f.elements.get('wheel-result-msg').innerHTML, /500/);
});
