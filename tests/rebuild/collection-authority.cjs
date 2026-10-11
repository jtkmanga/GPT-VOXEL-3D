'use strict';
// P3 replaces client contact coordinates with server movement authority. These
// tests exercise the active packet emitter and both actual authoritative rooms.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const acorn = require('acorn');
const { createHarness } = require('./harness.cjs');

test('client coin contact emits only its resource identifier and cannot author position or score', () => {
  const html = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
  const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].at(-1)[1];
  const ast = acorn.parse(source, { ecmaVersion: 'latest' });
  const node = ast.body.find(item => item.type === 'ExpressionStatement' &&
    item.expression.type === 'AssignmentExpression' && item.expression.left.name === 'collectCoin');
  assert.ok(node, 'Actual secure collect override exists');
  const packets = [], timers = [];
  const context = vm.createContext({
    Date: { now: () => 100_000 }, WebSocket: { OPEN: 1 },
    secureHandoffInProgress: false, secureGameReady: true,
    secureGameSocket: { readyState: 1, send: raw => packets.push(JSON.parse(raw)) },
    state: { score: 17 }, playerPos: { x: 1000, y: 8, z: -1000 },
    playerRotation: 2, setTimeout: (fn, delay) => timers.push({ fn, delay })
  });
  vm.runInContext(source.slice(node.start, node.end), context);
  const coin = { serverId: 0, active: true, mesh: { visible: true } };
  context.collectCoin(coin);
  assert.deepEqual(packets, [{ type: 'collect', id: 0 }]);
  assert.equal(coin.active, false);
  assert.equal(coin.mesh.visible, false);
  assert.equal(context.state.score, 17);
  context.collectCoin(coin);
  assert.equal(packets.length, 1, 'Visual prediction cannot duplicate an in-flight action');
  assert.equal(timers[0].delay, 2700);
  timers[0].fn();
  assert.equal(coin.active, true, 'Missing authoritative acknowledgement restores the visual coin');
});

for (const zone of [undefined, '4,4']) {
  test(`actual ${zone ? 'ZoneRoom' : 'GameRoom'} collection ignores client position and uses persisted server score`, async t => {
    const h = createHarness();
    t.after(() => h.close());
    const uid = `synthetic-p3-collection-${zone ?? 'room'}`;
    const player = await h.connect({ uid, zone });
    const coin = h.room().coinSnapshot().find(item =>
      Math.hypot(item.x - player.attachment().x, item.z - player.attachment().z) > 10);
    const before = player.attachment();
    await player.send({ type: 'collect', id: coin.id, x: coin.x, y: 0, z: coin.z, r: 0 });
    for (const key of ['x', 'y', 'z', 'r']) assert.equal(player.attachment()[key], before[key]);
    assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, 0);
    assert.equal(h.room().coinSnapshot()[coin.id].respawnAt, 0);
    h.place(player, { x: coin.x, y: 0, z: coin.z, r: 0 });
    await h.advance(200);
    await player.send({ type: 'collect', id: coin.id });
    assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, 1);
    assert.equal(h.room().coinSnapshot()[coin.id].respawnAt, h.now() + 60_000);
    assert.equal(h.room().coinSnapshot().length, 200);
  });
}
