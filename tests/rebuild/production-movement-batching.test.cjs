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

test('production applies batching in exactly one gameplay wrapper, not inside the base predictor',()=>{
  const socket=readFileSync('src/client/secure-socket-handoff.js','utf8');
  const production=readFileSync('src/client/production-staging-gameplay.js','utf8');
  const start=socket.indexOf('function securePredictMovement(delta)');
  const end=socket.indexOf('function secureResetPrediction',start);
  assert.ok(start>=0&&end>start);
  const predictor=socket.slice(start,end);
  assert.doesNotMatch(predictor,/syncMyPlayerData/);
  assert.doesNotMatch(predictor,/pendingSeconds \+ elapsed/);
  assert.doesNotMatch(predictor,/next\.length >= 48/);
  assert.match(production,/pendingSeconds \+ elapsed > \.5 \+ 1e-9/);
  assert.match(production,/next\.length >= 48/);
  assert.match(production,/>= \.45/);
});
