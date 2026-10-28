'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { createHarness, SLIP_URL, SLIP_QR_URL }=require('./slip2go-harness.cjs');

test('Slip2Go receiver config maps PromptPay type and keeps account details server-side',async()=>{
  const {slip2goReceiverConfig,buildSlip2GoQrPayload}=await import('../../src/worker/http.mjs');
  const receiver=slip2goReceiverConfig({PAYMENT_RECEIVER_ACCOUNT:'0999999999'});
  assert.deepEqual(receiver,{
    promptPayType:'phone_number',
    accountType:'02001',
    account:'0999999999',
    accountName:'Lucky Game'
  });
  assert.deepEqual(buildSlip2GoQrPayload({receiver,price:50}),{
    promptPayCode:'0999999999',
    promptPayType:'phone_number',
    accountName:'Lucky Game',
    amount:'50.00'
  });
  assert.throws(()=>slip2goReceiverConfig({PAYMENT_RECEIVER_ACCOUNT:'bad'}),/not configured/);
});

test('payment QR endpoint answers browser CORS preflight',async t=>{
  const h=createHarness({env:{ALLOWED_ORIGIN:'https://jtkmanga.github.io'}});
  t.after(()=>h.close());
  const response=await h.request('/payment-qr',{
    method:'OPTIONS',
    headers:{
      Origin:'https://jtkmanga.github.io',
      'Access-Control-Request-Method':'POST',
      'Access-Control-Request-Headers':'authorization,content-type,x-firebase-appcheck'
    }
  });
  assert.equal(response.status,204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),'https://jtkmanga.github.io');
  assert.match(response.headers.get('Access-Control-Allow-Methods')||'',/POST/);
  const allowHeaders=(response.headers.get('Access-Control-Allow-Headers')||'').toLowerCase();
  for(const name of ['authorization','content-type','x-firebase-appcheck']) assert.ok(allowHeaders.includes(name),name);
});

test('payment QR endpoint fails closed while production payment is disabled',async t=>{
  const h=createHarness({env:{PAYMENT_MODE:'disabled'}});
  t.after(()=>h.close());
  const response=await h.request('/payment-qr',{
    method:'POST',
    headers:{Authorization:'Bearer '+h.token('qr-disabled-user'),'Content-Type':'application/json'},
    body:JSON.stringify({item:'vip1'})
  });
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,'Production payment is disabled');
  assert.equal(h.records.fetches.some(record=>record.url===SLIP_QR_URL),false);
});

test('VIP QR uses authoritative 50 THB server price and Slip2Go secret only on Worker',async t=>{
  const h=createHarness();
  t.after(()=>h.close());
  const uid='slip2go-vip-qr-user';
  const response=await h.request('/payment-qr',{
    method:'POST',
    headers:{Authorization:'Bearer '+h.token(uid),'Content-Type':'application/json'},
    body:JSON.stringify({item:'vip1'})
  });
  assert.equal(response.status,200);
  const result=await response.json();
  assert.deepEqual({
    ok:result.ok,item:result.item,price:result.price,currency:result.currency,
    merchantName:result.merchantName,qrImageUrl:result.qrImageUrl
  },{
    ok:true,item:'vip1',price:50,currency:'THB',
    merchantName:'Lucky Game',qrImageUrl:'https://cdn.synthetic.invalid/promptpay-qr.jpg'
  });
  assert.equal(h.records.fetches.filter(record=>record.url===SLIP_QR_URL).length,1);
});

test('Slip2Go QR provider errors are surfaced safely before QR parsing',async t=>{
  const h=createHarness();
  t.after(()=>h.close());
  h.setSlipQrResult({code:'401007',message:'IP Address not Allowed'},401);
  const response=await h.request('/payment-qr',{
    method:'POST',
    headers:{Authorization:'Bearer '+h.token('qr-provider-error'),'Content-Type':'application/json'},
    body:JSON.stringify({item:'vip1'})
  });
  assert.equal(response.status,502);
  const result=await response.json();
  assert.equal(result.ok,false);
  assert.equal(result.error,'Slip2Go QR error [401007] IP Address not Allowed');
});

test('Slip2Go QR accepts provider display-name normalization but still pins amount and HTTPS',async t=>{
  const h=createHarness();
  t.after(()=>h.close());
  h.setSlipQrResult({code:'200',message:'Success',data:{
    qrImageLink:'https://cdn.synthetic.invalid/promptpay-qr.jpg',
    accountName:'Normalized Receiver Name',
    amount:'50.00'
  }});
  const response=await h.request('/payment-qr',{
    method:'POST',
    headers:{Authorization:'Bearer '+h.token('qr-name-normalized'),'Content-Type':'application/json'},
    body:JSON.stringify({item:'vip1'})
  });
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.ok,true);
  assert.equal(result.price,50);
  assert.equal(result.merchantName,'Lucky Game');
  assert.equal(Object.hasOwn(result,'accountName'),false,'provider personal name must not be returned to browser');
});

test('Slip2Go canary allows only the configured owner account',async t=>{
  const h=createHarness({env:{PAYMENT_ROLLOUT:'canary',ADMIN_OWNER_EMAIL:'owner@example.invalid'}});
  t.after(()=>h.close());
  const requestFor=(uid,email)=>h.request('/payment-qr',{
    method:'POST',
    headers:{Authorization:'Bearer '+h.token(uid,{email}),'Content-Type':'application/json'},
    body:JSON.stringify({item:'vip1'})
  });
  const denied=await requestFor('non-owner','player@example.invalid');
  assert.equal(denied.status,403);
  assert.equal((await denied.json()).error,'Payment canary is restricted');
  const allowed=await requestFor('owner-user','owner@example.invalid');
  assert.equal(allowed.status,200);
  assert.equal((await allowed.json()).ok,true);
});

test('verified VIP slip grants exactly 30 days once and duplicate receipt cannot grant twice',async t=>{
  const h=createHarness();
  t.after(()=>h.close());
  const uid='slip2go-vip-paid-user';
  const token=h.token(uid);
  const makeForm=()=>{
    const form=new FormData();
    form.append('item','vip1');
    form.append('file',new File([new Uint8Array([0x89,0x50,0x4e,0x47])],'vip-slip.png',{type:'image/png'}));
    return form;
  };
  h.setSlipResult({code:'200000',data:{
    amount:50,transRef:'synthetic-vip-slip-001',sender:{bank:{id:'004'}}
  }});
  const first=await h.request('/verify-slip',{
    method:'POST',headers:{Authorization:'Bearer '+token},body:makeForm()
  });
  assert.equal(first.status,200);
  const paid=await first.json();
  assert.equal(paid.ok,true);
  assert.equal(paid.verified,true);
  assert.equal(paid.item,'vip1');
  assert.equal(paid.price,50);
  assert.equal(paid.expiresAt,h.now()+30*24*60*60*1000);

  const second=await h.request('/verify-slip',{
    method:'POST',headers:{Authorization:'Bearer '+token},body:makeForm()
  });
  assert.equal(second.status,409);
  const duplicate=await second.json();
  assert.equal(duplicate.duplicate,true);
  assert.equal(h.room().entitlementSnapshot(uid).vip1Expires,paid.expiresAt);
  assert.equal(h.records.fetches.filter(record=>record.url===SLIP_URL).length,2);
});
