'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {stagingClientFixture}=require('./staging-client-fixture.cjs');

test('production prediction discards the pre-reset render delta exactly like staging',async()=>{
  const f=await stagingClientFixture({includeStagingRuntime:false,serverId:'free1'});
  const c=f.context;
  c.keys.d=true;
  c.secureResetPrediction({x:0,y:0,z:0,r:0},{vx:0,vy:0,vz:0,grounded:true,jumpHeld:false,lastSeq:-1});
  c.securePredictMovement(.1);
  let frames=f.read('securePendingFrames');
  assert.equal(frames.length,1);
  assert.equal(frames[0].delta,0);
  c.securePredictMovement(.1);
  frames=f.read('securePendingFrames');
  assert.equal(frames.length,2);
  assert.equal(frames[1].delta,.1);
});

test('production high-FPS prediction keeps Staging-style ordered batches bounded',async()=>{
  const f=await stagingClientFixture({includeStagingRuntime:false,serverId:'free1'});
  const c=f.context;
  c.keys.d=true;
  c.secureResetPrediction({x:0,y:0,z:0,r:0},{vx:0,vy:0,vz:0,grounded:true,jumpHeld:false,lastSeq:-1});
  for(let i=0;i<360;i++){
    f.advance(1000/360);
    c.securePredictMovement(1/360);
  }
  const moves=f.sent.filter(packet=>packet.type==='move');
  assert.ok(moves.length>=6,`expected bounded high-FPS flushes, got ${moves.length}`);
  for(const packet of moves){
    assert.ok(packet.frames.length<=63);
    assert.ok(packet.frames.reduce((sum,frame)=>sum+frame.delta,0)<=.5+1e-9);
    assert.equal(f.movement.validMovementFrames(packet.frames),true);
  }
});


test('production visual reconciliation smooths a valid one-batch correction instead of hard-snapping',async()=>{
  const f=await stagingClientFixture({includeStagingRuntime:false,serverId:'free1'});
  const c=f.context;
  c.secureResetPrediction({x:0,y:0,z:0,r:0},{vx:0,vy:0,vz:0,grounded:true,jumpHeld:false,lastSeq:-1});
  c.keys.d=true;
  c.securePredictMovement(0);
  f.advance(100);
  c.securePredictMovement(.1);
  assert.equal(c.syncMyPlayerData(true),true);
  const before=f.state();
  const authoritative={x:before.x-5,y:before.y,z:before.z,r:before.r};
  assert.equal(c.secureReconcileMovement({
    type:'move',applied:true,ack:0,player:authoritative,
    movement:{vx:0,vy:0,vz:0,grounded:true,jumpHeld:false,lastSeq:0}
  }),true);
  const correction=f.read('securePredictionCorrection');
  assert.ok(correction.x>4.9 && correction.x<5.1,
    'a 5-unit valid batch correction should be visually damped instead of snapped');
});
