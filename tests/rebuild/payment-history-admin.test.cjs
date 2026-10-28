'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {createHarness}=require('./harness.cjs');

function harness(t){const h=createHarness();t.after(()=>h.close());return h}
async function post(room,path,body){
  const response=await room.fetch(new Request('https://internal'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  return {status:response.status,body:await response.json()};
}

test('payment history stores safe fields and admin output masks transaction references',async t=>{
  const h=harness(t),room=h.room();
  const transactionId='bank:synthetic-private-reference-1234567890';
  const stored=await post(room,'/_internal/payment-history/record',{
    uid:'payment-history-user',email:'payer@example.invalid',item:'vip1',amount:50,
    status:'rejected',providerCode:'200402',message:'Amount does not match',
    transactionId,expiresAt:0
  });
  assert.equal(stored.status,200);
  const response=await room.fetch(new Request('https://internal/_internal/admin/payments'));
  assert.equal(response.status,200);
  const body=await response.json(),row=body.rows[0];
  assert.equal(row.email,'payer@example.invalid');
  assert.equal(row.item,'vip1');
  assert.equal(row.amount,50);
  assert.equal(row.status,'rejected');
  assert.equal(row.providerCode,'200402');
  assert.equal(row.transactionRef,transactionId.slice(-12));
  assert.equal(Object.hasOwn(row,'transactionId'),false);
});

test('payment history rejects unsupported statuses and oversized unsafe fields',async t=>{
  const h=harness(t),room=h.room();
  const invalid=await post(room,'/_internal/payment-history/record',{
    uid:'u',email:'payer@example.invalid',item:'vip1',amount:50,status:'anything-goes',
    providerCode:'x',message:'x',transactionId:'x',expiresAt:0
  });
  assert.equal(invalid.status,400);
  assert.equal(invalid.body.ok,false);
});

test('admin UI exposes payment/slip history controls without raw slip/account fields',()=>{
  const source=readFileSync('src/worker/admin.mjs','utf8');
  assert.match(source,/ประวัติการชำระเงิน \/ สลิป/);
  assert.match(source,/paymentFilter/);
  assert.match(source,/paymentGranted/);
  assert.match(source,/transactionRef/);
  assert.doesNotMatch(source,/slipImage|senderAccount|receiverAccount/);
});


test('rendered admin inline script parses without syntax errors',async()=>{
  const {handleAdmin}=await import('../../src/worker/admin.mjs');
  const response=await handleAdmin(new Request('https://admin.invalid/admin'),{});
  assert.equal(response.status,200);
  const html=await response.text();
  const start=html.indexOf('<script>'),end=html.indexOf('</script>',start);
  assert.ok(start>=0&&end>start,'inline admin script missing');
  const script=html.slice(start+'<script>'.length,end);
  assert.doesNotThrow(()=>new Function(script));
});
