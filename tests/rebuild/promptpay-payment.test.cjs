'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');

async function mod(){return import('../../src/worker/twoc2p-promptpay.mjs');}

test('PromptPay token request is server-owned THB PPQR without recurring card fields',async()=>{
  const {buildPromptPayPaymentTokenRequest}=await mod();
  const checkout={merchantID:'MERCHANT01',invoiceNo:'VXP1234567890ABCDE',amount:50,currencyCode:'THB',periodEnd:Date.now()+1000};
  const out=buildPromptPayPaymentTokenRequest(checkout,'MERCHANT01');
  assert.deepEqual(out.paymentChannel,['PPQR']);
  assert.equal(out.amount,50); assert.equal(out.currencyCode,'THB');
  assert.equal(out.backendReturnUrl,'https://voxel-run-v2-demo.hjinffv5426.workers.dev/payments/promptpay/backend');
  for(const forbidden of ['recurring','recurringAmount','chargeOnDate','chargeNextDate','customerToken'])
    assert.equal(Object.hasOwn(out,forbidden),false);
});

test('PromptPay Do Payment pins channelCode PPQR and never accepts client price',async()=>{
  const {buildPromptPayDoPaymentRequest}=await mod();
  const out=buildPromptPayDoPaymentRequest('A'.repeat(32));
  assert.equal(out.payment.code.channelCode,'PPQR');
  assert.equal(out.locale,'th');
  assert.equal(Object.hasOwn(out.payment,'amount'),false);
});

test('PromptPay QR response only accepts bounded HTTPS provider image URLs',async()=>{
  const {validatePromptPayQrResponse}=await mod();
  const good=validatePromptPayQrResponse({respCode:'1005',channelCode:'PPQR',type:'URL',
    data:'https://pgw-static.s3.amazonaws.com/images/qr/example.png',expiryTimer:300000});
  assert.match(good.qrImageUrl,/^https:/); assert.equal(good.expiryTimer,300000);
  for(const data of ['http://pgw.2c2p.com/qr.png','https://evil.example/qr.png','javascript:alert(1)'])
    assert.throws(()=>validatePromptPayQrResponse({respCode:'1005',channelCode:'PPQR',type:'URL',data}),/rejected/);
  assert.throws(()=>validatePromptPayQrResponse({respCode:'1005',channelCode:'CC',type:'URL',
    data:'https://pgw.2c2p.com/qr.png'}),/rejected/);
});

test('PromptPay production config fails closed until all explicit gates and credentials exist',async()=>{
  const {promptPayConfig}=await mod();
  const base={APP_ENV:'production',PAYMENT_MODE:'disabled',ALLOWED_ORIGIN:'https://jtkmanga.github.io',
    FIREBASE_PROJECT_ID:'lucky-game-6936b',ROOM:{},ZONE:{}};
  assert.throws(()=>promptPayConfig(base),/disabled/);
  const enabled={...base,PAYMENT_MODE:'2c2p-promptpay-production',TWOC2P_PROMPTPAY_ENABLED:'true',
    TWOC2P_PROMPTPAY_MERCHANT_CAPABILITIES_VERIFIED:'true',TWOC2P_PROMPTPAY_CHECKOUT_ENABLED:'true',
    TWOC2P_PROMPTPAY_BACKEND_ENABLED:'true',TWOC2P_PRODUCTION_MERCHANT_ID:'MERCHANT01',
    TWOC2P_PRODUCTION_SECRET_KEY:'S'.repeat(48)};
  assert.equal(promptPayConfig(enabled).merchantID,'MERCHANT01');
  assert.throws(()=>promptPayConfig({...enabled,APP_ENV:'staging'}),/disabled/);
});

test('PromptPay backend notification rejects browser-owned entitlement fields',async()=>{
  const {normalizePromptPayNotification}=await mod();
  const good={merchantID:'MERCHANT01',invoiceNo:'VXP1234567890ABCDE',amount:50,currencyCode:'THB',
    paymentID:'PAYMENT123',referenceNo:'REF123',respCode:'0000',transactionDateTime:'20261026203000'};
  assert.equal(normalizePromptPayNotification(good,'MERCHANT01').amount,50);
  assert.throws(()=>normalizePromptPayNotification({...good,vip1:true},'MERCHANT01'),/Invalid PromptPay/);
  assert.throws(()=>normalizePromptPayNotification({...good,amount:49},'OTHER'),/Invalid PromptPay/);
});
