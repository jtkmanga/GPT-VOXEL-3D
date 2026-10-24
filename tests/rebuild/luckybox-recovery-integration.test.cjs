'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const acorn = require('acorn');
const { createHarness } = require('./harness.cjs');
const { stagingClientFixture } = require('./staging-client-fixture.cjs');
const last = (connection, type) => connection.messages(type).at(-1);

for (const mode of ['owned', 'competing', 'expired']) {
  const competing = mode === 'competing';
  test(`client claim recovery against Worker: ${mode}`, async t => {
    const h = createHarness(); t.after(() => h.close());
    const uid = 'synthetic-staging-client';
    async function login(id) {
      const socket = await h.open('/play');
      await socket.send({ type: 'auth', protocol: 4, token: h.token(id) });
      assert.ok(last(socket, 'welcome')); return socket;
    }
    let connection = await login(uid);
    const f = await stagingClientFixture({ now: h.now(), send: packet => connection.send(packet) });
    const c = f.context, elements = new Map();
    c.document.getElementById = id => {
      if (!elements.has(id)) {
        const classes = new Set(['hidden']);
        elements.set(id, { style: {}, innerText: '', classList: {
          add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name)
        } });
      }
      return elements.get(id);
    };
    c.drawLuckyWheel = () => {}; c.audio.playBoxHit = () => {};
    c.updateLeaderboardUI = () => {};
    c.luckyBox = { mesh: { visible: true, position: { set() {} } }, spawnCycle: 0, nextSpawnTimestamp: 0 };
    c.secureApplyLuckyBoxState(last(connection, 'welcome').luckyBox);
    const box = h.room().boxSnapshot(), position = { x: box.x, y: 0, z: box.z, r: 0 };
    h.place(connection, position);
    if (competing) {
      const rival = await login('synthetic-rival'); h.place(rival, position);
      await rival.send({ type: 'collect_box', requestId: 'synthetic-rival-claim' });
      assert.ok(last(rival, 'box_spin_ready'));
    }
    // Client retains its previously active snapshot; all initial replies are lost.
    c.secureRequestLuckyBoxCollect(); await f.flush();
    const requestId = f.sent.at(-1).requestId;
    assert.ok(last(connection, competing ? 'box_state' : 'box_spin_ready'));
    const row = () => h.room().sql.exec('SELECT * FROM voxel_lucky_box WHERE id=1').toArray()[0];
    const claimed = row(); connection.clear(); await connection.close();
    await h.advance(1000); f.setTime(h.now());
    connection = await login(uid);
    const welcome = last(connection, 'welcome'); connection.clear();
    c.secureHandleSocketMessage(welcome); await f.flush();
    assert.equal(f.sent.length, 2); assert.equal(f.sent[1].requestId, requestId);
    assert.equal(c.state.isPaused, false, 'snapshot is not proof of ownership');
    const reply = last(connection, competing ? 'box_state' : 'box_spin_ready');
    assert.ok(reply); assert.equal(reply.requestId, requestId);
    if (!competing) assert.equal(reply.replayed, true);
    c.secureHandleSocketMessage(reply);
    assert.equal(c.luckyBox._claimPendingRequestId, null);
    assert.equal(c.state.isPaused, !competing);
    if (!competing) assert.equal(elements.get('wheel-modal').classList.contains('hidden'), false);
    else assert.equal(connection.messages('box_spin_ready').length, 0);
    assert.deepEqual(row(), claimed, 'recovery cannot change owner, cycle or cooldown');
    assert.equal(h.room().economy.score(uid), 0, 'claim recovery does not award a spin');
    c.secureRetryPendingBoxClaim(); await f.flush();
    assert.equal(f.sent.length, 2, 'settled recovery must not send again');
    if (mode === 'expired') {
      const timers = [];
      c.setTimeout = fn => timers.push(fn);
      c.console = { warn() {} };
      const source = fs.readFileSync('src/client/wheel-frame.js', 'utf8');
      const close = acorn.parse(source, { ecmaVersion: 'latest' }).body.find(node => node.id?.name === 'closeWheelModal');
      vm.runInContext(source.slice(close.start, close.end), c);
      await h.setTime(claimed.claim_expires_at); f.setTime(h.now());
      connection.clear(); c.spinWheel(); await f.flush();
      const spinId = f.sent.at(-1).requestId;
      const rejection = last(connection, 'box_error');
      assert.equal(rejection?.requestId, spinId);
      assert.equal(rejection.message, 'Lucky Box claim expired');
      assert.equal(connection.messages('box_reward').length, 0);
      // Withhold the genuine Worker reply until the authored retry timeout fires.
      timers[0]();
      assert.equal(c.luckyBox._spinPendingRequestId, null);
      assert.equal(elements.get('btn-close-wheel').classList.contains('hidden'), true);
      for (const message of connection.messages()) c.secureHandleSocketMessage(message);
      assert.equal(elements.get('btn-close-wheel').classList.contains('hidden'), false);
      assert.equal(elements.get('btn-close-wheel').innerText, 'เล่นต่อ');
      assert.equal(elements.get('btn-spin-wheel').classList.contains('hidden'), true);
      assert.equal(c.state.wheelSpinning, false);
      assert.equal(c.state.score, 0); assert.equal(h.room().economy.score(uid), 0);
      assert.equal(row().next_spawn_at, claimed.next_spawn_at);
      assert.equal(row().cycle, claimed.cycle);
      c.closeWheelModal();
      assert.equal(c.state.isPaused, false); assert.equal(c.state.isPlaying, true);
      assert.equal(elements.get('wheel-modal').classList.contains('hidden'), true);
      assert.equal(f.sent.length, 3, 'leaving the modal sends no new economy action');
    }
  });
}
