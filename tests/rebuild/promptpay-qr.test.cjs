'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '../..');
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
let adapter;
test.before(async () => {
  adapter = await import(pathToFileURL(path.join(ROOT, 'src/worker/twoc2p-promptpay.mjs')).href);
});

test('PromptPay adapter scopes Payment Token to QR and Do Payment pins exact PPQR', () => {
  const request = adapter.buildPromptPayPaymentTokenRequest({
    ok: true, invoiceNo: 'VQP12345678901234567', amount: 50, currencyCode: 'THB'
  }, {
    merchantID: 'TESTMERCHANT',
    returnUrl: 'https://example.invalid/return',
    workerOrigin: 'https://worker.example.invalid'
  });
  assert.deepEqual(request.paymentChannel, ['QR']);
  assert.match(request.nonceStr, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(request.currencyCode, 'THB');
  assert.equal(request.amount, 50);
  assert.equal(request.backendReturnUrl, 'https://worker.example.invalid/payments/promptpay/backend');
  for (const forbidden of ['recurring','recurringAmount','recurringCount','chargeOnDate','chargeNextDate'])
    assert.equal(Object.hasOwn(request, forbidden), false);
});

test('PromptPay Do Payment request pins PPQR and contains no card/customer account data', () => {
  const request = adapter.buildPromptPayDoPaymentRequest('synthetic-payment-token', {
    returnUrl: 'https://example.invalid/return'
  });
  assert.equal(request.payment.code.channelCode, 'PPQR');
  assert.deepEqual(request.payment.data, {});
  assert.equal(request.locale, 'th');
  const serialized = JSON.stringify(request);
  for (const forbidden of ['cardNo','securePayToken','accountNo','mobileNo'])
    assert.equal(serialized.includes(forbidden), false);
});

test('PromptPay QR URL accepts HTTPS provider hosts and rejects arbitrary hosts', () => {
  assert.equal(adapter.validatePromptPayQrUrl('https://api.2c2p.com/pgw/qr/test.png', false),
    'https://api.2c2p.com/pgw/qr/test.png');
  assert.equal(adapter.validatePromptPayQrUrl(
    'https://pgw-static-sandbox.s3.amazonaws.com/images/qr/test.png', true),
    'https://pgw-static-sandbox.s3.amazonaws.com/images/qr/test.png');
  assert.throws(() => adapter.validatePromptPayQrUrl('https://evil.example/qr.png', false), /QR unavailable/);
  assert.throws(() => adapter.validatePromptPayQrUrl('http://api.2c2p.com/pgw/qr/test.png', false), /QR unavailable/);
});

test('PromptPay backend notification normalizes decimal THB and rejects browser-owned grants', () => {
  const base = {
    merchantID: 'TESTMERCHANT', invoiceNo: 'VQP12345678901234567',
    amount: '50.00', currencyCode: 'THB', tranRef: 'TX12345', referenceNo: 'REF12345',
    transactionDateTime: '20261026190000', respCode: '0000', channelCode: 'PPQR'
  };
  assert.deepEqual(adapter.normalizePromptPayNotification(base, 'TESTMERCHANT'), {
    merchantID: 'TESTMERCHANT', invoiceNo: 'VQP12345678901234567', amount: 50,
    currencyCode: 'THB', transactionId: 'TX12345', referenceNo: 'REF12345',
    respCode: '0000', transactionDateTime: '20261026190000'
  });
  assert.throws(() => adapter.normalizePromptPayNotification({ ...base, vip: true }, 'TESTMERCHANT'),
    /Invalid PromptPay payment notification/);
  assert.throws(() => adapter.normalizePromptPayNotification({ ...base, channelCode: 'CC' }, 'TESTMERCHANT'),
    /Unexpected payment channel/);
});

test('public client contains no static PromptPay target, static account reference or slip upload path', () => {
  const authored = source('src/client/auth-state.js') + '\n' +
    source('src/client/secure-entitlements-payment.js') + '\n' +
    source('src/client/index.template.html');
  assert.equal(authored.includes('promptpay.io/'), false);
  assert.equal(authored.includes('SECURE_PAYMENT_PROMPTPAY_TARGET'), false);
  assert.equal(authored.includes('slip-file-input'), false);
  assert.match(authored, /\/payments\/promptpay\/checkout/);
  assert.match(authored, /\/payments\/promptpay\/status/);
  assert.match(authored, /PromptPay Dynamic QR/);
});

test('production baseline remains payment-disabled until merchant credentials are explicitly enabled', () => {
  const wrangler = JSON.parse(source('wrangler.jsonc'));
  assert.equal(wrangler.vars.PAYMENT_MODE, 'disabled');
  const http = source('src/worker/http.mjs');
  assert.match(http, /env\.PAYMENT_MODE !== 'slip2go-production'/);
  const readiness = source('scripts/rebuild/check-production-readiness.cjs');
  assert.match(readiness, /2c2p-promptpay/);
});
