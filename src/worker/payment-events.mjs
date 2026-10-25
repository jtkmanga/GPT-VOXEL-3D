import { PAYMENT_CONFIG } from '../shared/catalog.mjs';

export const VIP_PRODUCT = Object.freeze({
  id: 'vip1', amount: PAYMENT_CONFIG.vip1.price, currency: 'THB',
  duration: PAYMENT_CONFIG.vip1.duration, capacity: 100
});

export const PAYMENT_EVENT_LIMITS = Object.freeze({
  bodyBytes: 16 * 1024, signatureAgeMs: 5 * 60 * 1000, secretBytes: 32
});

export class PaymentBoundaryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PaymentBoundaryError';
    this.status = status;
  }
}

const fail = (message, status) => { throw new PaymentBoundaryError(message, status); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
export const validVipUid = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const instant = value => Number.isSafeInteger(value) && value >= 0;

// A provider adapter must map its verified lifecycle into this explicit snapshot
// schema. These values never come from the game client's auth/payment packets.
export function normalizePaymentEvent(raw, now = Date.now()) {
  const keys = ['eventId', 'subscriptionId', 'uid', 'version', 'status', 'product',
    'amount', 'currency', 'periodStart', 'periodEnd'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key)))
    fail('Invalid provider event schema', 400);
  if (!identifier(raw.eventId) || !identifier(raw.subscriptionId) || !validVipUid(raw.uid) ||
      !Number.isSafeInteger(raw.version) || raw.version < 1 ||
      !['active', 'expired', 'revoked'].includes(raw.status) ||
      raw.product !== VIP_PRODUCT.id || raw.amount !== VIP_PRODUCT.amount ||
      raw.currency !== VIP_PRODUCT.currency || !instant(raw.periodStart) || !instant(raw.periodEnd) ||
      raw.periodEnd - raw.periodStart !== VIP_PRODUCT.duration ||
      raw.periodStart > now + PAYMENT_EVENT_LIMITS.signatureAgeMs ||
      (raw.status === 'expired' && raw.periodEnd > now))
    fail('Invalid provider event values', 400);
  // Fixed order makes semantically identical signed retries idempotent even if
  // a provider changes JSON whitespace or object-property order on redelivery.
  return Object.fromEntries(keys.map(key => [key, raw[key]]));
}

function bytesFromHex(value) {
  return Uint8Array.from(value.match(/../g), byte => Number.parseInt(byte, 16));
}

async function boundedBody(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > PAYMENT_EVENT_LIMITS.bodyBytes))
    fail('Provider event body too large', 413);
  if (!request.body) fail('Provider event body required', 400);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PAYMENT_EVENT_LIMITS.bodyBytes) {
        await reader.cancel();
        fail('Provider event body too large', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function paymentEventFingerprint(event) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(event))));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyPaymentEvent(request, env) {
  if (request.method !== 'POST') fail('Method not allowed', 405);
  const secret = env.PAYMENT_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || new TextEncoder().encode(secret).byteLength < PAYMENT_EVENT_LIMITS.secretBytes)
    fail('Payment provider boundary is not configured', 503);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))
    fail('JSON provider event required', 415);
  const timestamp = request.headers.get('x-provider-timestamp') || '';
  const signature = request.headers.get('x-provider-signature') || '';
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature))
    fail('Unverified provider event', 401);
  const signedAt = Number(timestamp) * 1000;
  const now = Date.now();
  if (!Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > PAYMENT_EVENT_LIMITS.signatureAgeMs)
    fail('Expired provider signature', 401);
  const body = await boundedBody(request);
  const prefix = new TextEncoder().encode(timestamp + '.');
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix); signed.set(body, prefix.byteLength);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('HMAC', key, bytesFromHex(signature), signed))
    fail('Unverified provider event', 401);
  let raw;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch (_) { fail('Invalid provider JSON', 400); }
  const event = normalizePaymentEvent(raw, now);
  return { event, fingerprint: await paymentEventFingerprint(event) };
}
