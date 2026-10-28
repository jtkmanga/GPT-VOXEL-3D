'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

function paymentModal(html){
  const from=html.indexOf('id="payment-modal"');
  const to=html.indexOf('<!-- EXIT CONFIRMATION MODAL -->',from);
  assert.ok(from>=0&&to>from,'payment modal boundaries must exist');
  return html.slice(from,to);
}
test('source payment modal does not reveal personally identifying receiver labels or references',()=>{
  const template=fs.readFileSync('src/client/index.template.html','utf8');
  const html=paymentModal(template);
  assert.match(html,/id="payment-account-info"/);
  assert.match(html,/ร้านค้า:/);
  assert.match(html,/Lucky Game/);
  assert.match(html,/ตรวจสอบชื่อผู้รับ/);
  assert.doesNotMatch(html,/ชื่อบัญชี:\s*<span|เลขที่อ้างอิง:\s*<span/);
  assert.doesNotMatch(html,/\b\d{12,16}\b/);
});
test('generated public page retains privacy-safe payment modal and no legacy literal recipient',()=>{
  const generated=fs.readFileSync('index.html','utf8');
  const html=paymentModal(generated);
  assert.match(html,/id="payment-account-info"/);
  assert.match(html,/ร้านค้า:/);
  assert.doesNotMatch(html,/ชื่อบัญชี:\s*<span|เลขที่อ้างอิง:\s*<span/);
  assert.doesNotMatch(html,/\b\d{12,16}\b/);
});
test('browser does not display provider legal recipient name',()=>{
  const source=fs.readFileSync('src/client/secure-entitlements-payment.js','utf8');
  assert.match(source,/result\.merchantName !== 'Lucky Game'/);
  assert.doesNotMatch(source,/result\.accountName/);
  assert.match(source,/ตรวจสอบชื่อผู้รับจริงในแอปธนาคาร/);
});
test('Worker QR responses expose merchant label without actual recipient data',()=>{
  const source=fs.readFileSync('src/worker/http.mjs','utf8');
  assert.match(source,/merchantName:'Lucky Game'/);
  assert.doesNotMatch(source,/accountName:cacheClaim\.accountName\|\|receiver\.accountName/);
  assert.match(source,/accountName:receiver\.accountName|accountName,\s*expiresAt:/);
});
