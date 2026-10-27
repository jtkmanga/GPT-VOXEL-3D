'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {stagingClientFixture}=require('./staging-client-fixture.cjs');

test('production Free Server keeps prediction and MOVE packets flowing during target Zone warmup',async()=>{
  const f=await stagingClientFixture({includeStagingRuntime:false,serverId:'free1'});
  const c=f.context, source=c.secureGameSocket;
  assert.equal(c.secureUseContinuousHandoff('free1'),true);
  assert.equal(c.secureUseContinuousHandoff('vip1'),false);
  const operation=c.secureStartHandoffOperation(source);
  c.secureBeginContinuousHandoff(operation,{continuousHandoff:true},'4,4','5,4');
  c.secureHandoffInProgress=true;
  c.keys.d=true;
  const start=f.state();
  for(let step=0;step<20;step++){
    f.advance(100);
    c.securePredictMovement(.1);
    if(step%2===1) assert.equal(c.syncMyPlayerData(true),true);
  }
  const end=f.state(), moves=f.sent.filter(packet=>packet.type==='move');
  assert.ok(end.x>start.x+10,`movement froze during handoff: start=${start.x}, end=${end.x}`);
  assert.ok(moves.length>=10,`expected source MOVE traffic during warmup, got ${moves.length}`);
  assert.ok(moves.every(packet=>Array.isArray(packet.frames)&&packet.frames.length>0));
  assert.equal(c.secureContinuousMovementSocket(),source);
});

test('production VIP retains the existing non-continuous handoff behavior',async()=>{
  const f=await stagingClientFixture({includeStagingRuntime:false,serverId:'vip1'});
  const c=f.context, source=c.secureGameSocket;
  assert.equal(c.secureUseContinuousHandoff('vip1'),false);
  const operation=c.secureStartHandoffOperation(source);
  c.secureBeginContinuousHandoff(operation,{continuousHandoff:true},'4,4','5,4');
  c.secureHandoffInProgress=true;
  const before=f.state();
  f.advance(100); c.keys.d=true; c.securePredictMovement(.1);
  assert.deepEqual(f.state(),before);
  assert.equal(c.syncMyPlayerData(true),false);
  assert.equal(c.secureContinuousMovementSocket(),null);
});

test('production source and generated client contain the same continuous handoff route',()=>{
  const socket=readFileSync('src/client/secure-socket-handoff.js','utf8');
  const economy=readFileSync('src/client/secure-menu-economy.js','utf8');
  const html=readFileSync('index.html','utf8');
  for(const source of [socket,html]){
    assert.match(source,/function secureUseContinuousHandoff/);
    assert.match(source,/function secureContinuousMovementSocket/);
    assert.match(source,/function secureApplyContinuousHandoffAck/);
    assert.match(source,/function secureCancelContinuousHandoff/);
  }
  for(const source of [economy,html]){
    assert.match(source,/const socket = typeof secureContinuousMovementSocket/);
    assert.match(source,/socket\.send\(JSON\.stringify\(\{/);
  }
});
