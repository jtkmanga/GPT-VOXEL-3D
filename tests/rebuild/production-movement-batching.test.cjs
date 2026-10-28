'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');

test('default client sends ordered movement frames instead of newest-input-only packets',()=>{
  const socket=readFileSync('src/client/secure-socket-handoff.js','utf8');
  const economy=readFileSync('src/client/secure-menu-economy.js','utf8');
  assert.match(socket,/function secureUnsentMovementFrames\(\)/);
  assert.match(socket,/secureContinuousHandoffPredictionAllowed/);
  assert.match(economy,/const frames = predicted\.length/);
  assert.match(economy,/type:\s*protocol\.WS_MESSAGE\.MOVE,[\s\S]*frames/);
  assert.match(economy,/function secureFlushMovementForPickup\(\)/);
});

test('default prediction bounds unsent batches to the Worker half-second budget',()=>{
  const socket=readFileSync('src/client/secure-socket-handoff.js','utf8');
  assert.match(socket,/pendingSeconds \+ elapsed > \.5 \+ 1e-9/);
  assert.match(socket,/next\.length >= 48/);
  assert.match(socket,/>= \.45/);
});


test('production Free client enables continuous Zone handoff while VIP remains separate',()=>{
  const socket=readFileSync('src/client/secure-socket-handoff.js','utf8');
  const economy=readFileSync('src/client/secure-menu-economy.js','utf8');
  assert.match(socket,/function secureUseContinuousHandoff\(serverId = state\.selectedServerId\)/);
  assert.match(socket,/return serverId === 'free1' && state\.selectedServerId === 'free1'/);
  assert.match(socket,/function secureContinuousMovementSocket\(\)/);
  assert.match(socket,/function secureApplyContinuousHandoffAck\(message\)/);
  assert.match(socket,/async function secureCancelContinuousHandoff\(/);
  assert.match(economy,/secureContinuousMovementSocket/);
  assert.match(economy,/socket\.send\(JSON\.stringify/);
});
