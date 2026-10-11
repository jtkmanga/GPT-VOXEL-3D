'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const protocol = require('../../src/shared/protocol.mjs');
const config = require('../../src/shared/config.mjs');
function fixture() {
  let now = 1_900_000_000_000;
  const coins = Array.from({ length: 200 }, (_, serverId) => ({ serverId, baseY: .75,
    active: true, respawnTime: 0, serverCycle: 0,
    mesh: { visible: true, position: { x: 0, y: .75, z: 0 } } }));
  const context = vm.createContext({ protocol, config, coins,
    secureNow: () => now, secureSetServerNow: value => { now = Number(value); } });
  for (const file of ['secure-snapshots.js', 'secure-socket-handoff.js'])
    vm.runInContext(fs.readFileSync(`src/client/${file}`, 'utf8'), context, { filename: file });
  return { context, coins, now: () => now };
}
test('P5 actual client applies a complete authoritative handoff coin snapshot in one existing message', () => {
  const f = fixture();
  const snapshot = Array.from({ length: 200 }, (_, id) => ({ id, x: id, z: -id,
    cycle: 3, respawnAt: id === 0 ? f.now() + 60_000 : 0 }));
  f.context.secureHandleSocketMessage({ type: protocol.WS_MESSAGE.COIN_STATE,
    coins: snapshot, serverNow: f.now() });
  assert.equal(f.coins.length, 200);
  assert.equal(f.coins[0].active, false);
  assert.equal(f.coins[0].mesh.visible, false);
  assert.equal(f.coins[0].serverCycle, 3);
  assert.equal(f.coins[199].mesh.position.x, 199);
  assert.equal(f.coins[199].active, true);
});
test('P5 single-resource coin packets retain their original update contract', () => {
  const f = fixture();
  for (const type of [protocol.WS_MESSAGE.COIN_STATE, protocol.WS_MESSAGE.COIN_COLLECTED]) {
    f.context.secureHandleSocketMessage({ type, id: 4, x: 22, z: 33,
      cycle: 1, respawnAt: f.now() + 60_000, serverNow: f.now() });
    assert.equal(f.coins[4].active, false);
    assert.equal(f.coins[4].mesh.position.x, 22);
    assert.equal(f.coins[3].active, true);
  }
});
test('P5 an older snapshot cannot revive a coin already collected during handoff', () => {
  const f = fixture();
  f.context.secureHandleSocketMessage({ type: protocol.WS_MESSAGE.COIN_COLLECTED,
    id: 5, cycle: 3, x: 10, z: 20, respawnAt: f.now() + 60_000, serverNow: f.now() });
  f.context.secureHandleSocketMessage({ type: protocol.WS_MESSAGE.COIN_STATE,
    coins: [{ id: 5, cycle: 2, x: 999, z: 999, respawnAt: 0 }], serverNow: f.now() });
  assert.equal(f.coins[5].serverCycle, 3);
  assert.equal(f.coins[5].active, false);
  assert.equal(f.coins[5].mesh.position.x, 10);
});
