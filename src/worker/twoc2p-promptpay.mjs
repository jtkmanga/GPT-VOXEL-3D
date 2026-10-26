import { verifyFirebaseRequestTokens } from './firebase-auth.mjs';
import { sign2c2pJwt, verify2c2pJwt, parse2c2pJson, Twoc2pJwtError } from './twoc2p-jwt.mjs';
import { Twoc2pPromptPayStore } from './twoc2p-promptpay-store.mjs';
import { paymentEventFingerprint, validVipUid } from './payment-events.mjs';

export const TWOC2P_PROMPTPAY = Object.freeze({
  sandboxApi: 'https://sandbox-pgw.2c2p.com/payment/4.5',
  productionApi: 'https://pgw.2c2p.com/payment/4.5',
  stagingWorker: 'gpt-voxel-3d-staging-01',
  stagingOrigin: 'https://gpt-voxel-3d-staging-01.hjinffv5426.workers.dev',
  stagingProject: 'gpt-voxel-3d-staging',
  productionWorkerOrigin: 'https://voxel-run-v2-demo.hjinffv5426.workers.dev',
  productionBrowserOrigin: 'https://jtkmanga.github.io',
  productionReturnUrl: 'https://jtkmanga.github.io/GPT-VOXEL-3D/?payment=promptpay-return',
  productionProject: 'lucky-game-6936b',
  channel: 'PPQR',
  currency: 'THB'
});

export class Twoc2pPromptPayError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new Twoc2pPromptPayError(message, status); };
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
const safeIdentifier = (value, maximum) => typeof value === 'string' &&
  value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(value);

function config(env) {
  const staging = env.APP_ENV === 'staging';
  if (staging) {
    if (env.PAYMENT_MODE !== 'provider-neutral-test' ||
        env.STAGING_WORKER_NAME !== TWOC2P_PROMPTPAY.stagingWorker ||
        env.STAGING_WORKER_ORIGIN !== TWOC2P_PROMPTPAY.stagingOrigin ||
        env.ALLOWED_ORIGIN !== TWOC2P_PROMPTPAY.stagingOrigin ||
        env.FIREBASE_PROJECT_ID !== TWOC2P_PROMPTPAY.stagingProject)
      fail('PromptPay staging isolation unavailable', 503);
    if (env.TWOC2P_SANDBOX_ENABLED !== 'true' || env.TWOC2P_SANDBOX_CHECKOUT_ENABLED !== 'true' ||
        env.TWOC2P_SANDBOX_BACKEND_ENABLED !== 'true')
      fail('PromptPay sandbox actions are disabled', 503);
    if (!safeIdentifier(env.TWOC2P_SANDBOX_MERCHANT_ID, 64) ||
        typeof env.TWOC2P_SANDBOX_SECRET_KEY !== 'string' ||
        new TextEncoder().encode(env.TWOC2P_SANDBOX_SECRET_KEY).byteLength < 32)
      fail('PromptPay sandbox signing boundary unavailable', 503);
    return {
      staging: true,
      api: TWOC2P_PROMPTPAY.sandboxApi,
      browserOrigin: TWOC2P_PROMPTPAY.stagingOrigin,
      workerOrigin: TWOC2P_PROMPTPAY.stagingOrigin,
      returnUrl: TWOC2P_PROMPTPAY.stagingOrigin + '/?payment=promptpay-return',
      merchantID: env.TWOC2P_SANDBOX_MERCHANT_ID,
      secret: env.TWOC2P_SANDBOX_SECRET_KEY
    };
  }
  if (env.PAYMENT_MODE !== '2c2p-promptpay' || env.FIREBASE_PROJECT_ID !== TWOC2P_PROMPTPAY.productionProject ||
      env.ALLOWED_ORIGIN !== TWOC2P_PROMPTPAY.productionBrowserOrigin)
    fail('Production PromptPay is disabled', 503);
  if (!safeIdentifier(env.PRODUCTION_TWOC2P_MERCHANT_ID, 64) ||
      typeof env.PRODUCTION_TWOC2P_SECRET_KEY !== 'string' ||
      new TextEncoder().encode(env.PRODUCTION_TWOC2P_SECRET_KEY).byteLength < 32)
    fail('Production PromptPay signing boundary unavailable', 503);
  return {
    staging: false,
    api: TWOC2P_PROMPTPAY.productionApi,
    browserOrigin: TWOC2P_PROMPTPAY.productionBrowserOrigin,
    workerOrigin: TWOC2P_PROMPTPAY.productionWorkerOrigin,
    returnUrl: TWOC2P_PROMPTPAY.productionReturnUrl,
    merchantID: env.PRODUCTION_TWOC2P_MERCHANT_ID,
    secret: env.PRODUCTION_TWOC2P_SECRET_KEY
  };
}

async function boundedJson(message, maximum = 24 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(message.headers.get('Content-Type') || ''))
    fail('JSON payment data required', 415);
  const declared = message.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum))
    fail('Payment data too large', 413);
  if (!message.body) fail('Payment data required', 400);
  const reader = message.body.getReader(), parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); fail('Payment data too large', 413); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.byteLength; }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (_) { fail('Invalid payment data', 400); }
  try { return parse2c2pJson(text, maximum); }
  catch (_) { fail('Invalid payment data', 400); }
}

async function authenticatedIdentity(request, env, cfg) {
  if (request.headers.get('Origin') !== cfg.browserOrigin) fail('Origin not allowed', 403);
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) fail('Sign-in required', 401);
  try {
    const identity = await verifyFirebaseRequestTokens(
      authorization.slice(7), request.headers.get('X-Firebase-AppCheck'), env);
    if (!validVipUid(identity.uid)) fail('Sign-in required', 401);
    return identity;
  } catch (_) { fail('Sign-in required', 401); }
}

function requireCurrentIdentity(identity) {
  if (!identity || !Number.isSafeInteger(identity.exp) || identity.exp <= Math.floor(Date.now() / 1000))
    fail('Sign-in required', 401);
}

function envelopeToken(envelope) {
  if (!ownObject(envelope) || Object.keys(envelope).length !== 1 || typeof envelope.payload !== 'string')
    fail('Invalid signed payment envelope', 400);
  return envelope.payload;
}

function parseBaht(value) {
  if (Number.isSafeInteger(value) && value >= 1 && value <= 100000) return value;
  if (typeof value !== 'string' || !/^\d{1,6}(?:\.0{1,2})?$/.test(value)) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= 100000 ? numeric : null;
}

function validProviderDate(value) {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return false;
  const p = [value.slice(0,4),value.slice(4,6),value.slice(6,8),
    value.slice(8,10),value.slice(10,12),value.slice(12,14)].map(Number);
  const date = new Date(Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]));
  return p[0] >= 2000 && date.getUTCFullYear() === p[0] && date.getUTCMonth() === p[1] - 1 &&
    date.getUTCDate() === p[2] && date.getUTCHours() === p[3] &&
    date.getUTCMinutes() === p[4] && date.getUTCSeconds() === p[5];
}

export function normalizePromptPayNotification(payload, merchantID) {
  const clientOwned = ['uid','userId','vip','vip1','paid','success','entitlement','entitlements',
    'vip1Expires','periodStart','periodEnd','score','reward','__proto__','constructor','prototype'];
  if (!ownObject(payload) || payload.merchantID !== merchantID ||
      clientOwned.some(name => Object.hasOwn(payload, name)) ||
      !safeIdentifier(payload.invoiceNo, 20) || payload.currencyCode !== 'THB' ||
      !safeIdentifier(payload.tranRef, 255) || !safeIdentifier(payload.referenceNo, 255) ||
      typeof payload.respCode !== 'string' || !/^\d{4}$/.test(payload.respCode) ||
      !validProviderDate(payload.transactionDateTime))
    fail('Invalid PromptPay payment notification', 400);
  const amount = parseBaht(payload.amount);
  if (amount === null) fail('Invalid PromptPay payment amount', 400);
  if (payload.channelCode !== undefined && payload.channelCode !== TWOC2P_PROMPTPAY.channel)
    fail('Unexpected payment channel', 400);
  return {
    merchantID: payload.merchantID,
    invoiceNo: payload.invoiceNo,
    amount,
    currencyCode: payload.currencyCode,
    transactionId: payload.tranRef,
    referenceNo: payload.referenceNo,
    respCode: payload.respCode,
    transactionDateTime: payload.transactionDateTime
  };
}

export function buildPromptPayPaymentTokenRequest(checkout, cfg) {
  if (!checkout?.ok || !safeIdentifier(checkout.invoiceNo, 20) ||
      !Number.isSafeInteger(checkout.amount) || checkout.amount < 1 || checkout.amount > 100000 ||
      checkout.currencyCode !== 'THB')
    fail('PromptPay invoice unavailable', 503);
  return {
    merchantID: cfg.merchantID,
    invoiceNo: checkout.invoiceNo,
    description: 'VOXEL RUN VIP Server 30 days',
    amount: checkout.amount,
    currencyCode: 'THB',
    paymentChannel: [TWOC2P_PROMPTPAY.channel],
    frontendReturnUrl: cfg.returnUrl,
    backendReturnUrl: cfg.workerOrigin + '/payments/promptpay/backend'
  };
}

export function buildPromptPayDoPaymentRequest(paymentToken, cfg) {
  if (typeof paymentToken !== 'string' || paymentToken.length < 8 || paymentToken.length > 1024)
    fail('PromptPay payment token unavailable', 502);
  return {
    paymentToken,
    clientID: crypto.randomUUID().replace(/-/g, '').toUpperCase(),
    locale: 'th',
    responseReturnUrl: cfg.returnUrl,
    payment: { code: { channelCode: TWOC2P_PROMPTPAY.channel }, data: {} }
  };
}

export function validatePromptPayQrUrl(value, staging = false) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value))
    fail('PromptPay QR unavailable', 502);
  let url;
  try { url = new URL(value); } catch (_) { fail('PromptPay QR unavailable', 502); }
  const host = url.hostname.toLowerCase();
  const allowed = host === 'api.2c2p.com' || host.endsWith('.2c2p.com') ||
    (staging && host === 'pgw-static-sandbox.s3.amazonaws.com');
  if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port)
    fail('PromptPay QR unavailable', 502);
  return url.href;
}

const reply = (body, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
const failureReply = error => reply({ ok: false, error:
  error instanceof Twoc2pPromptPayError || error instanceof Twoc2pJwtError
    ? error.message : 'PromptPay authority unavailable' },
  error instanceof Twoc2pPromptPayError || error instanceof Twoc2pJwtError ? error.status : 503);

async function assertPaymentsNotPaused(env) {
  const response = await env.ROOM.getByName('free-v2-demo').fetch(
    new Request('https://internal/_internal/admin/runtime-controls'));
  const data = await response.json();
  if (!response.ok) fail('Payment authority unavailable', 503);
  if (data?.paymentPaused === true) fail('Payments are temporarily paused', 503);
}

async function internalCall(env, action, body) {
  const response = await env.ROOM.getByName('free-v2-demo').fetch(new Request(
    `https://internal/_internal/promptpay/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }));
  const result = await response.json();
  if (!response.ok || !result?.ok) fail(result?.error || 'PromptPay authority unavailable', response.status);
  return result;
}

async function providerRequest(url, payload, secret) {
  const signed = await sign2c2pJwt(payload, secret);
  const response = await fetch(url, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: signed }),
    signal: AbortSignal.timeout(10_000) });
  if (!response.ok) fail('2C2P request failed', 502);
  try {
    return await verify2c2pJwt(envelopeToken(await boundedJson(response)), secret);
  } catch (error) {
    if (error instanceof Twoc2pJwtError) fail('2C2P response signature invalid', 502);
    throw error;
  }
}

export async function handle2c2pPromptPay(request, env) {
  const url = new URL(request.url), path = url.pathname;
  try {
    const cfg = config(env);
    if (path === '/payments/promptpay/backend') {
      await assertPaymentsNotPaused(env);
      if (request.method !== 'POST') return reply({ ok: false, error: 'Method not allowed' }, 405);
      const payload = await verify2c2pJwt(envelopeToken(await boundedJson(request)), cfg.secret);
      const notification = normalizePromptPayNotification(payload, cfg.merchantID);
      const fingerprint = await paymentEventFingerprint(notification);
      const result = await internalCall(env, 'notification', { notification, fingerprint });
      return reply({ ok: true, status: result.status, replayed: Boolean(result.replayed),
        entitlementGranted: Boolean(result.entitlementGranted) });
    }
    if (path !== '/payments/promptpay/checkout' && path !== '/payments/promptpay/status')
      return reply({ ok: false, error: 'Not found' }, 404);
    if ((path.endsWith('/checkout') && request.method !== 'POST') ||
        (path.endsWith('/status') && request.method !== 'GET'))
      return reply({ ok: false, error: 'Method not allowed' }, 405);
    const identity = await authenticatedIdentity(request, env, cfg);
    const uid = identity.uid;
    if (path.endsWith('/status')) {
      const invoiceNo = url.searchParams.get('invoiceNo');
      if (!safeIdentifier(invoiceNo, 20) || url.searchParams.getAll('invoiceNo').length !== 1 ||
          [...url.searchParams.keys()].some(key => key !== 'invoiceNo'))
        fail('Invalid PromptPay invoice', 400);
      const status = await internalCall(env, 'status', { uid, invoiceNo });
      requireCurrentIdentity(identity);
      return reply(status);
    }
    await assertPaymentsNotPaused(env);
    const input = await boundedJson(request, 2048);
    if (!ownObject(input) || Object.keys(input).length !== 1 ||
        !safeIdentifier(input.requestId, 128) || input.requestId.length < 16)
      fail('Invalid PromptPay checkout request', 400);
    const checkout = await internalCall(env, 'create', { uid, requestId: input.requestId });
    if (checkout.providerState === 'ready' && checkout.qrImageUrl) {
      requireCurrentIdentity(identity);
      return reply(checkout);
    }
    const claimed = await internalCall(env, 'claim', { uid, invoiceNo: checkout.invoiceNo });
    if (claimed.providerState === 'ready' && claimed.qrImageUrl) {
      requireCurrentIdentity(identity);
      return reply(claimed);
    }
    try {
      requireCurrentIdentity(identity);
      const token = await providerRequest(cfg.api + '/paymentToken',
        buildPromptPayPaymentTokenRequest(checkout, cfg), cfg.secret);
      if (token.respCode !== '0000' || typeof token.paymentToken !== 'string')
        fail('PromptPay payment token rejected', 502);
      requireCurrentIdentity(identity);
      const payment = await providerRequest(cfg.api + '/payment',
        buildPromptPayDoPaymentRequest(token.paymentToken, cfg), cfg.secret);
      if (payment.respCode !== '1005' || payment.channelCode !== TWOC2P_PROMPTPAY.channel ||
          payment.type !== 'URL')
        fail('PromptPay QR generation rejected', 502);
      const qrImageUrl = validatePromptPayQrUrl(payment.data, cfg.staging);
      const finished = await internalCall(env, 'finish', {
        uid, invoiceNo: checkout.invoiceNo, succeeded: true, qrImageUrl
      });
      requireCurrentIdentity(identity);
      return reply({ ok: true, invoiceNo: checkout.invoiceNo, amount: checkout.amount,
        currencyCode: 'THB', expiresAt: checkout.expiresAt, qrImageUrl: finished.qrImageUrl || qrImageUrl,
        paymentChannel: TWOC2P_PROMPTPAY.channel });
    } catch (error) {
      try { await internalCall(env, 'finish', {
        uid, invoiceNo: checkout.invoiceNo, succeeded: false
      }); } catch (_) {}
      throw error;
    }
  } catch (error) { return failureReply(error); }
}

export async function handlePromptPayInternal(request, room) {
  try {
    if (room.serverScope !== 'free1' || request.method !== 'POST')
      fail('PromptPay entitlement authority unavailable', 403);
    const action = new URL(request.url).pathname.slice('/_internal/promptpay/'.length);
    const cfg = config(room.env);
    const input = await boundedJson(request);
    const store = room.twoc2pPromptPayStore ||= new Twoc2pPromptPayStore(room.ctx, room.vip);
    let result;
    if (action === 'create') {
      if (!validVipUid(input.uid) || !safeIdentifier(input.requestId, 128) || input.requestId.length < 16 ||
          Object.keys(input).some(key => !['uid','requestId'].includes(key)))
        fail('Invalid PromptPay checkout', 400);
      result = store.createCheckout({ uid: input.uid, requestId: input.requestId, merchantID: cfg.merchantID },
        Date.now(), room.price('vip1'));
    } else if (action === 'claim' || action === 'finish' || action === 'status') {
      if (!validVipUid(input.uid) || !safeIdentifier(input.invoiceNo, 20))
        fail('Invalid PromptPay invoice', 400);
      const row = store.checkout(input.invoiceNo, Date.now(), true);
      if (!row.ok || row.uid !== input.uid || row.merchantID !== cfg.merchantID)
        fail('PromptPay invoice unavailable', 404);
      if (action === 'claim') result = store.claimProviderAttempt({ invoiceNo: input.invoiceNo, uid: input.uid });
      else if (action === 'finish') {
        if (typeof input.succeeded !== 'boolean') fail('Invalid PromptPay provider result', 400);
        result = store.finishProviderAttempt({ invoiceNo: input.invoiceNo, uid: input.uid,
          succeeded: input.succeeded, qrImageUrl: input.qrImageUrl ?? null });
      } else result = { ok: true, invoiceNo: row.invoiceNo, status: row.status,
        expiresAt: row.expiresAt, vipExpiresAt: room.vip.entitlement(input.uid).expiresAt };
    } else if (action === 'notification') {
      if (!ownObject(input.notification) || input.fingerprint !== await paymentEventFingerprint(input.notification))
        fail('PromptPay event integrity conflict', 400);
      result = store.applyNotification({ notification: input.notification, fingerprint: input.fingerprint });
    } else fail('Unknown PromptPay payment action', 404);
    return reply(result, result.ok ? 200 : result.status || 409);
  } catch (error) { return failureReply(error); }
}
