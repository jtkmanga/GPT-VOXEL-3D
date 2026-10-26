'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');

const source=readFileSync('src/worker/http.mjs','utf8');

test('Slip2Go QR and slip verification both use Bearer API authentication',()=>{
  assert.match(source,/https:\/\/connect\.slip2go\.com\/api\/qr-payment\/generate-qr-image-link/);
  assert.match(source,/https:\/\/connect\.slip2go\.com\/api\/verify-slip\/qr-image\/info/);
  const bearerHeaders=source.match(/'Authorization':\s*\`Bearer \$\{env\.SLIP2GO_API_SECRET\}\`/g)||[];
  assert.equal(bearerHeaders.length,2);
  assert.doesNotMatch(source,/'Authorization':\s*env\.SLIP2GO_API_SECRET/);
  assert.doesNotMatch(source,/'Authorization':env\.SLIP2GO_API_SECRET/);
});
