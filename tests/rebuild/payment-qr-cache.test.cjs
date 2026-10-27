'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness}=require('./harness.cjs');

function harness(t,options) {
  const h=createHarness(options);
  t.after(()=>h.close());
  return h;
}

async function post(room,path,body) {
  const response=await room.fetch(new Request('https://internal'+path,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  }));
  return {status:response.status,body:await response.json()};
}

test('payment QR cache serializes first generation, reuses fresh links and expires safely',async t=>{
  const h=harness(t), room=h.room(), key='a'.repeat(64), amount=50;

  const first=await post(room,'/_internal/payment-qr-cache/claim',{key,amount});
  assert.equal(first.status,200);
  assert.equal(first.body.state,'lease');

  const concurrent=await post(room,'/_internal/payment-qr-cache/claim',{key,amount});
  assert.equal(concurrent.status,200);
  assert.equal(concurrent.body.state,'pending');

  const expiresAt=h.now()+20*60*60*1000;
  const stored=await post(room,'/_internal/payment-qr-cache/store',{
    key,amount,accountName:'Lucky Game',
    qrImageUrl:'https://example.invalid/payment-qr.png',
    expiresAt
  });
  assert.equal(stored.status,200);
  assert.equal(stored.body.ok,true);

  const hit=await post(room,'/_internal/payment-qr-cache/claim',{key,amount});
  assert.equal(hit.body.state,'hit');
  assert.equal(hit.body.qrImageUrl,'https://example.invalid/payment-qr.png');
  assert.equal(hit.body.accountName,'Lucky Game');
  assert.equal(hit.body.amount,50);
  assert.equal(hit.body.expiresAt,expiresAt);

  await h.advance(20*60*60*1000);
  const expired=await post(room,'/_internal/payment-qr-cache/claim',{key,amount});
  assert.equal(expired.body.state,'lease');
});

test('payment QR cache rejects unsafe entries and releases a failed generation lease',async t=>{
  const h=harness(t), room=h.room(), key='b'.repeat(64), amount=20;
  const first=await post(room,'/_internal/payment-qr-cache/claim',{key,amount});
  assert.equal(first.body.state,'lease');

  const bad=await post(room,'/_internal/payment-qr-cache/store',{
    key,amount,accountName:'Lucky Game',
    qrImageUrl:'http://example.invalid/not-https.png',
    expiresAt:h.now()+20*60*60*1000
  });
  assert.equal(bad.status,400);

  const released=await post(room,'/_internal/payment-qr-cache/release',{key});
  assert.equal(released.status,200);

  const retry=await post(room,'/_internal/payment-qr-cache/claim',{key,amount});
  assert.equal(retry.body.state,'lease');
});


const {SLIP_QR_URL}=require('./harness.cjs');

function qrHeaders(h,uid='qr-cache-user') {
  return {
    'content-type':'application/json',
    'Authorization':'Bearer '+h.token(uid),
    'X-Firebase-AppCheck':h.appCheckToken()
  };
}

async function requestVipQr(h,uid='qr-cache-user') {
  return h.request('/payment-qr',{
    method:'POST',
    headers:qrHeaders(h,uid),
    body:JSON.stringify({item:'vip1'})
  });
}

test('payment QR endpoint calls Slip2Go once for repeated opens, then refreshes after cache TTL',async t=>{
  const h=harness(t);

  const first=await requestVipQr(h);
  assert.equal(first.status,200);
  const firstBody=await first.json();
  assert.equal(firstBody.ok,true);
  assert.equal(firstBody.price,50);
  assert.equal(firstBody.qrImageUrl,'https://cdn.synthetic.invalid/promptpay-qr.jpg');
  assert.equal(h.records.fetches.filter(row=>row.url===SLIP_QR_URL).length,1);

  const second=await requestVipQr(h);
  assert.equal(second.status,200);
  const secondBody=await second.json();
  assert.equal(secondBody.qrImageUrl,firstBody.qrImageUrl);
  assert.equal(h.records.fetches.filter(row=>row.url===SLIP_QR_URL).length,1);

  await h.advance(20*60*60*1000);
  const refreshed=await requestVipQr(h);
  assert.equal(refreshed.status,200);
  assert.equal(h.records.fetches.filter(row=>row.url===SLIP_QR_URL).length,2);
});
