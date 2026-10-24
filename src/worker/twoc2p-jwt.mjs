// 2C2P Payment Token and backend responses use compact HS256 JWTs, not JWE.
// https://developer.2c2p.com/docs/json-web-tokens-jwt
// Merchant SHA keys are UTF-8 strings; do not reinterpret hexadecimal-looking
// key text as binary. Merchant/invoice/status validation belongs to the adapter.
export const TWOC2P_JWT_LIMITS = Object.freeze({
  tokenBytes: 16 * 1024, payloadBytes: 12 * 1024, headerBytes: 1024,
  jsonBytes: 24 * 1024, secretMinBytes: 32, secretMaxBytes: 4096,
  jsonDepth: 32, jsonValues: 2048
});

export class Twoc2pJwtError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'Twoc2pJwtError';
    this.status = status;
  }
}

const encoder = new TextEncoder();
const fail = (message, status) => { throw new Twoc2pJwtError(message, status); };
const invalid = () => fail('Invalid 2C2P signed payload', 401);
const plainObject = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

function encodeBase64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(text, maximum) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text) ||
      text.length % 4 === 1 || text.length > Math.ceil(maximum * 4 / 3)) invalid();
  let binary;
  try {
    binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - text.length % 4) % 4));
  } catch (_) { invalid(); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  // Reject alternate encodings with nonzero trailing pad bits as well as '='.
  if (bytes.byteLength > maximum || encodeBase64url(bytes) !== text) invalid();
  return bytes;
}

// JSON.parse alone silently accepts duplicate property names. Scan first to
// reject ambiguous signed claims, including escaped/nested duplicate names.
function parseJson(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch (_) { invalid(); }
  let index = 0, values = 0;
  const whitespace = () => { while (/^[\x20\t\r\n]$/.test(text[index] || '')) index++; };
  const string = () => {
    if (text[index] !== '"') invalid();
    const start = index++;
    while (index < text.length) {
      const character = text[index++];
      if (character === '"') {
        try { return JSON.parse(text.slice(start, index)); }
        catch (_) { invalid(); }
      }
      if (character === '\\') {
        if (index >= text.length) invalid();
        const escaped = text[index++];
        if (escaped === 'u') {
          if (!/^[a-fA-F0-9]{4}$/.test(text.slice(index, index + 4))) invalid();
          index += 4;
        } else if (!'"\\/bfnrt'.includes(escaped)) invalid();
      } else if (character.charCodeAt(0) < 32) invalid();
    }
    invalid();
  };
  const value = depth => {
    if (depth > TWOC2P_JWT_LIMITS.jsonDepth || ++values > TWOC2P_JWT_LIMITS.jsonValues) invalid();
    whitespace();
    const character = text[index];
    if (character === '{') {
      index++; whitespace();
      const names = new Set();
      if (text[index] === '}') { index++; return; }
      while (true) {
        whitespace();
        const name = string();
        if (names.has(name)) invalid();
        names.add(name); whitespace();
        if (text[index++] !== ':') invalid();
        value(depth + 1); whitespace();
        const next = text[index++];
        if (next === '}') return;
        if (next !== ',') invalid();
      }
    }
    if (character === '[') {
      index++; whitespace();
      if (text[index] === ']') { index++; return; }
      while (true) {
        value(depth + 1); whitespace();
        const next = text[index++];
        if (next === ']') return;
        if (next !== ',') invalid();
      }
    }
    if (character === '"') { string(); return; }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(index));
    if (!primitive) invalid();
    index += primitive[0].length;
  };
  value(0); whitespace();
  if (index !== text.length) invalid();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) { invalid(); }
  if (!plainObject(parsed)) invalid();
  // JSON permits numeric literals outside JS's finite range. Never hand an
  // Infinity amount (or nested value) to the payment adapter.
  const finiteNumbers = item => {
    if (typeof item === 'number' && !Number.isFinite(item)) invalid();
    if (item && typeof item === 'object') Object.values(item).forEach(finiteNumbers);
  };
  finiteNumbers(parsed);
  return parsed;
}

// Reuse the same duplicate-key-safe object parser for the provider's
// { payload: JWT } envelope. The HTTP adapter must also bound its input stream.
export function parse2c2pJson(text, maximum = TWOC2P_JWT_LIMITS.jsonBytes) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > TWOC2P_JWT_LIMITS.jsonBytes ||
      typeof text !== 'string' || text.length > maximum) invalid();
  const bytes = encoder.encode(text);
  if (bytes.byteLength > maximum) invalid();
  // Native strings with lone surrogates must not silently change on encoding.
  if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== text) invalid();
  return parseJson(bytes);
}

async function signingKey(secret, usage) {
  if (typeof secret !== 'string') fail('2C2P signing boundary is not configured', 503);
  const bytes = encoder.encode(secret);
  if (bytes.byteLength < TWOC2P_JWT_LIMITS.secretMinBytes ||
      bytes.byteLength > TWOC2P_JWT_LIMITS.secretMaxBytes)
    fail('2C2P signing boundary is not configured', 503);
  try {
    return await crypto.subtle.importKey('raw', bytes,
      { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
  } catch (_) { fail('2C2P signing boundary is unavailable', 503); }
}

function requestJson(payload) {
  if (!plainObject(payload)) fail('Invalid 2C2P request payload', 400);
  const seen = new Set();
  let values = 0;
  const check = (item, depth) => {
    if (depth > TWOC2P_JWT_LIMITS.jsonDepth || ++values > TWOC2P_JWT_LIMITS.jsonValues)
      fail('Invalid 2C2P request payload', 400);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || (!Array.isArray(item) && !plainObject(item)) || seen.has(item))
      fail('Invalid 2C2P request payload', 400);
    seen.add(item);
    if (Reflect.ownKeys(item).some(key => typeof key !== 'string'))
      fail('Invalid 2C2P request payload', 400);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        fail('Invalid 2C2P request payload', 400);
      check(descriptor.value, depth + 1);
    }
    // Sparse arrays and extra array properties have surprising JSON behavior.
    if (Array.isArray(item) && (Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, offset) => key !== String(offset))))
      fail('Invalid 2C2P request payload', 400);
    seen.delete(item);
  };
  check(payload, 0);
  const bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.byteLength > TWOC2P_JWT_LIMITS.payloadBytes)
    fail('2C2P request payload too large', 413);
  return bytes;
}

export async function sign2c2pJwt(payload, secret) {
  const key = await signingKey(secret, 'sign');
  const header = encodeBase64url(encoder.encode('{"alg":"HS256","typ":"JWT"}'));
  const body = encodeBase64url(requestJson(payload));
  const input = `${header}.${body}`;
  let signature;
  try { signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(input))); }
  catch (_) { fail('2C2P signing boundary is unavailable', 503); }
  const token = `${input}.${encodeBase64url(signature)}`;
  if (token.length > TWOC2P_JWT_LIMITS.tokenBytes) fail('2C2P request payload too large', 413);
  return token;
}

export async function verify2c2pJwt(token, secret, now = Date.now()) {
  const key = await signingKey(secret, 'verify');
  if (typeof token !== 'string' || token.length > TWOC2P_JWT_LIMITS.tokenBytes) invalid();
  const parts = token.split('.');
  if (parts.length !== 3) invalid();
  const header = parseJson(decodeBase64url(parts[0], TWOC2P_JWT_LIMITS.headerBytes));
  if (header.alg !== 'HS256' || (Object.hasOwn(header, 'typ') && header.typ !== 'JWT') ||
      Object.keys(header).some(name => name !== 'alg' && name !== 'typ')) invalid();
  const payload = decodeBase64url(parts[1], TWOC2P_JWT_LIMITS.payloadBytes);
  const signature = decodeBase64url(parts[2], 32);
  if (signature.byteLength !== 32) invalid();
  let valid;
  try { valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${parts[0]}.${parts[1]}`)); }
  catch (_) { invalid(); }
  if (!valid) invalid();
  // Official 2C2P examples do not require registered JWT claims. When present,
  // honor their NumericDate semantics; missing claims are never invented.
  const parsed = parseJson(payload);
  if (!Number.isSafeInteger(now) || now < 0) invalid();
  const seconds = now / 1000;
  for (const name of ['exp', 'nbf', 'iat']) {
    if (!Object.hasOwn(parsed, name)) continue;
    if (!Number.isSafeInteger(parsed[name]) ||
        (name === 'exp' && parsed[name] <= seconds) ||
        (name !== 'exp' && parsed[name] > seconds)) invalid();
  }
  // Merchant, invoice, checkout expiry and replay checks remain adapter duties.
  return parsed;
}
