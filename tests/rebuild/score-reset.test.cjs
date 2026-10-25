'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

test('score reset schedule uses Asia/Bangkok midnight', async()=>{
  const {nextScoreResetAt,resetLabel}=await import('../../src/worker/score-reset.mjs');
  const saturdayThai2330=Date.parse('2026-10-24T16:30:00Z'); // 23:30 Saturday Bangkok
  assert.equal(new Date(nextScoreResetAt(saturdayThai2330,'free1')).toISOString(),'2026-10-24T17:00:00.000Z');
  const sundayThai0030=Date.parse('2026-10-24T17:30:00Z');
  assert.equal(new Date(nextScoreResetAt(sundayThai0030,'free1')).toISOString(),'2026-10-31T17:00:00.000Z');
  assert.equal(new Date(nextScoreResetAt(sundayThai0030,'vip1')).toISOString(),'2026-10-25T17:00:00.000Z');
  assert.equal(resetLabel('free1'),'weekly-Sunday-00:00-Asia/Bangkok');
  assert.equal(resetLabel('vip1'),'daily-00:00-Asia/Bangkok');
});
