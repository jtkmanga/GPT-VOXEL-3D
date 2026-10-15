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

for (const committed of [false, true]) {
  test(`D022 pending spin survives local resume with ${committed ? 'committed reward' : 'active claim'} snapshot`, async () => {
    const f = await fixture(), c = f.context, elements = new Map();
    c.document.getElementById = id => {
      if (!elements.has(id)) {
        const classes = new Set();
        elements.set(id, { style: {}, innerText: '', classList: {
          add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name)
        } });
      }
      return elements.get(id);
    };
    c.drawLuckyWheel = () => {}; c.audio.playBoxHit = () => {};
    c.updateLeaderboardUI = () => {};
    Object.assign(c.luckyBox, { mesh: { visible: false, position: { set() {} } }, spawnCycle: 1,
      nextSpawnTimestamp: 0, claimed: true, _claimActionRequestId: 'synthetic-claim-a' });
    c.triggerLuckyBoxModal(); c.spinWheel();
    const request = f.sent.at(-1).requestId, socket = c.secureGameSocket;
    // Transport/authentication are synthetic ports; execute actual resume loop,
    // welcome snapshot processing, modal and retry logic, not a live disconnect.
    c.secureGameReady = false; c.secureGameSocket = null; socket.readyState = 3;
    f.timers[0]();
    assert.equal(c.state.wheelSpinning, false);
    assert.equal(elements.get('btn-spin-wheel').classList.contains('hidden'), false);
    const sentBefore = f.sent.length;
    c.spinWheel(); assert.equal(f.sent.length, sentBefore, 'offline click must not send');
    c.secureRememberSession('5,5', { sessionId: 'synthetic-session', resumeToken: 'synthetic-resume',
      resumeExpiresAt: c.secureNow() + 120000 });
    c.secureClientDelay = async () => {};
    c.secureOpenZoneSocket = async (zone, token, refresh, requireResume) => {
      assert.equal(zone, '5,5'); assert.equal(requireResume, true);
      socket.readyState = 1; c.secureGameSocket = socket;
      c.secureHandleSocketMessage({ type: 'welcome', zone, id: c.state.serverPlayerId,
        score: committed ? 100 : 0, serverNow: c.secureNow(),
        luckyBox: { cycle: 1, active: false, claimed: !committed,
          claimExpiresAt: committed ? 0 : c.secureNow() + 30000,
          nextSpawnAt: committed ? c.secureNow() + 14400000 : 0 } });
    };
    assert.equal(await c.secureResumeDisconnectedSocket('5,5', c.auth.currentUser.uid), true);
    assert.equal(c.state.isPaused, true);
    assert.equal(elements.get('wheel-modal').classList.contains('hidden'), false);
    assert.equal(c.luckyBox._claimActionRequestId, 'synthetic-claim-a');
    c.spinWheel(); assert.equal(f.sent.at(-1).requestId, request);
    c.secureHandleSocketMessage({ type: 'box_reward', requestId: request,
      receipt: 'synthetic-resumed-receipt', reward: 100, score: 100 });
    assert.deepEqual(f.animations, [100]); assert.equal(c.state.score, 100);
    f.timers.at(-1)();
    assert.equal(c.luckyBox._spinPendingRequestId, null);
    assert.equal(elements.get('btn-spin-wheel').classList.contains('hidden'), true,
      'acknowledged reward must not reopen retry while animation runs');
  });
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
