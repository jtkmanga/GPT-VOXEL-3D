'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');

const httpSource=readFileSync('src/worker/http.mjs','utf8');
const roomSource=readFileSync('src/worker/game-room.mjs','utf8');

test('Slip2Go QR and slip verification both use Bearer API authentication',()=>{
  assert.match(httpSource,/https:\/\/connect\.slip2go\.com\/api\/qr-payment\/generate-qr-image-link/);
  assert.match(httpSource,/https:\/\/connect\.slip2go\.com\/api\/verify-slip\/qr-image\/info/);
  const bearerHeaders=httpSource.match(/'Authorization':\s*\`Bearer \$\{env\.SLIP2GO_API_SECRET\}\`/g)||[];
  assert.equal(bearerHeaders.length,2);
  assert.doesNotMatch(httpSource,/'Authorization':\s*env\.SLIP2GO_API_SECRET/);
  assert.doesNotMatch(httpSource,/'Authorization':env\.SLIP2GO_API_SECRET/);
});

test('Slip verification accepts documented Slip2Go success codes only',()=>{
  assert.match(httpSource,/\['200000', '200200'\]\.includes\(String\(result\?\.code \|\| ''\)\)/);
  assert.doesNotMatch(httpSource,/String\(result\?\.code[^\n]*startsWith\(['"]2/);
});

test('Slip verification keeps receiver and amount checks without provider-global duplicate state',()=>{
  assert.match(httpSource,/checkReceiver\s*:/);
  assert.match(httpSource,/checkAmount\s*:/);
  assert.doesNotMatch(httpSource,/checkDuplicate\s*:/);
  assert.match(httpSource,/transactionId/);
  assert.match(roomSource,/transaction_id TEXT PRIMARY KEY/);
  assert.match(roomSource,/voxel_payments WHERE transaction_id/);
});
