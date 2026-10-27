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
