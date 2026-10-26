'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');

const source=readFileSync('src/worker/http.mjs','utf8');

test('Slip2Go provider requests use Bearer authentication, never a raw API secret header',()=>{
  assert.match(source,/https:\/\/connect\.slip2go\.com\/api\//);
  assert.match(source,/'Authorization':\s*\`Bearer \$\{env\.SLIP2GO_API_SECRET\}\`/);
  assert.doesNotMatch(source,/'Authorization':\s*env\.SLIP2GO_API_SECRET/);
});
