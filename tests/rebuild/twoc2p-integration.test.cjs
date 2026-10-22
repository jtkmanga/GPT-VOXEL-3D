'use strict';

// Exercise the bundled public Worker and its actual SQLite-backed coordinator.
// Authenticated HTTP fixtures include both Firebase ID and App Check proof.
// Every 2C2P response below is locally synthesized. No provider requests,
// public demo credentials or real payment transactions are used by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createHarness } = require('./harness.cjs');

const ORIGIN = 'https://gpt-voxel-3d-staging-01.hjinffv5426.workers.dev';
const PROJECT = 'gpt-voxel-3d-staging';
const SECRET = 'synthetic-only-2c2p-signing-fixture';
const MERCHANT = 'SyntheticSandboxMerchant';
const PAYMENT_TOKEN_URL = 'https://sandbox-pgw.2c2p.com/payment/4.5/paymentToken';
const HPP_URL = 'https://sandbox-pgw-ui.2c2p.com/payment/4.5/#/token/synthetic-local-token';
const ACTIVE_ENV = {
  TWOC2P_SANDBOX_ENABLED: 'true', TWOC2P_SANDBOX_CHECKOUT_ENABLED: 'true',
  TWOC2P_SANDBOX_BACKEND_ENABLED: 'true',
  TWOC2P_SANDBOX_MERCHANT_CAPABILITIES_VERIFIED: 'true',
  TWOC2P_SANDBOX_E2E_VERIFIED: 'true', TWOC2P_SANDBOX_E2E_TEST_MODE: 'false',
  TWOC2P_SANDBOX_MONTHLY_POLICY_VERIFIED: 'true',
  TWOC2P_SANDBOX_BILLING_TIMEZONE: 'UTC',
  TWOC2P_SANDBOX_INITIAL_SEQUENCE_NO: '1',
  TWOC2P_SANDBOX_MERCHANT_ID: MERCHANT, TWOC2P_SANDBOX_SECRET_KEY: SECRET
};
const BASE_ENV = {
  APP_ENV: 'staging', STAGING_WORKER_NAME: 'gpt-voxel-3d-staging-01',
  STAGING_WORKER_ORIGIN: ORIGIN, ALLOWED_ORIGIN: ORIGIN,
  FIREBASE_PROJECT_ID: PROJECT, STAGING_AUTH_MODE: 'popup',
  PAYMENT_MODE: 'provider-neutral-test',
  FIREBASE_APP_CHECK_SITE_KEY: '6L' + 'A'.repeat(38),
  FIREBASE_PUBLIC_CONFIG: JSON.stringify({ apiKey: 'AIza' + '0'.repeat(35),
    projectId: PROJECT, authDomain: PROJECT + '.firebaseapp.com',
    appId: '1:123456789:web:12345678' })
};

function signed(payload, secret = SECRET, header = { alg: 'HS256', typ: 'JWT' }) {
  const content = [header, payload].map(value =>
    Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return content + '.' + createHmac('sha256', secret).update(content).digest('base64url');
}
function decodeSigned(token) {
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  assert.equal(signature, createHmac('sha256', SECRET).update(header + '.' + payload).digest('base64url'));
  return JSON.parse(Buffer.from(payload, 'base64url'));
}

function fixture(t, env = {}, options = {}) {
  const h = createHarness({ workerOrigin: ORIGIN, defaultTokenProject: PROJECT,
    env: { ...BASE_ENV, ...env }, ...options });
  t.after(async () => { await h.room().ready; await h.close(); });
  // Match the Worker platform's abort signal; all requests still hit the local
  // response synthesizer below, never a network payment endpoint.
  h.context.AbortSignal = AbortSignal;
  const originalFetch = h.context.fetch;
  const calls = [];
  let providerResponse = () => Response.json({ payload: signed({ respCode: '0000',
    paymentToken: 'synthetic-local-token', webPaymentUrl: HPP_URL }) });
  h.context.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url !== PAYMENT_TOKEN_URL) return originalFetch(input, init);
    assert.equal(request.method, 'POST');
    assert.equal(request.redirect, 'error', 'Provider redirects cannot escape the fixed sandbox destination');
    assert.equal(request.headers.get('content-type'), 'application/json');
    const body = JSON.parse(await request.text());
    assert.deepEqual(Object.keys(body), ['payload']);
    const claims = decodeSigned(body.payload);
    calls.push(claims);
    return providerResponse(claims);
  };
  return { h, calls, setProviderResponse(response) { providerResponse = response; } };
}

function checkout(h, uid = 'sandbox-payer', body = { requestId: 'syntheticrequest00001' }) {
  return h.request('/payments/2c2p/checkout', { method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + h.token(uid),
      'X-Firebase-AppCheck': h.appCheckToken() },
    body: JSON.stringify(body) });
}
function providerEvent(h, invoiceNo, changes = {}) {
  return { merchantID: MERCHANT, invoiceNo, amount: 50, currencyCode: 'THB',
    respCode: '0000', paymentID: 'synthetic-payment-001', referenceNo: 'synthetic-reference-001',
    transactionDateTime: new Date(h.now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14),
    recurringUniqueID: '1234567890', recurringSequenceNo: '1', ...changes };
}
function count(h, table) {
  // Table names in calls below are fixed source constants, not request input.
  return h.room().sql.exec('SELECT COUNT(*) AS n FROM ' + table).toArray()[0].n;
}
async function prepared(t, uid = 'sandbox-payer', env = {}) {
  const f = fixture(t, { ...ACTIVE_ENV, ...env });
  const response = await checkout(f.h, uid);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  return { ...f, uid, result, event: providerEvent(f.h, result.invoiceNo) };
}
function backend(h, claims, headers = {}) {
  return h.request('/payments/2c2p/backend', { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ payload: signed(claims) }) });
}
function status(h, invoice, uid = 'sandbox-payer') {
  return h.request('/payments/2c2p/status?invoiceNo=' + encodeURIComponent(invoice),
    { headers: { Authorization: 'Bearer ' + h.token(uid), 'X-Firebase-AppCheck': h.appCheckToken() } });
}

function holdCoordinatorResponse(h, action) {
  let reached, release, once = true;
  const held = new Promise(resolve => { reached = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  const getByName = h.env.ROOM.getByName;
  h.env.ROOM.getByName = name => {
    const stub = getByName(name);
    if (name !== 'free-v2-demo') return stub;
    return { async fetch(request) {
      const response = await stub.fetch(request);
      if (once && new URL(request.url).pathname === '/_internal/2c2p/' + action) {
        once = false;
        reached();
        await resumed;
      }
      return response;
    } };
  };
  return { held, release };
}

function shortLivedCheckout(h) {
  return h.request('/payments/2c2p/checkout', { method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + h.token('sandbox-payer',
      { exp: Math.floor(h.now() / 1000) + 1 }), 'X-Firebase-AppCheck': h.appCheckToken() },
    body: JSON.stringify({ requestId: 'syntheticrequest00001' }) });
}

test('2C2P HTTP payment actions remain disabled by default without any provider traffic', async t => {
  const { h, calls } = fixture(t);
  for (const response of [await checkout(h), await backend(h, { respCode: '0000' }),
    await status(h, 'forged'), await h.request('/payments/2c2p/lifecycle', { method: 'POST' })]) {
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal(calls.length, 0);
  assert.equal(h.room().vip.entitlement('sandbox-payer', h.now()).active, false);
});

test('2C2P HTTP every activation and action gate is mandatory and fails closed', async t => {
  for (const flag of ['TWOC2P_SANDBOX_ENABLED', 'TWOC2P_SANDBOX_CHECKOUT_ENABLED',
    'TWOC2P_SANDBOX_MERCHANT_CAPABILITIES_VERIFIED',
    'TWOC2P_SANDBOX_MONTHLY_POLICY_VERIFIED']) {
    for (const value of [undefined, 'false', true, 'TRUE']) {
      const { h, calls } = fixture(t, { ...ACTIVE_ENV, [flag]: value });
      assert.equal((await checkout(h)).status, 503, flag);
      assert.equal(calls.length, 0);
    }
  }
  for (const e2e of [undefined, 'false', true, 'TRUE']) {
    const { h, calls } = fixture(t, { ...ACTIVE_ENV,
      TWOC2P_SANDBOX_E2E_VERIFIED: e2e, TWOC2P_SANDBOX_E2E_TEST_MODE: 'false' });
    assert.equal((await checkout(h)).status, 503, 'E2E attestation/test mode');
    assert.equal(calls.length, 0);
  }
});

test('2C2P owner-approved E2E test mode can exercise staging without falsely pre-attesting E2E', async t => {
  const { h, calls } = fixture(t, { ...ACTIVE_ENV,
    TWOC2P_SANDBOX_E2E_VERIFIED: 'false', TWOC2P_SANDBOX_E2E_TEST_MODE: 'true' });
  const response = await checkout(h);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test('2C2P HTTP incomplete or wrong staging identities never reach the provider', async t => {
  for (const settings of [
    { APP_ENV: 'production' }, { STAGING_WORKER_NAME: 'voxel-run-v2-demo' },
    { STAGING_WORKER_ORIGIN: 'https://voxel-run-v2-demo.hjinffv5426.workers.dev' },
    { ALLOWED_ORIGIN: 'https://voxel-run-v2-demo.hjinffv5426.workers.dev' },
    { FIREBASE_PROJECT_ID: 'synthetic-production-project' },
    { PAYMENT_MODE: 'live' }, { TWOC2P_SANDBOX_MERCHANT_ID: undefined },
    { TWOC2P_SANDBOX_SECRET_KEY: undefined }, { TWOC2P_SANDBOX_SECRET_KEY: 'weak' },
    { TWOC2P_SANDBOX_BILLING_TIMEZONE: 'Asia/Bangkok' },
    { TWOC2P_SANDBOX_INITIAL_SEQUENCE_NO: undefined },
    { TWOC2P_SANDBOX_INITIAL_SEQUENCE_NO: 'unknown' }
  ]) {
    const { h, calls } = fixture(t, { ...ACTIVE_ENV, ...settings });
    assert.equal((await checkout(h)).status, 503);
    assert.equal(calls.length, 0);
  }
});

test('2C2P checkout requires current staging Firebase authentication and same origin', async t => {
  const { h, calls } = fixture(t, ACTIVE_ENV);
  const body = JSON.stringify({ requestId: 'syntheticrequest00001' });
  for (const token of [null, 'not-a-token', h.token('expired', { exp: Math.floor(h.now() / 1000) }),
    h.token('wrong-project', { aud: 'synthetic-other-project', iss: 'https://securetoken.google.com/synthetic-other-project' })]) {
    const response = await h.request('/payments/2c2p/checkout', { method: 'POST', body,
      headers: { 'content-type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token, 'X-Firebase-AppCheck': h.appCheckToken() } : {}) } });
    assert.equal(response.status, 401);
  }
  const foreignOrigin = await h.request('/payments/2c2p/checkout', { method: 'POST', body,
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + h.token(),
      'X-Firebase-AppCheck': h.appCheckToken(), Origin: 'https://attacker.invalid' } });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(calls.length, 0);
});

test('2C2P checkout authentication expiring during coordinator claim prevents any provider request', async t => {
  const { h, calls } = fixture(t, ACTIVE_ENV);
  const pause = holdCoordinatorResponse(h, 'claim');
  const pending = shortLivedCheckout(h);
  await pause.held;
  await h.advance(1500);
  pause.release();
  const response = await pending;
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(Object.hasOwn(body, 'webPaymentUrl'), false);
  assert.equal(calls.length, 0);
  assert.equal(h.room().vip.entitlement('sandbox-payer', h.now()).active, false);
  assert.equal(h.room().sql.exec('SELECT token_state FROM voxel_2c2p_sandbox_checkouts')
    .toArray()[0].token_state, 'failed');
  assert.equal((await checkout(h)).status, 409, 'Expired authentication cannot reset the token-request fence');
  assert.equal(calls.length, 0);
});

test('2C2P checkout authentication expiring during provider response prevents hosted URL disclosure', async t => {
  const { h, calls, setProviderResponse } = fixture(t, ACTIVE_ENV);
  let reached, release;
  const held = new Promise(resolve => { reached = resolve; });
  const resumed = new Promise(resolve => { release = resolve; });
  setProviderResponse(async () => {
    reached();
    await resumed;
    return Response.json({ payload: signed({ respCode: '0000',
      paymentToken: 'synthetic-local-token', webPaymentUrl: HPP_URL }) });
  });
  const pending = shortLivedCheckout(h);
  await held;
  await h.advance(1500);
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(Object.hasOwn(body, 'webPaymentUrl'), false);
  assert.equal(Object.hasOwn(body, 'paymentToken'), false);
  assert.equal(calls.length, 1);
  assert.equal(h.room().vip.entitlement('sandbox-payer', h.now()).active, false);
  assert.equal(h.room().sql.exec('SELECT token_state FROM voxel_2c2p_sandbox_checkouts')
    .toArray()[0].token_state, 'failed');
  assert.equal((await checkout(h)).status, 409);
  assert.equal(calls.length, 1);
});

test('2C2P status authentication expiring during coordinator await prevents owner-data disclosure', async t => {
  const { h, result } = await prepared(t);
  const pause = holdCoordinatorResponse(h, 'status');
  const pending = h.request('/payments/2c2p/status?invoiceNo=' + result.invoiceNo,
    { headers: { Authorization: 'Bearer ' + h.token('sandbox-payer',
      { exp: Math.floor(h.now() / 1000) + 1 }), 'X-Firebase-AppCheck': h.appCheckToken() } });
  await pause.held;
  await h.advance(1500);
  pause.release();
  const response = await pending;
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  for (const field of ['invoiceNo', 'status', 'vipExpiresAt', 'expiresAt'])
    assert.equal(Object.hasOwn(body, field), false);
  assert.equal(h.room().vip.entitlement('sandbox-payer', h.now()).active, false);
  const reauthenticated = await status(h, result.invoiceNo);
  assert.equal(reauthenticated.status, 200);
  assert.equal((await reauthenticated.json()).invoiceNo, result.invoiceNo);
});

test('2C2P checkout strictly rejects client-supplied UID price currency and redirect fields', async t => {
  const { h, calls } = fixture(t, ACTIVE_ENV);
  for (const body of [{}, { requestId: 'short' }, { requestId: 123 },
    { requestId: 'syntheticrequest00001', uid: 'victim' },
    { requestId: 'syntheticrequest00001', amount: 1 },
    { requestId: 'syntheticrequest00001', currencyCode: 'USD' },
    { requestId: 'syntheticrequest00001', webPaymentUrl: 'https://attacker.invalid' },
    { requestId: 'syntheticrequest00001', vip: true },
    { requestId: 'syntheticrequest00001', periodEnd: 9999999999999 }]) {
    assert.equal((await checkout(h, 'sandbox-payer', body)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('2C2P checkout produces only signed sandbox hosted requests with server-owned price and calendar scheduling', async t => {
  const { h, calls, result } = await prepared(t);
  assert.equal(calls.length, 1);
  const request = calls[0];
  assert.equal(request.merchantID, MERCHANT);
  assert.equal(request.amount, 50);
  assert.equal(request.currencyCode, 'THB');
  assert.equal(request.backendReturnUrl, ORIGIN + '/payments/2c2p/backend');
  assert.equal(request.frontendReturnUrl, ORIGIN + '/payments/2c2p/return');
  assert.match(request.invoiceNo, /^[A-Za-z0-9]{1,20}$/);
  assert.match(request.invoicePrefix, /^[A-Za-z0-9]{1,15}$/);
  assert.equal(request.recurring, true);
  assert.equal(request.recurringCount, 0);
  assert.match(request.chargeOnDate, /^\d{4}$/);
  assert.match(request.chargeNextDate, /^\d{8}$/);
  assert.equal(Object.hasOwn(request, 'recurringInterval'), false,
    'A day interval cannot stand in for the monthly schedule');
  assert.equal(result.amount, 50); assert.equal(result.currencyCode, 'THB');
  assert.equal(result.webPaymentUrl, HPP_URL);
  assert.equal(result.recurringPreparation, 'monthly-initial-only');
  assert.equal(Object.hasOwn(result, 'paymentToken'), false);
  assert.equal(Object.hasOwn(result, 'uid'), false);
  assert.equal(h.room().vip.entitlement('sandbox-payer', h.now()).active, false,
    'PaymentToken creation is not payment success');
});

test('2C2P invoice and request IDs bind to authenticated UID and persist across coordinator restart', async t => {
  const { h, calls, result } = await prepared(t);
  const replay = await checkout(h);
  assert.equal(replay.status, 409, 'An attempted token request is durably fenced');
  assert.equal(calls.length, 1);
  h.restartRoom();
  const persisted = await status(h, result.invoiceNo);
  assert.equal(persisted.status, 200);
  assert.equal((await persisted.json()).invoiceNo, result.invoiceNo);
  const other = await checkout(h, 'other-sandbox-payer');
  assert.equal(other.status, 200);
  assert.notEqual((await other.json()).invoiceNo, result.invoiceNo);
  assert.equal(calls.length, 2);
  assert.equal((await status(h, result.invoiceNo, 'other-sandbox-payer')).status, 404);
});

test('2C2P checkout concurrent duplicate request creates one invoice and sends at most one token request', async t => {
  const { h, calls } = fixture(t, ACTIVE_ENV);
  const responses = await Promise.all(Array.from({ length: 8 }, () => checkout(h)));
  const bodies = await Promise.all(responses.map(response => response.json()));
  const successful = bodies.filter(body => body.ok);
  assert.ok(successful.length >= 1);
  assert.equal(new Set(successful.map(body => body.invoiceNo)).size, 1);
  assert.equal(calls.length, 1);
});

test('2C2P token response signature status and hosted-origin failures never grant entitlement', async t => {
  for (const response of [
    () => Response.json({ payload: signed({ respCode: '0000', paymentToken: 't', webPaymentUrl: HPP_URL }, 'wrong-synthetic-secret') }),
    () => Response.json({ payload: signed({ respCode: '9999', paymentToken: 't', webPaymentUrl: HPP_URL }) }),
    () => Response.json({ payload: signed({ respCode: '0000', paymentToken: 't', webPaymentUrl: 'https://pgw-ui.2c2p.com/payment/4.5/#/token/t' }) }),
    () => Response.json({ payload: signed({ respCode: '0000', paymentToken: 't', webPaymentUrl: 'https://attacker.invalid/#/token/t' }) }),
    () => Response.json({ payload: signed({ respCode: '0000', paymentToken: 't', webPaymentUrl: 'https://user:pass@sandbox-pgw-ui.2c2p.com/payment/4.5/#/token/t' }) }),
    () => Response.json({ payload: signed({ respCode: '0000', paymentToken: 't', webPaymentUrl: HPP_URL + '?redirect=https://attacker.invalid' }) }),
    () => Response.json({ payload: signed({ respCode: '0000', webPaymentUrl: HPP_URL }) }),
    () => Response.json({ webPaymentUrl: HPP_URL, respCode: '0000' }),
    () => Response.json({ payload: signed({ respCode: '0000', paymentToken: 't', webPaymentUrl: HPP_URL }), extra: true }),
    () => new Response(JSON.stringify({ payload: signed({ respCode: '0000', paymentToken: 't', webPaymentUrl: HPP_URL }) }), { headers: { 'content-type': 'text/html' } }),
    () => Response.json({ payload: signed({ respCode: '0000', paymentToken: 't', webPaymentUrl: HPP_URL, oversized: 'x'.repeat(24576) }) }),
    () => Response.json({ error: 'synthetic provider outage' }, { status: 503 }),
    () => new Response('not-json'),
    () => { throw Error('synthetic network failure'); }
  ]) {
    const { h, calls, setProviderResponse } = fixture(t, ACTIVE_ENV);
    setProviderResponse(response);
    const result = await checkout(h);
    assert.ok(result.status >= 400);
    assert.equal((await result.json()).ok, false);
    assert.equal(calls.length, 1);
    assert.equal(h.room().vip.entitlement('sandbox-payer', h.now()).active, false);
  }
});

test('2C2P backend rejects unsigned forged tampered and algorithm-confused success', async t => {
  const { h, result, event } = await prepared(t);
  for (const body of [JSON.stringify(event), JSON.stringify({ payload: 'not-a-jwt' }),
    JSON.stringify({ payload: signed(event, 'wrong-synthetic-secret') }),
    JSON.stringify({ payload: signed(event, SECRET, { alg: 'none', typ: 'JWT' }) }),
    JSON.stringify({ payload: signed({ ...event, uid: 'forged' }) }).replace('"payload"', '"token"')]) {
    const response = await h.request('/payments/2c2p/backend', { method: 'POST', body,
      headers: { 'content-type': 'application/json' } });
    assert.ok(response.status >= 400);
    assert.equal(h.room().vip.entitlement('sandbox-payer', h.now()).active, false);
  }
  const missingAuth = await status(h, result.invoiceNo, 'another-user');
  assert.equal(missingAuth.status, 404);
});

test('2C2P backend validates merchant invoice price currency transaction date and recurring identity', async t => {
  const { h, event } = await prepared(t);
  for (const changes of [
    { merchantID: 'wrong-merchant' }, { invoiceNo: 'unknown-invoice' }, { amount: 49 },
    { amount: '50junk' }, { amount: '5e1' }, { currencyCode: 'USD' },
    { paymentID: '' }, { referenceNo: '' }, { transactionDateTime: '20300230010101' },
    { transactionDateTime: 'bad-date' }, { recurringUniqueID: '' },
    { recurringSequenceNo: '' }, { respCode: 0 },
    { uid: 'forged-user' }, { vip: true }, { periodEnd: 9999999999999 }
  ]) {
    const response = await backend(h, { ...event, ...changes });
    assert.ok(response.status >= 400, JSON.stringify(Object.keys(changes)));
    assert.equal(h.room().vip.entitlement('sandbox-payer', h.now()).active, false);
  }
});

test('2C2P verified success grants one calendar month only to the authenticated checkout owner', async t => {
  const { h, event, result, uid } = await prepared(t);
  const response = await backend(h, event);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  const entitlement = h.room().vip.entitlement(uid, h.now());
  assert.equal(entitlement.active, true);
  assert.equal(h.room().vip.entitlement('other-sandbox-payer', h.now()).active, false);
  const start = new Date(h.now()), end = new Date(h.now());
  end.setUTCMonth(start.getUTCMonth() + 1);
  assert.equal(entitlement.expiresAt, end.getTime());
  assert.notEqual(entitlement.expiresAt - h.now(), 30 * 86400000,
    'March-to-April coverage has 31 days, not a fixed 30-day term');
  const visible = await (await status(h, result.invoiceNo)).json();
  assert.equal(visible.vipExpiresAt, entitlement.expiresAt);
  assert.equal(Object.hasOwn(visible, 'uid'), false);
  assert.equal(Object.hasOwn(visible, 'paymentID'), false);
  const vip = await h.connect({ server: 'vip1', uid });
  assert.equal(vip.messages('welcome').length, 1);
});

test('2C2P identical concurrent callbacks and restart retries cannot duplicate or extend entitlement', async t => {
  const { h, event, uid } = await prepared(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => backend(h, event)));
  for (const response of responses) assert.equal(response.status, 200);
  const expiry = h.room().vip.entitlement(uid, h.now()).expiresAt;
  assert.equal(count(h, 'voxel_vip_events'), 1);
  assert.equal(count(h, 'voxel_vip_subscriptions'), 1);
  h.restartRoom();
  await h.advance(1000);
  const retry = await backend(h, event);
  assert.equal(retry.status, 200);
  assert.equal(h.room().vip.entitlement(uid, h.now()).expiresAt, expiry);
  assert.equal(count(h, 'voxel_vip_events'), 1);
});

test('2C2P browser completion cannot grant entitlement and lifecycle operations stay blocked', async t => {
  const { h, calls, result } = await prepared(t);
  const response = await h.request('/payments/2c2p/return?invoiceNo=' + result.invoiceNo + '&respCode=0000&paid=true');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), ORIGIN + '/?payment=sandbox-return');
  assert.equal(h.room().vip.entitlement('sandbox-payer', h.now()).active, false);
  for (const operation of ['renewal', 'cancel', 'refund', 'resubscribe']) {
    const lifecycle = await h.request('/payments/2c2p/lifecycle', { method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + h.token(),
        'X-Firebase-AppCheck': h.appCheckToken() },
      body: JSON.stringify({ operation, invoiceNo: result.invoiceNo }) });
    assert.equal(lifecycle.status, 503);
  }
  assert.equal(calls.length, 1);
});

test('2C2P backend activation gate rejects signed callbacks without mutating payment state', async t => {
  const { h, event, uid } = await prepared(t);
  for (const disabled of [undefined, 'false', true, 'TRUE']) {
    h.env.TWOC2P_SANDBOX_BACKEND_ENABLED = disabled;
    assert.equal((await backend(h, event)).status, 503);
    assert.equal(h.room().vip.entitlement(uid, h.now()).active, false);
  }
  h.env.TWOC2P_SANDBOX_BACKEND_ENABLED = 'true';
  assert.equal((await backend(h, event)).status, 200);
  assert.equal(h.room().vip.entitlement(uid, h.now()).active, true);
});

test('2C2P staging E2E test mode can discover only a provider-signed initial recurring sequence', async t => {
  const { h, event, uid } = await prepared(t, 'sandbox-payer', {
    TWOC2P_SANDBOX_E2E_VERIFIED: 'false',
    TWOC2P_SANDBOX_E2E_TEST_MODE: 'true',
    TWOC2P_SANDBOX_INITIAL_SEQUENCE_NO: undefined
  });
  const signedProviderSequence = { ...event, recurringSequenceNo: '7' };
  assert.equal((await backend(h, signedProviderSequence)).status, 200);
  assert.equal(h.room().vip.entitlement(uid, h.now()).active, true);
});

test('2C2P confirmed initial recurring sequence cannot be inferred from arbitrary provider events', async t => {
  const { h, event, uid } = await prepared(t);
  for (const sequence of ['0', '2', '001', '9999999999']) {
    assert.ok((await backend(h, { ...event, recurringSequenceNo: sequence })).status >= 400);
    assert.equal(h.room().vip.entitlement(uid, h.now()).active, false);
  }
  assert.equal((await backend(h, event)).status, 200);
  assert.equal(h.room().vip.entitlement(uid, h.now()).active, true);
});

test('2C2P checkout and callback accept bounded JSON only and reject ambiguous envelope data', async t => {
  const { h, event, uid } = await prepared(t);
  for (const [path, body, headers, expected] of [
    ['/payments/2c2p/backend', JSON.stringify({ payload: signed(event) }), { 'content-type': 'text/plain' }, 415],
    ['/payments/2c2p/backend', '{"payload":', { 'content-type': 'application/json' }, 400],
    ['/payments/2c2p/backend', JSON.stringify({ payload: signed(event), uid: 'forged' }), { 'content-type': 'application/json' }, 400],
    ['/payments/2c2p/backend', '{"payload":"fake","payload":"' + signed(event) + '"}', { 'content-type': 'application/json' }, 400],
    ['/payments/2c2p/backend', 'x'.repeat(24 * 1024 + 1), { 'content-type': 'application/json' }, 413],
    ['/payments/2c2p/backend', JSON.stringify({ payload: signed(event) }), { 'content-type': 'application/json', 'content-length': '24577' }, 413],
    ['/payments/2c2p/checkout', 'x'.repeat(2049), { 'content-type': 'application/json' }, 413],
    ['/payments/2c2p/checkout', '{"requestId":"syntheticrequest00001","requestId":"syntheticrequest00002"}', { 'content-type': 'application/json' }, 400]
  ]) {
    const response = await h.request(path, { method: 'POST', body,
      headers: { Authorization: 'Bearer ' + h.token(uid), 'X-Firebase-AppCheck': h.appCheckToken(), ...headers } });
    assert.equal(response.status, expected, path);
    assert.equal(h.room().vip.entitlement(uid, h.now()).active, false);
  }
});

test('2C2P private mutation routes are unreachable from the public staging Worker', async t => {
  const { h, event, uid } = await prepared(t);
  for (const path of ['/_internal/2c2p/create', '/_internal/2c2p/notification',
    '/_internal/vip/apply-event']) {
    const response = await h.request(path, { method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + h.token(uid),
        'X-Firebase-AppCheck': h.appCheckToken() },
      body: JSON.stringify({ uid, notification: event, event, fingerprint: 'a'.repeat(64) }) });
    assert.equal(response.status, 404);
  }
  assert.equal(h.room().vip.entitlement(uid, h.now()).active, false);
});

test('2C2P provider card and customer metadata is neither returned nor persisted in game ledgers', async t => {
  const { h, event, result } = await prepared(t);
  const extra = { cardNo: 'synthetic-sensitive-card-marker', cardType: 'synthetic-card-type',
    customerEmail: 'synthetic-sensitive-customer@example.invalid', issuerCountry: 'TH' };
  const callback = await backend(h, { ...event, ...extra });
  assert.equal(callback.status, 200);
  assert.equal((await callback.json()).entitlementGranted, true);
  const stored = h.room().sql.exec('SELECT notification_json FROM voxel_2c2p_sandbox_notifications')
    .toArray()[0].notification_json;
  const normalized = JSON.parse(stored);
  const visible = await (await status(h, result.invoiceNo)).json();
  for (const [field, value] of Object.entries(extra)) {
    assert.equal(Object.hasOwn(normalized, field), false);
    assert.equal(Object.hasOwn(visible, field), false);
    assert.equal(stored.includes(JSON.stringify(value)), false);
  }
});

test('2C2P signed callback cannot pay an invoice whose token attempt was never claimed', async t => {
  const { h, calls } = fixture(t, ACTIVE_ENV);
  // Call the private coordinator only inside this local harness to simulate a
  // persisted pending record before the outbound token-request fence is set.
  const created = await h.env.ROOM.getByName('free-v2-demo').fetch(new Request(
    'https://internal/_internal/2c2p/create', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: 'sandbox-payer', requestId: 'syntheticrequest00001' }) }));
  assert.equal(created.status, 200);
  const invoiceNo = (await created.json()).invoiceNo;
  assert.ok((await backend(h, providerEvent(h, invoiceNo))).status >= 400);
  assert.equal(h.room().vip.entitlement('sandbox-payer', h.now()).active, false);
  assert.equal(calls.length, 0);
});

test('2C2P terminal cancelled failed expired events cannot later be replayed as paid', async t => {
  for (const [code, expected] of [['0003', 'cancelled'], ['2003', 'failed'], ['5009', 'expired']]) {
    const { h, event, result, uid } = await prepared(t);
    const declined = await backend(h, { ...event, respCode: code });
    assert.equal(declined.status, 200);
    assert.equal((await declined.json()).status, expected);
    assert.equal(h.room().vip.entitlement(uid, h.now()).active, false);
    assert.ok((await backend(h, event)).status >= 400);
    assert.equal((await (await status(h, result.invoiceNo)).json()).status, expected);
    assert.equal(h.room().vip.entitlement(uid, h.now()).active, false);
  }
});

test('2C2P unsupported payment codes never count as success or extend a paid entitlement', async t => {
  const { h, event, uid } = await prepared(t);
  const unknown = await backend(h, { ...event, respCode: '9999' });
  assert.equal(unknown.status, 200);
  assert.equal(h.room().vip.entitlement(uid, h.now()).active, false);
  assert.equal((await backend(h, event)).status, 200);
  const expiry = h.room().vip.entitlement(uid, h.now()).expiresAt;
  const delayedFailure = await backend(h, { ...event, respCode: '2003' });
  assert.equal(delayedFailure.status, 200);
  assert.equal(h.room().vip.entitlement(uid, h.now()).expiresAt, expiry);
  assert.equal(count(h, 'voxel_vip_events'), 1);
});

test('2C2P expired pending checkout and unsupported monthly anchors fail closed', async t => {
  const { h, event, uid } = await prepared(t);
  await h.advance(15 * 60 * 1000);
  assert.ok((await backend(h, event)).status >= 400);
  assert.equal(h.room().vip.entitlement(uid, h.now()).active, false);
  for (const day of [29, 30, 31]) {
    const { h: late, calls } = fixture(t, ACTIVE_ENV, { now: Date.UTC(2030, 0, day, 12) });
    assert.equal((await checkout(late)).status, 503);
    assert.equal(calls.length, 0);
  }
});

test('2C2P transaction identity is durable and cannot be reused to pay another invoice', async t => {
  const { h, event, uid } = await prepared(t);
  assert.equal((await backend(h, event)).status, 200);
  const second = await checkout(h, 'other-sandbox-payer');
  assert.equal(second.status, 200);
  const secondInvoice = (await second.json()).invoiceNo;
  h.restartRoom(); await h.room().ready;
  for (const changes of [{}, { paymentID: 'new-synthetic-payment' }, { referenceNo: 'new-synthetic-reference' }]) {
    const reused = await backend(h, { ...event, invoiceNo: secondInvoice, ...changes });
    assert.ok(reused.status >= 400);
    assert.equal(h.room().vip.entitlement('other-sandbox-payer', h.now()).active, false);
  }
  assert.equal(h.room().vip.entitlement(uid, h.now()).active, true);
  assert.equal(count(h, 'voxel_vip_events'), 1);
});

test('2C2P storage failure rolls back grant receipt invoice and transaction together before exact retry', async t => {
  const { h, event, result, uid } = await prepared(t);
  const room = h.room(), exec = room.sql.exec;
  room.sql.exec = (query, ...bindings) => {
    if (/INSERT INTO voxel_2c2p_sandbox_notifications/.test(query))
      throw Error('synthetic ledger write failure');
    return exec(query, ...bindings);
  };
  assert.equal((await backend(h, event)).status, 503);
  room.sql.exec = exec;
  assert.equal(room.vip.entitlement(uid, h.now()).active, false);
  assert.equal(count(h, 'voxel_vip_events'), 0);
  assert.equal(count(h, 'voxel_vip_subscriptions'), 0);
  assert.equal(count(h, 'voxel_2c2p_sandbox_notifications'), 0);
  assert.equal(count(h, 'voxel_2c2p_sandbox_transactions'), 0);
  assert.equal((await (await status(h, result.invoiceNo)).json()).status, 'pending');
  assert.equal((await backend(h, event)).status, 200);
  assert.equal(room.vip.entitlement(uid, h.now()).active, true);
  assert.equal(count(h, 'voxel_vip_events'), 1);
});

test('2C2P calendar entitlement expiration rejects admission after durable restart', async t => {
  const { h, event, uid } = await prepared(t);
  assert.equal((await backend(h, event)).status, 200);
  const expiry = h.room().vip.entitlement(uid, h.now()).expiresAt;
  const vip = await h.connect({ server: 'vip1', uid });
  assert.equal(vip.messages('welcome').length, 1);
  await vip.close();
  // Move the synthetic Worker clock directly rather than firing every world
  // timer over a month; this is server time, never a submitted client value.
  assert.equal(h.room().vip.entitlement(uid, expiry).active, false);
  const DateFixture = h.context.Date;
  h.context.Date = class extends DateFixture {
    constructor(...args) { super(...(args.length ? args : [expiry])); }
    static now() { return expiry; }
  };
  const checked = h.room().vip.admit({ uid, sessionId: 'after-calendar-expiry',
    exp: Math.floor(expiry / 1000) + 3600 });
  assert.equal(checked.ok, false);
  h.restartRoom(); await h.room().ready;
  assert.equal(h.room().vip.entitlement(uid, expiry).active, false);
  const seconds = Math.floor(expiry / 1000);
  const rejected = await h.connect({ server: 'vip1', uid,
    token: h.token(uid, { exp: seconds + 3600, iat: seconds - 1, auth_time: seconds - 1 }) });
  assert.equal(rejected.messages('welcome').length, 0);
  assert.equal(rejected.client.closed, true);
});

test('2C2P verified calendar entitlements preserve exactly 100 server-authoritative VIP seats', async t => {
  const { h } = fixture(t, ACTIVE_ENV);
  const users = Array.from({ length: 101 }, (_, index) => 'sandbox-capacity-' + index);
  for (const [index, uid] of users.entries()) {
    const response = await checkout(h, uid);
    assert.equal(response.status, 200);
    const invoiceNo = (await response.json()).invoiceNo;
    const paid = await backend(h, providerEvent(h, invoiceNo, {
      paymentID: 'synthetic-payment-' + index, referenceNo: 'synthetic-reference-' + index,
      recurringUniqueID: String(1234567890 + index) }));
    assert.equal(paid.status, 200);
  }
  const connected = await Promise.all(users.map(uid => h.connect({ server: 'vip1', uid })));
  assert.equal(connected.filter(connection => connection.messages('welcome').length === 1).length, 100);
  assert.equal(connected.filter(connection => connection.client.closed).length, 1);
  assert.equal(h.room().vip.count(), 100);
  assert.equal(h.room('vip1').count(), 100);
});
