import { verifyFirebaseRequestTokens } from './firebase-auth.mjs';
import { sign2c2pJwt, verify2c2pJwt, parse2c2pJson, Twoc2pJwtError } from './twoc2p-jwt.mjs';
import { Twoc2pSandboxStore } from './twoc2p-store.mjs';
import { paymentEventFingerprint, validVipUid } from './payment-events.mjs';

// These are fixed sandbox destinations, never operator-supplied payment URLs.
export const TWOC2P_SANDBOX = Object.freeze({
  api: 'https://sandbox-pgw.2c2p.com/payment/4.5/paymentToken',
  hppOrigin: 'https://sandbox-pgw-ui.2c2p.com',
  worker: 'gpt-voxel-3d-staging-01',
  origin: 'https://gpt-voxel-3d-staging-01.hjinffv5426.workers.dev',
  project: 'gpt-voxel-3d-staging', amount: 50, currency: 'THB'
});

export class Twoc2pSandboxError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new Twoc2pSandboxError(message, status); };
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value);
const safeIdentifier = (value, maximum) => typeof value === 'string' &&
  value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(value);

function assertSandboxStaging(env) {
  if (env.APP_ENV !== 'staging' || env.PAYMENT_MODE !== 'provider-neutral-test' ||
      env.STAGING_WORKER_NAME !== TWOC2P_SANDBOX.worker ||
      env.STAGING_WORKER_ORIGIN !== TWOC2P_SANDBOX.origin ||
      env.ALLOWED_ORIGIN !== TWOC2P_SANDBOX.origin ||
      env.FIREBASE_PROJECT_ID !== TWOC2P_SANDBOX.project || !env.ROOM || !env.ZONE)
    fail('2C2P sandbox staging isolation unavailable', 503);
}

export function twoc2pSandboxConfig(env, action) {
  assertSandboxStaging(env);
  const gates = ['TWOC2P_SANDBOX_ENABLED', 'TWOC2P_SANDBOX_MERCHANT_CAPABILITIES_VERIFIED',
    'TWOC2P_SANDBOX_MONTHLY_POLICY_VERIFIED'];
  const lifecycleAttested = env.TWOC2P_SANDBOX_E2E_VERIFIED === 'true';
  const ownerApprovedE2eTest = env.TWOC2P_SANDBOX_E2E_TEST_MODE === 'true';
  if (gates.some(name => env[name] !== 'true') || (!lifecycleAttested && !ownerApprovedE2eTest) ||
      env.TWOC2P_SANDBOX_BILLING_TIMEZONE !== 'UTC' ||
      (action === 'checkout' && env.TWOC2P_SANDBOX_CHECKOUT_ENABLED !== 'true') ||
      (action === 'backend' && env.TWOC2P_SANDBOX_BACKEND_ENABLED !== 'true'))
    fail('2C2P sandbox payment actions are disabled', 503);
  const e2eTestMode = ownerApprovedE2eTest && !lifecycleAttested;
  const sequence = env.TWOC2P_SANDBOX_INITIAL_SEQUENCE_NO;
  if (!safeIdentifier(env.TWOC2P_SANDBOX_MERCHANT_ID, 25) ||
      typeof env.TWOC2P_SANDBOX_SECRET_KEY !== 'string' ||
      new TextEncoder().encode(env.TWOC2P_SANDBOX_SECRET_KEY).byteLength < 32 ||
      new TextEncoder().encode(env.TWOC2P_SANDBOX_SECRET_KEY).byteLength > 4096 ||
      (!e2eTestMode && (typeof sequence !== 'string' || !/^\d{1,10}$/.test(sequence))) ||
      (e2eTestMode && sequence !== undefined && sequence !== '' &&
        (typeof sequence !== 'string' || !/^\d{1,10}$/.test(sequence))))
    fail('2C2P sandbox signing boundary is unavailable', 503);
  return { merchantID: env.TWOC2P_SANDBOX_MERCHANT_ID, secret: env.TWOC2P_SANDBOX_SECRET_KEY,
    initialSequence: typeof sequence === 'string' && /^\d{1,10}$/.test(sequence) ? sequence : null,
    e2eTestMode };
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

async function authenticatedIdentity(request, env) {
  if (request.headers.get('Origin') !== TWOC2P_SANDBOX.origin) fail('Origin not allowed', 403);
  const authorization = request.headers.get('Authorization') || '';
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) fail('Staging sign-in required', 401);
  try {
    const identity = await verifyFirebaseRequestTokens(authorization.slice(7), request.headers.get('X-Firebase-AppCheck'), env);
    if (!validVipUid(identity.uid)) fail('Staging sign-in required', 401);
    return identity;
  } catch (_) { fail('Staging sign-in required', 401); }
}

function requireCurrentIdentity(identity) {
  if (!identity || !Number.isSafeInteger(identity.exp) || identity.exp <= Math.floor(Date.now()/1000))
    fail('Staging sign-in required',401);
}

function envelopeToken(envelope) {
  if (!ownObject(envelope) || Object.keys(envelope).length !== 1 || typeof envelope.payload !== 'string')
    fail('Invalid signed payment envelope', 400);
  return envelope.payload;
}

export function validateSandboxHostedUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value))
    fail('Sandbox hosted checkout unavailable', 502);
  let url;
  try { url = new URL(value); } catch (_) { fail('Sandbox hosted checkout unavailable', 502); }
  if (url.origin !== TWOC2P_SANDBOX.hppOrigin || url.username || url.password || url.port ||
      url.pathname !== '/payment/4.5/' || url.search || !/^#\/token\/[A-Za-z0-9%_+=/.-]+$/.test(url.hash))
    fail('Sandbox hosted checkout unavailable', 502);
  return url.href;
}

export function buildSandboxPaymentTokenRequest(checkout, merchantID) {
  if (!ownObject(checkout) || checkout.merchantID !== merchantID || checkout.amount !== 50 ||
      checkout.currencyCode !== 'THB' || !safeIdentifier(checkout.invoiceNo, 20) ||
      !safeIdentifier(checkout.invoicePrefix, 15) || !Number.isSafeInteger(checkout.periodEnd))
    fail('Sandbox invoice unavailable', 503);
  const next = new Date(checkout.periodEnd), day = next.getUTCDate();
  if (day < 1 || day > 28 || !Number.isFinite(next.getTime()))
    fail('Monthly billing policy requires verification', 503);
  const dd = String(day).padStart(2, '0'), mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  return { merchantID, invoiceNo: checkout.invoiceNo, description: 'VIP Server calendar-month sandbox subscription',
    amount: 50, currencyCode: 'THB', paymentChannel: ['CC'],
    frontendReturnUrl: `${TWOC2P_SANDBOX.origin}/payments/2c2p/return`,
    backendReturnUrl: `${TWOC2P_SANDBOX.origin}/payments/2c2p/backend`,
    recurring: true, invoicePrefix: checkout.invoicePrefix, recurringAmount: 50,
    allowAccumulate: false, maxAccumulateAmount: 0, recurringCount: 0,
    chargeOnDate: dd + mm, chargeNextDate: dd + mm + String(next.getUTCFullYear()) };
}

function validProviderDate(value) {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return false;
  const parts = [value.slice(0,4),value.slice(4,6),value.slice(6,8),value.slice(8,10),value.slice(10,12),value.slice(12,14)].map(Number);
  const [year, month, day, hour, minute, second] = parts;
  if (year < 2000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  return new Date(Date.UTC(year, month, 0)).getUTCDate() >= day;
}

// Ignore optional card/customer fields entirely: they never enter game storage.
export function normalizeSandboxNotification(payload, merchantID) {
  const clientOwned = ['uid','userId','vip','vip1','paid','success','entitlement','entitlements',
    'vip1Expires','periodStart','periodEnd','score','reward','__proto__','constructor','prototype'];
  if (!ownObject(payload) || payload.merchantID !== merchantID ||
      clientOwned.some(name => Object.hasOwn(payload,name)) ||
      !safeIdentifier(payload.invoiceNo, 50) || payload.currencyCode !== 'THB' ||
      !safeIdentifier(payload.paymentID, 255) || !safeIdentifier(payload.referenceNo, 50) ||
      typeof payload.respCode !== 'string' || !/^\d{4}$/.test(payload.respCode) ||
      !validProviderDate(payload.transactionDateTime)) fail('Invalid sandbox payment notification', 400);
  const amount = payload.amount;
  if (!(amount === 50 || (typeof amount === 'string' && /^0*50(?:\.0{1,5})?$/.test(amount) && amount.length <= 18)))
    fail('Invalid sandbox payment amount', 400);
  const result = {merchantID:payload.merchantID,invoiceNo:payload.invoiceNo,amount:50,
    currencyCode:payload.currencyCode,paymentID:payload.paymentID,referenceNo:payload.referenceNo,
    respCode:payload.respCode,transactionDateTime:payload.transactionDateTime};
  for (const [field, maximum] of [['recurringUniqueID',20],['recurringSequenceNo',10]]) {
    if (payload[field] !== undefined) {
      if (typeof payload[field] !== 'string' || !new RegExp(`^\\d{1,${maximum}}$`).test(payload[field]))
        fail('Invalid sandbox recurring identity', 400);
      result[field] = payload[field];
    }
  }
  if (payload.respCode === '0000' && (!result.recurringUniqueID || result.recurringSequenceNo === undefined))
    fail('Verified recurring payment identity required', 400);
  if (payload.tranRef !== undefined) {
    if (!safeIdentifier(payload.tranRef, 255)) fail('Invalid sandbox transaction identity', 400);
    result.tranRef = payload.tranRef;
  }
  return result;
}

function initialPaymentOnly(notification, config) {
  if (notification.respCode !== '0000' || config.e2eTestMode) return;
  if (notification.recurringSequenceNo !== config.initialSequence)
    fail('Recurring cycle mapping requires provider verification',400);
}

const reply = (body, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
const failureReply = error => reply({ ok: false, error: error instanceof Twoc2pSandboxError || error instanceof Twoc2pJwtError
  ? error.message : 'Sandbox payment authority unavailable' },
  error instanceof Twoc2pSandboxError || error instanceof Twoc2pJwtError ? error.status : 503);

async function internalCall(env, action, body) {
  const response = await env.ROOM.getByName('free-v2-demo').fetch(new Request(
    `https://internal/_internal/2c2p/${action}`, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) }));
  const result = await response.json();
  if (!response.ok || !result?.ok) fail(result?.error || 'Sandbox payment authority unavailable', response.status);
  return result;
}

export async function handle2c2pSandbox(request, env) {
  const url = new URL(request.url), path = url.pathname;
  try {
    assertSandboxStaging(env);
    if (url.origin !== TWOC2P_SANDBOX.origin) fail('Staging payment origin unavailable',503);
    if (path === '/payments/2c2p/return') {
      if (request.method !== 'GET') return reply({ ok:false, error:'Method not allowed' },405);
      // Browser redirects/status parameters are never payment evidence. Return
      // only to the staging application; it will query server-owned status using
      // the authenticated identity and the invoice kept in sessionStorage.
      return Response.redirect(TWOC2P_SANDBOX.origin + '/?payment=sandbox-return', 303);
    }
    if (path === '/payments/2c2p/lifecycle') {
      return reply({ ok:false, error:'Recurring renewal, cancellation and refund integration requires provider verification' },503);
    }
    const action = path === '/payments/2c2p/backend' ? 'backend' : 'checkout';
    const config = twoc2pSandboxConfig(env, action);
    if (path === '/payments/2c2p/backend') {
      if (request.method !== 'POST') return reply({ok:false,error:'Method not allowed'},405);
      const payload = await verify2c2pJwt(envelopeToken(await boundedJson(request)),config.secret);
      const notification = normalizeSandboxNotification(payload,config.merchantID);
      initialPaymentOnly(notification,config);
      const result = await internalCall(env,'notification',{notification,fingerprint:await paymentEventFingerprint(notification)});
      return reply({ ok:true, status:result.status, replayed:Boolean(result.replayed), entitlementGranted:Boolean(result.entitlementGranted) });
    }
    if (path !== '/payments/2c2p/checkout' && path !== '/payments/2c2p/status')
      return reply({ok:false,error:'Not found'},404);
    if ((path.endsWith('/checkout') && request.method !== 'POST') ||
        (path.endsWith('/status') && request.method !== 'GET')) return reply({ok:false,error:'Method not allowed'},405);
    const identity = await authenticatedIdentity(request,env), uid = identity.uid;
    if (path.endsWith('/status')) {
      const invoiceNo = url.searchParams.get('invoiceNo');
      if (!safeIdentifier(invoiceNo,20) || [...url.searchParams.keys()].some(key => key !== 'invoiceNo') ||
          url.searchParams.getAll('invoiceNo').length !== 1) fail('Invalid sandbox invoice',400);
      const status = await internalCall(env,'status',{uid,invoiceNo});
      requireCurrentIdentity(identity);
      return reply(status);
    }
    const input = await boundedJson(request,2048);
    if (Object.keys(input).length !== 1 || !safeIdentifier(input.requestId,128) || input.requestId.length < 16)
      fail('Invalid sandbox checkout request',400);
    const checkout = await internalCall(env,'create',{uid,requestId:input.requestId});
    const claimed = await internalCall(env,'claim',{uid,invoiceNo:checkout.invoiceNo});
    if (!claimed.ok) fail('Sandbox checkout already requested',409);
    try {
      requireCurrentIdentity(identity);
      const signed = await sign2c2pJwt(buildSandboxPaymentTokenRequest(checkout,config.merchantID),config.secret);
      requireCurrentIdentity(identity);
      const response = await fetch(TWOC2P_SANDBOX.api,{method:'POST',redirect:'error',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:signed}),
        signal:AbortSignal.timeout(10_000)});
      if (!response.ok) fail('Sandbox payment token request failed',502);
      const verified = await verify2c2pJwt(envelopeToken(await boundedJson(response)),config.secret);
      if (verified.respCode !== '0000' || typeof verified.paymentToken !== 'string' ||
          !verified.paymentToken || verified.paymentToken.length > 255)
        fail('Sandbox payment token request rejected',502);
      const webPaymentUrl = validateSandboxHostedUrl(verified.webPaymentUrl);
      requireCurrentIdentity(identity);
      await internalCall(env,'finish',{uid,invoiceNo:checkout.invoiceNo,succeeded:true});
      requireCurrentIdentity(identity);
      return reply({ok:true,invoiceNo:checkout.invoiceNo,amount:50,currencyCode:'THB',expiresAt:checkout.expiresAt,
        webPaymentUrl,recurringPreparation:'monthly-initial-only'});
    } catch (error) {
      try { await internalCall(env,'finish',{uid,invoiceNo:checkout.invoiceNo,succeeded:false}); } catch (_) {}
      if (error instanceof Twoc2pJwtError) fail('Sandbox payment token response unverified',502);
      throw error;
    }
  } catch (error) { return failureReply(error); }
}

export async function handle2c2pInternal(request, room) {
  try {
    if (room.serverScope !== 'free1' || request.method !== 'POST') fail('Sandbox entitlement authority unavailable',403);
    const action = new URL(request.url).pathname.slice('/_internal/2c2p/'.length);
    const config = twoc2pSandboxConfig(room.env,action === 'notification' ? 'backend' : 'checkout');
    const input = await boundedJson(request);
    const store = room.twoc2pSandboxStore ||= new Twoc2pSandboxStore(room.ctx,room.vip);
    let result;
    if (action === 'create') {
      if (!validVipUid(input.uid) || !safeIdentifier(input.requestId,128) || input.requestId.length < 16 ||
          Object.keys(input).some(key => !['uid','requestId'].includes(key))) fail('Invalid sandbox checkout',400);
      const invoicePrefix = 'VXR'+crypto.randomUUID().replace(/-/g,'').slice(0,12);
      result = store.createCheckout({uid:input.uid,merchantID:config.merchantID,invoicePrefix,requestId:input.requestId});
    } else if (action === 'claim' || action === 'finish' || action === 'status') {
      if (!validVipUid(input.uid) || !safeIdentifier(input.invoiceNo,20)) fail('Invalid sandbox invoice',400);
      const row = store.checkout(input.invoiceNo);
      if (!row || row.uid !== input.uid || row.merchantID !== config.merchantID) fail('Sandbox invoice unavailable',404);
      if (action === 'claim') result = store.claimTokenAttempt({invoiceNo:input.invoiceNo,uid:input.uid});
      else if (action === 'finish') {
        if (typeof input.succeeded !== 'boolean') fail('Invalid sandbox token result',400);
        result = store.finishTokenAttempt({invoiceNo:input.invoiceNo,uid:input.uid,succeeded:input.succeeded});
      } else result = {ok:true,invoiceNo:row.invoiceNo,status:row.status,expiresAt:row.expiresAt,
        vipExpiresAt:room.vip.entitlement(input.uid).expiresAt};
    } else if (action === 'notification') {
      const notification = normalizeSandboxNotification(input.notification,config.merchantID);
      initialPaymentOnly(notification,config);
      if (input.fingerprint !== await paymentEventFingerprint(notification)) fail('Sandbox event integrity conflict',400);
      result = store.applyNotification({notification,fingerprint:input.fingerprint});
    } else fail('Unknown sandbox payment action',404);
    return reply(result,result.ok ? 200 : result.status || 409);
  } catch (error) { return failureReply(error); }
}
