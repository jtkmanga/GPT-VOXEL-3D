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
  // Internal Durable Object cache retains the verified receiver name.
  // Only the public /payment-qr endpoint redacts it.
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
