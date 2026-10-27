'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');

const httpSource=readFileSync('src/worker/http.mjs','utf8');
const roomSource=readFileSync('src/worker/game-room.mjs','utf8');

test('Slip2Go provider requests use Bearer authentication, never a raw API secret header',()=>{
  assert.match(httpSource,/https:\/\/connect\.slip2go\.com\/api\//);
  assert.match(httpSource,/'Authorization':\s*\`Bearer \$\{env\.SLIP2GO_API_SECRET\}\`/);
  assert.doesNotMatch(httpSource,/'Authorization':\s*env\.SLIP2GO_API_SECRET/);
});

test('Slip verification keeps receiver and amount checks without provider-global duplicate state',()=>{
  assert.match(httpSource,/checkReceiver\s*:/);
  assert.match(httpSource,/checkAmount\s*:/);
  assert.doesNotMatch(httpSource,/checkDuplicate\s*:/);
  assert.match(httpSource,/transactionId/);
  assert.match(roomSource,/transaction_id TEXT PRIMARY KEY/);
  assert.match(roomSource,/voxel_payments WHERE transaction_id/);
});
