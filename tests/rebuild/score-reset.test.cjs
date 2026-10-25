'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

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


test('both staging and production configs run the Bangkok-midnight cron',()=>{
  for(const file of ['wrangler.staging.jsonc','wrangler.jsonc']){
    const config=JSON.parse(fs.readFileSync(path.join(__dirname,'../..',file),'utf8'));
    assert.deepEqual(config.triggers?.crons,['0 17 * * *'],file+' must run daily at 17:00 UTC / midnight Bangkok');
  }
});

test('next reset times remain automatic after a manual reset moment',async()=>{
  const {nextScoreResetAt}=await import('../../src/worker/score-reset.mjs');
  const mondayMorning=Date.parse('2026-10-25T23:40:00Z'); // 06:40 Monday Bangkok
  assert.equal(new Date(nextScoreResetAt(mondayMorning,'vip1')).toISOString(),'2026-10-26T17:00:00.000Z');
  assert.equal(new Date(nextScoreResetAt(mondayMorning,'free1')).toISOString(),'2026-10-31T17:00:00.000Z');
});
