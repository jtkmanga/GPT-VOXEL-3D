'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

// A delayed Durable Object transport is the latency under test. The real
// handler, SQLite transaction, session fencing and event delivery still run.
for (const kind of ['room', 'zone']) {
  test(`P4 actual ${kind} collector receives its committed ACK before delayed zone fanout`, async t => {
    const h = createHarness();
    const releases = [];
    let timeout;
    t.after(async () => {
      clearTimeout(timeout);
      for (const release of releases.splice(0)) release();
      await h.close();
    });
    const coin = h.room().coinSnapshot()[12];
    const zone = `${Math.floor((coin.x + 750) / 150)},${Math.floor((coin.z + 750) / 150)}`;
    const uid = `synthetic-p4-delayed-${kind}`;
    const collector = await h.connect({ uid, ...(kind === 'zone' ? { zone } : {}) });
    const observer = await h.connect({ uid: `synthetic-p4-delayed-observer-${kind}`, zone });
    for (const connection of [collector, observer]) {
      h.place(connection, { x: coin.x, y: 0, z: coin.z, r: 0 });
      connection.clear();
    }
    const getByName = h.env.ZONE.getByName.bind(h.env.ZONE);
    h.env.ZONE.getByName = name => {
      const actual = getByName(name);
      return {
        async fetch(request) {
          const event = new URL(request.url).pathname === '/_internal/world-event'
            ? await request.clone().json() : null;
          if (event?.type === 'coin_collected')
            return new Promise(resolve => releases.push(() => resolve(actual.fetch(request))));
          return actual.fetch(request);
        }
      };
    };
    const dispatch = collector.instance.webSocketMessage(collector.server,
      JSON.stringify({ type: 'collect', id: coin.id, requestId: `synthetic-delayed-coin-${kind}` }));
    // Do not call connection.send(): it intentionally waits for waitUntil()
    // tasks too and would obscure whether the collector's own ACK is blocked.
    await Promise.race([dispatch, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error('Collector ACK awaited delayed fanout')), 2000);
    })]);
    clearTimeout(timeout);
    assert.ok(releases.length > 0, 'real coin fanout is still waiting on the delayed transport');
    const persisted = h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0];
    assert.equal(persisted.score, 1);
    const ack = kind === 'zone' ? collector.messages('coin_collect_result').at(-1) : collector.messages('score').at(-1);
    assert.ok(ack, 'the collector observes a successful committed ACK while fanout is pending');
    assert.equal(ack.score, 1);
    if (kind === 'zone') assert.equal(ack.collected, true);
    assert.equal(observer.messages('coin_collected').length, 0, 'the transport actually delays observer delivery');
    for (const release of releases.splice(0)) release();
    await h.settle();
    const delivered = observer.messages('coin_collected').find(event => event.id === coin.id);
    assert.ok(delivered, 'the original authoritative event arrives after transport recovers');
    assert.equal(delivered.respawnAt, h.now() + 60_000);
    assert.equal(delivered.cycle, 1);
    assert.equal(h.room().sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0].score, 1);
  });
}
