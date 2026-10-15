'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stagingClientFixture } = require('./staging-client-fixture.cjs');

async function fixture() {
  const f = await stagingClientFixture(), c = f.context, timers = [], animations = [];
  c.luckyBox = { _spinActionRequestId: 'synthetic-spin-a' };
  c.document.getElementById = () => ({ classList: { add() {}, remove() {} }, innerText: '' });
  c.setTimeout = fn => { timers.push(fn); return timers.length; };
  c.console = { warn() {} };
  c.secureAnimateWheelToReward = reward => animations.push(reward);
  return { ...f, timers, animations };
}

test('D020 lost spin response retries the same action and ignores stale action replies', async () => {
  const f = await fixture(), c = f.context;
  c.spinWheel(); const request = f.sent.at(-1).requestId;
  f.timers[0](); assert.equal(c.state.wheelSpinning, false);
  c.spinWheel(); assert.equal(f.sent.at(-1).requestId, request);
  c.secureHandleSocketMessage({ type: 'box_reward', requestId: request, receipt: 'synthetic-receipt', reward: 100 });
  assert.deepEqual(f.animations, [100]);
  c.secureHandleSocketMessage({ type: 'box_reward', requestId: request, receipt: 'synthetic-receipt', reward: 100 });
  assert.deepEqual(f.animations, [100], 'duplicate reward cannot animate twice');
  c.state.wheelSpinning = false; c.luckyBox._spinActionRequestId = 'synthetic-spin-b';
  c.spinWheel();
  c.secureHandleSocketMessage({ type: 'box_reward', requestId: request, receipt: 'synthetic-old', reward: 500 });
  c.secureHandleSocketMessage({ type: 'box_error', requestId: request, message: 'synthetic old error' });
  assert.equal(c.luckyBox._spinPendingRequestId, 'synthetic-spin-b');
  assert.equal(c.state.wheelSpinning, true); assert.deepEqual(f.animations, [100]);
  f.timers[1]();
  assert.equal(c.state.wheelSpinning, true, 'old action timer cannot release a newer action');
});

test('D020 an earlier attempt timeout cannot release an in-flight retry of the same action', async () => {
  const f = await fixture(), c = f.context;
  c.spinWheel(); const request = f.sent.at(-1).requestId;
  c.secureHandleSocketMessage({ type: 'box_error', requestId: request, message: 'synthetic retryable error' });
  assert.equal(c.state.wheelSpinning, false);
  c.spinWheel(); assert.equal(f.sent.at(-1).requestId, request);
  f.timers[0]();
  assert.equal(c.state.wheelSpinning, true);
  assert.equal(c.luckyBox._spinPendingRequestId, request);
  f.timers[1]();
  assert.equal(c.state.wheelSpinning, false);
  assert.equal(c.luckyBox._spinPendingRequestId, null);
});
