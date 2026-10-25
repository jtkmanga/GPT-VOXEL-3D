'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

async function parse(packet) {
  const { parseFrame } = await import('../../src/worker/security.mjs');
  return parseFrame(JSON.stringify(packet), { security: {} }, 1);
}

test('continuous Zone handoff opt-in accepts only a boolean AUTH field', async () => {
  for (const continuousHandoff of [true, false]) {
    assert.equal((await parse({ type: 'auth', token: 'fixture-token', continuousHandoff })).ok, true);
  }
  assert.equal((await parse({ type: 'auth', token: 'fixture-token' })).ok, true);
  for (const continuousHandoff of [1, 'true', null, {}, []]) {
    const result = await parse({ type: 'auth', token: 'fixture-token', continuousHandoff });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'Invalid handoff mode');
  }
});

test('continuous handoff does not admit client-owned motion state or coordinates', async () => {
  for (const field of ['motion', 'credit', 'clock', 'owner', 'namespace_id', 'x', 'uid', 'score']) {
    assert.equal((await parse({ type: 'auth', token: 'fixture-token', continuousHandoff: true, [field]: 1 })).ok, false);
  }
  for (const field of ['continuousHandoff', 'motion', 'credit', 'x', 'uid']) {
    assert.equal((await parse({ type: 'move', seq: 1, input: { x: 1, z: 0, jump: false }, [field]: true })).ok, false);
  }
  assert.equal((await parse({ type: 'move', seq: 1, input: { x: 1, z: 0, jump: false },
    frames: [{ input: { x: 1, z: 0, jump: false }, delta: .1, credit: .5 }] })).ok, false);
});
