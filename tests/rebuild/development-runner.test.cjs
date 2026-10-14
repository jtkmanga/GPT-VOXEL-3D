'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSteps, STEPS } = require('../../scripts/rebuild/verify-development.cjs');

test('development verification requires all checks to succeed', () => {
  const calls = [];
  const result = runSteps((args, name) => { calls.push(name); return { status: 0 }; });
  assert.equal(result.passed, true);
  assert.deepEqual(calls, STEPS.map(step => step[0]));
});

for (const failure of [{ status: 1 }, { status: null, signal: 'SIGTERM' },
  { status: null, error: { code: 'ETIMEDOUT' } }, { status: null }]) {
  test(`development verification stops after ${JSON.stringify(failure)}`, () => {
    let calls = 0;
    const result = runSteps(() => ++calls === 2 ? failure : { status: 0 });
    assert.equal(calls, 2);
    assert.equal(result.passed, false);
    assert.equal(result.results[1].passed, false);
  });
}
