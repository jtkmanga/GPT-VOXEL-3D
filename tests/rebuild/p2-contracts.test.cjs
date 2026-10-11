'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { ROOT, moduleGraph, walk } = require('../../scripts/rebuild/source-view.cjs');
const { wireInventory } = require('./wire-inventory.cjs');
const { createHarness } = require('./harness.cjs');

test('P2 active client and Worker retain the baseline 28-type canonical wire vocabulary', async () => {
  const protocol = await import(pathToFileURL(path.join(ROOT, 'src/shared/protocol.mjs')));
  const baseline = execFileSync('git', ['show', '0acbdf43a94c9c228e07957cf2828c1c99a6e83a:worker.js'], { encoding: 'utf8' });
  const html = execFileSync('git', ['show', '0acbdf43a94c9c228e07957cf2828c1c99a6e83a:index.html'], { encoding: 'utf8' });
  const original = [...wireInventory(baseline, { sourceType: 'module' }),
    ...wireInventory([...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].at(-1)[1])];
  const vocabulary = [...new Set(original.map(ref => ref.value))].sort();
  assert.equal(vocabulary.length, 28);
  assert.deepEqual(Object.values(protocol.WS_MESSAGE).sort(), vocabulary);
  const entry = await import(pathToFileURL(path.join(ROOT, 'src/client/entry.mjs')));
  const client = entry.CLIENT_SOURCES.map(file => fs.readFileSync(path.join(ROOT, 'src/client', file), 'utf8')).join('');
  const graph = moduleGraph();
  const authored = [...graph.filter(module => module.file.includes('/src/worker/')).flatMap(module =>
    wireInventory(module.source, { sourceType: 'module', messages: protocol.WS_MESSAGE })),
  ...wireInventory(client, { messages: protocol.WS_MESSAGE })];
  assert.ok(authored.every(ref => ref.key && protocol.WS_MESSAGE[ref.key] === ref.value));
  assert.deepEqual([...new Set(authored.map(ref => ref.value))].sort(), vocabulary);
  for (const value of vocabulary) for (const role of ['send', 'dispatch']) {
    if (original.some(ref => ref.value === value && ref.role === role)) {
      assert.ok(authored.some(ref => ref.value === value && ref.role === role),
        `Retain baseline ${role} contract for ${value}`);
    }
  }
  for (const module of graph) walk(module.ast, node => {
    if (node.type === 'VariableDeclarator' && ['WS_MESSAGE', 'PROTOCOL_VERSION'].includes(node.id.name)) {
      assert.equal(path.relative(ROOT, module.file), 'src/shared/protocol.mjs');
    }
    if (node.type === 'Property' && (node.key.name ?? node.key.value) === 'type' && node.value.type === 'Literal') {
      assert.ok(!vocabulary.includes(node.value.value), 'Worker must import the canonical discriminator');
    }
  });
  console.log(`PASS active P2 vocabulary: ${vocabulary.length} canonical types, ${authored.length} shared references`);
});

test('P2 all four room close/error paths retain observable leave and release semantics', async t => {
  // P1 authored four leave packets. P2 factors them into two cleanup methods;
  // packet-site counts are not lifecycle coverage. Exercise every actual path.
  for (const zone of [undefined, '4,4']) for (const event of ['webSocketClose', 'webSocketError']) {
    const h = createHarness();
    t.after(() => h.close());
    const uid = `synthetic-p2-cleanup-${zone ?? 'room'}-${event}`;
    const source = await h.connect({ uid, zone });
    const peer = await h.connect({ uid: `${uid}-peer`, zone });
    peer.clear();
    await source.instance[event](source.server);
    await h.settle();
    assert.equal(source.client.closeInfo.code, event === 'webSocketClose' ? 1000 : 1011);
    assert.equal(peer.messages('leave').length, 1);
    assert.equal(peer.messages('leave')[0].id, source.attachment().id);
    assert.equal(h.room().sql.exec('SELECT lease_expires FROM voxel_sessions WHERE uid=?', uid).toArray()[0].lease_expires, 0);
    await source.instance.webSocketClose(source.server);
    await source.instance.webSocketError(source.server);
    await h.settle();
    assert.equal(peer.messages('leave').length, 1, 'Delayed cleanup cannot duplicate leave');
  }
});

test('P2 reconstruction restores original socket authentication deadlines', async t => {
  const h = createHarness();
  t.after(() => h.close());
  const connections = [await h.open(), await h.open('/play?zone=4,4')];
  await h.advance(6000);
  const scheduled = [];
  const originalTimer = h.context.setTimeout;
  h.context.setTimeout = (callback, delay) => {
    scheduled.push(delay);
    return originalTimer(callback, delay);
  };
  h.restartRoom({ keepSockets: true });
  const entry = h.env.ZONE.object('free-zone-4,4');
  entry.instance = new h.runtime.ZoneRoom(entry.ctx, h.env);
  assert.deepEqual(scheduled, [4000, 4000], 'Each reconstructed owner schedules only the remaining deadline');
  await h.advance(3999);
  for (const connection of connections) assert.equal(connection.client.closed, false);
  await h.advance(1);
  for (const connection of connections) {
    assert.equal(connection.client.closeInfo.code, 1008);
    assert.equal(connection.messages('welcome').length, 0);
  }
});

test('P2 native entrypoints and public production configuration remain compatible', async () => {
  const module = await import(pathToFileURL(path.join(ROOT, 'worker.js')));
  assert.equal(typeof module.default.fetch, 'function');
  assert.equal(typeof module.GameRoom, 'function');
  assert.equal(typeof module.ZoneRoom, 'function');
  assert.equal(typeof module.verifyFirebaseIdToken, 'function');
  for (const file of ['worker.js', 'wrangler.jsonc', 'src/shared/config.mjs', 'src/shared/catalog.mjs', 'src/shared/protocol.mjs']) {
    const original = execFileSync('git', ['show', `10dfaf0aff07d2896c50af06d88502166b16fe9e:${file}`], { encoding: 'utf8' });
    assert.equal(fs.readFileSync(file, 'utf8'), original, `${file} external contract remains unchanged in P2`);
  }
});
