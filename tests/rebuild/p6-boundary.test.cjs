'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHarness } = require('./harness.cjs');
const P5 = '0200876db8a6d26c6ce372264c37bfbdca29262c';

test('P6 saved name is normalized server-side and visible nickname matches persisted leaderboard identity', async t => {
  const h=createHarness(); t.after(()=>h.close());
  const connection=await h.connect({uid:'p6-name-boundary',name:'  A\u202e\u200b B\u0000  '});
  assert.equal(connection.attachment().nickname,'A B');
  assert.equal(h.room().top()[0].nickname,'A B');
  const session=connection.attachment().sessionId;
  await connection.send({type:'auth',token:h.token('p6-name-boundary'),name:'Other player'});
  assert.equal(connection.attachment().sessionId,session);
  assert.equal(connection.attachment().nickname,'A B','refresh cannot change current display identity');
});

test('P6 browser cannot reach trusted save/checkpoint endpoints or mutate saved economy through extra fields', async t => {
  const h=createHarness(); t.after(()=>h.close());
  const c=await h.connect({uid:'p6-save-boundary'}); const before=h.room().sessions.row(c.attachment().uid);
  for(const path of ['/_internal/session/checkpoint','/_internal/session/acquire','/_internal/zone-world-state']) {
    const response=await h.request(path,{method:'POST',body:JSON.stringify({uid:before.uid,sessionId:before.session_id,owner:'room',position:{x:700,y:0,z:700,r:0},score:999999})});
    assert.equal(response.status,404);
  }
  await c.send({type:'move',seq:0,input:{x:0,z:0,jump:false},uid:'other',score:999999,vip:true});
  assert.equal(h.room().economy.score(before.uid),0);
  assert.equal(h.room().sessions.row(before.uid).x,before.x);
});
