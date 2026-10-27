'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');

const sessionScaleConfig = {
  workerOrigin: 'https://gpt-voxel-3d-staging-session-scale.invalid',
  defaultTokenProject: 'session-scale-staging-fixture',
  env: {
    APP_ENV: 'staging',
    STAGING_WORKER_NAME: 'gpt-voxel-3d-staging-session-scale',
    STAGING_WORKER_ORIGIN: 'https://gpt-voxel-3d-staging-session-scale.invalid',
    ALLOWED_ORIGIN: 'https://gpt-voxel-3d-staging-session-scale.invalid',
    FIREBASE_PROJECT_ID: 'session-scale-staging-fixture',
    FIREBASE_PUBLIC_CONFIG: JSON.stringify({
      apiKey: 'synthetic-public-staging-key',
      authDomain: 'session-scale-staging-fixture.firebaseapp.com',
      projectId: 'session-scale-staging-fixture',
      appId: '1:123456:web:abcdef123456'
    }),
    FIREBASE_APP_CHECK_SITE_KEY: '6L' + 'A'.repeat(38),
    STAGING_AUTH_MODE: 'popup',
    PAYMENT_MODE: 'provider-neutral-test'
  }
};

const idle = { x: 0, z: 0, jump: false };
const packet = seq => ({
  type: 'move',
  seq,
  input: idle,
  frames: [{ input: idle, delta: .1 }]
});

test('Zone movement uses local lease between staggered coordinator checkpoints', async t => {
  const h = createHarness(sessionScaleConfig);
  t.after(() => h.close());
  const connection = await h.open('/play?server=free1&zone=5,5');
  await connection.send({
    type: 'auth',
    token: h.token('synthetic-session-scale'),
    protocol: 6,
    continuousHandoff: true
  });
  assert.ok(connection.messages('welcome').at(-1));

  const calls = [];
  const original = connection.instance.sessionCall.bind(connection.instance);
  connection.instance.sessionCall = async (action, payload) => {
    calls.push(action);
    return original(action, payload);
  };

  for (let seq = 0; seq < 50; seq++) {
    await h.advance(200);
    await connection.send(packet(seq));
  }

  assert.equal(connection.client.closed, false);
  assert.equal(connection.messages('move').length, 50);
  assert.equal(calls.filter(action => action === 'validate').length, 0,
    'ordinary Zone movement must not round-trip through the global coordinator per frame');
  assert.equal(calls.filter(action => action === 'checkpoint').length, 0,
    'the first ten seconds remain inside the local session lease');

  await h.advance(46_000);
  await connection.send(packet(50));
  assert.equal(connection.client.closed, false);
  assert.equal(calls.filter(action => action === 'validate').length, 0);
  assert.equal(calls.filter(action => action === 'checkpoint').length, 1,
    'a bounded heartbeat renews and persists the authoritative session');

  calls.length = 0;
  await connection.send({ type: 'collect_box', seq: 51 });
  assert.equal(calls.filter(action => action === 'validate').length, 1,
    'economy mutations retain the strict coordinator ownership fence');
  assert.equal(calls.filter(action => action === 'checkpoint').length, 1,
    'economy mutations remain durably checkpointed');

  calls.length = 0;
  await h.advance(200);
  await connection.send(packet(52));
  assert.equal(calls.filter(action => action === 'validate').length, 0);
  assert.equal(calls.filter(action => action === 'checkpoint').length, 0);

  await connection.close();
  assert.equal(calls.filter(action => action === 'checkpoint').length, 1,
    'disconnect persists the latest batched movement before release');
  assert.equal(calls.filter(action => action === 'release').length, 1);
});

test('replacement still revokes the exact old Zone generation before it can keep moving', async t => {
  const h = createHarness(sessionScaleConfig);
  t.after(() => h.close());
  const uid='synthetic-session-replacement-scale';
  const first = await h.open('/play?server=free1&zone=5,5');
  await first.send({ type:'auth', token:h.token(uid), protocol:6, continuousHandoff:true });
  assert.ok(first.messages('welcome').at(-1));

  const second = await h.open('/play?server=free1&zone=5,5');
  await second.send({ type:'auth', token:h.token(uid), protocol:6, continuousHandoff:true });
  assert.ok(second.messages('welcome').at(-1));
  assert.equal(first.client.closed, true);
  assert.equal(first.client.closeInfo?.code, 1008);
  assert.equal(first.client.closeInfo?.reason, 'Session replaced');

  await h.advance(200);
  await second.send(packet(0));
  assert.equal(second.client.closed, false);
  assert.ok(second.messages('move').at(-1));
});
