'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, webcrypto } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
globalThis.crypto ||= webcrypto;
const moduleReady = import(pathToFileURL(path.join(__dirname, '../../src/worker/twoc2p-jwt.mjs')));
const SYNTHETIC_SECRET = 'synthetic-2c2p-test-only-sha-key-do-not-use';
const OTHER_SECRET = 'synthetic-other-2c2p-test-key-do-not-use';
const body = () => ({ merchantID: 'synthetic-merchant', invoiceNo: 'synthetic-invoice-001',
  description: 'VIP calendar month', amount: 50, currencyCode: 'THB' });
const b64 = text => Buffer.from(text).toString('base64url');
function independentToken(payload, header = '{"alg":"HS256","typ":"JWT"}', secret = SYNTHETIC_SECRET) {
  const input = `${b64(header)}.${b64(typeof payload === 'string' ? payload : JSON.stringify(payload))}`;
  return input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
}
const rejected = async token => {
  const { verify2c2pJwt } = await moduleReady;
  await assert.rejects(verify2c2pJwt(token, SYNTHETIC_SECRET), error =>
    error.name === 'Twoc2pJwtError' && error.status === 401 && error.message === 'Invalid 2C2P signed payload');
};

test('2C2P signs documented HS256 compact JWT independently verifiable with the literal SHA key', async () => {
  const { sign2c2pJwt, verify2c2pJwt } = await moduleReady;
  const payload = body();
  const signed = await sign2c2pJwt(payload, SYNTHETIC_SECRET);
  assert.equal(signed, independentToken(payload));
  assert.deepEqual(await verify2c2pJwt(signed, SYNTHETIC_SECRET), payload);
  const hexLookingFixture = 'ab'.repeat(32);
  const literalSigned = await sign2c2pJwt(payload, hexLookingFixture);
  assert.equal(literalSigned, independentToken(payload, undefined, hexLookingFixture));
  assert.notEqual(literalSigned, independentToken(payload, undefined, Buffer.from(hexLookingFixture, 'hex')));
});

test('2C2P verifies independently signed backend JSON with amount strings and without invented exp or iat claims', async () => {
  const { verify2c2pJwt } = await moduleReady;
  const payload = { merchantID: 'synthetic-merchant', invoiceNo: 'synthetic-invoice-001',
    amount: '50.00', currencyCode: 'THB', tranRef: 'synthetic-transaction',
    transactionDateTime: '20261013080508', respCode: '0000', respDesc: 'Success' };
  assert.deepEqual(await verify2c2pJwt(independentToken(payload), SYNTHETIC_SECRET), payload);
  assert.deepEqual(await verify2c2pJwt(independentToken(payload, '{"alg":"HS256"}'), SYNTHETIC_SECRET), payload);
});

test('2C2P honors optional exp, nbf and iat NumericDates without requiring registered claims', async () => {
  const { verify2c2pJwt } = await moduleReady;
  const now = 1800000000123;
  const seconds = Math.floor(now / 1000);
  for (const payload of [body(), { ...body(), exp: seconds + 1 },
    { ...body(), nbf: seconds }, { ...body(), iat: seconds },
    { ...body(), exp: seconds + 1, nbf: seconds - 1, iat: seconds - 1 }])
    assert.deepEqual(await verify2c2pJwt(independentToken(payload), SYNTHETIC_SECRET, now), payload);
  for (const fields of [{ exp: seconds }, { exp: seconds - 1 }, { nbf: seconds + 1 }, { iat: seconds + 1 }])
    await assert.rejects(verify2c2pJwt(independentToken({ ...body(), ...fields }), SYNTHETIC_SECRET, now),
      error => error.status === 401);
  for (const name of ['exp', 'nbf', 'iat']) {
    for (const value of ['1800000000', null, true, 1800000000.5, Number.MAX_SAFE_INTEGER + 1, {}, []])
      await assert.rejects(verify2c2pJwt(independentToken({ ...body(), [name]: value }), SYNTHETIC_SECRET, now),
        error => error.status === 401);
  }
  for (const invalidNow of [NaN, -1, Infinity, '1800000000123', 0.5])
    await assert.rejects(verify2c2pJwt(independentToken(body()), SYNTHETIC_SECRET, invalidNow),
      error => error.status === 401);
});

test('2C2P strict envelope parser rejects duplicate keys, non-objects and caller/global byte limits', async () => {
  const { parse2c2pJson, TWOC2P_JWT_LIMITS } = await moduleReady;
  const envelope = { payload: independentToken(body()) };
  assert.deepEqual(parse2c2pJson(JSON.stringify(envelope)), envelope);
  assert.deepEqual(parse2c2pJson('{}', 2048), {});
  assert.deepEqual(parse2c2pJson(' {"value":"🧪"} ', 2048), { value: '🧪' });
  for (const text of ['{"payload":"a","payload":"b"}', '{"payload":"a","paylo\\u0061d":"b"}',
    '{"nested":{"amount":50,"amount":1}}', '', '[]', 'null', '\ufeff{}',
    '{"value":"\ud800"}', '{', '{} trailing', '{"amount":1e999}', 'x'.repeat(TWOC2P_JWT_LIMITS.jsonBytes + 1)])
    assert.throws(() => parse2c2pJson(text), error => error.status === 401 &&
      error.message === 'Invalid 2C2P signed payload');
  assert.throws(() => parse2c2pJson(JSON.stringify({ text: 'x'.repeat(2048) }), 2048), error => error.status === 401);
  assert.throws(() => parse2c2pJson(JSON.stringify({ text: '🧪'.repeat(512) }), 2048), error => error.status === 401);
  for (const maximum of [0, -1, 1.5, NaN, TWOC2P_JWT_LIMITS.jsonBytes + 1])
    assert.throws(() => parse2c2pJson('{}', maximum), error => error.status === 401);
});

test('2C2P preserves Unicode, nested JSON and exact provider field types in signed requests', async () => {
  const { sign2c2pJwt, verify2c2pJwt } = await moduleReady;
  const payload = { ...body(), description: 'วีไอพี € 🧪', data: [null, true, false, 0, -1.5,
    { optional: 'tab\tnewline\nquote"slash\\' }] };
  assert.deepEqual(await verify2c2pJwt(await sign2c2pJwt(payload, SYNTHETIC_SECRET), SYNTHETIC_SECRET), payload);
  const nullPrototype = Object.assign(Object.create(null), body());
  assert.deepEqual(await verify2c2pJwt(await sign2c2pJwt(nullPrototype, SYNTHETIC_SECRET), SYNTHETIC_SECRET), body());
});

test('2C2P cryptographic verification rejects changed amount, wrong key and changed signature', async () => {
  const { verify2c2pJwt } = await moduleReady;
  const signed = independentToken(body());
  const [header, , signature] = signed.split('.');
  await rejected(`${header}.${b64(JSON.stringify({ ...body(), amount: 1 }))}.${signature}`);
  await rejected(independentToken(body(), undefined, OTHER_SECRET));
  await rejected(`${header}.${b64(JSON.stringify(body()))}.${b64(Buffer.alloc(32))}`);
  await assert.rejects(verify2c2pJwt(signed, OTHER_SECRET), error => error.status === 401);
});

test('2C2P rejects none and algorithm confusion, key-discovery URLs and critical or unencoded headers', async () => {
  for (const header of [
    { alg: 'none', typ: 'JWT' }, { alg: 'HS512', typ: 'JWT' }, { alg: 'RS256', typ: 'JWT' },
    { alg: 'hs256', typ: 'JWT' }, { alg: 'HS256', typ: 'JWE' }, { alg: 'HS256', typ: null },
    { alg: 'HS256', kid: 'synthetic-key' }, { alg: 'HS256', jku: 'https://synthetic.invalid/key' },
    { alg: 'HS256', jwk: {} }, { alg: 'HS256', x5u: 'https://synthetic.invalid/cert' },
    { alg: 'HS256', crit: [] }, { alg: 'HS256', b64: false }, {}, []
  ]) await rejected(independentToken(body(), JSON.stringify(header)));
  await rejected(`${b64('{"alg":"none"}')}.${b64(JSON.stringify(body()))}.`);
});

test('2C2P rejects duplicate and escaped duplicate signed JSON properties at every depth', async () => {
  for (const header of ['{"alg":"HS256","alg":"HS256"}',
    '{"alg":"HS256","a\\u006cg":"HS256"}', '{"alg":"HS256","typ":"JWT","typ":"JWT"}'])
    await rejected(independentToken(body(), header));
  for (const payload of [
    '{"amount":50,"amount":1}', '{"merchantID":"first","merchant\\u0049D":"second"}',
    '{"meta":{"invoiceNo":"one","invoiceNo":"two"}}',
    '{"values":[{"respCode":"0000","respCode":"9999"}]}'
  ]) await rejected(independentToken(payload));
});

test('2C2P rejects malformed signed JSON, non-object payloads and non-finite numeric literals', async () => {
  for (const payload of ['null', 'true', '50', '"text"', '[]', '[{}]', '{', '{}x', '\ufeff{}',
    '{"amount":50,}', '{"amount":01}', '{"amount":+50}', '{"amount":NaN}',
    '{"amount":Infinity}', '{"amount":1e999}', '{"nested":[1e999]}',
    '{"a":"bad\\xescape"}', '{"a":"bad\nnewline"}', '{"a":[1,]}'])
    await rejected(independentToken(payload));
  await rejected(independentToken(body(), '{"alg":"HS256",}'));
});

test('2C2P rejects noncanonical base64url, padding, extra segments and malformed signature lengths', async () => {
  const valid = independentToken(body());
  const [header, payload, signature] = valid.split('.');
  const lastIndex = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(signature.at(-1));
  const alternateSignature = signature.slice(0, -1) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[lastIndex | 1];
  assert.deepEqual(Buffer.from(alternateSignature, 'base64url'), Buffer.from(signature, 'base64url'));
  for (const token of ['', null, {}, 'a.b.c', valid + '.extra', valid + '\n',
    ` ${valid}`, `${header}=.${payload}.${signature}`, `${header}.${payload}=.${signature}`,
    `${header}.${payload}.${signature}=`, `${header}.${payload}.${alternateSignature}`,
    `${header}.${payload}.${b64(Buffer.alloc(31))}`, `${header}.${payload}.${b64(Buffer.alloc(33))}`,
    `${header}.${payload}.$`, `${header}.+/.${signature}`, `${header}..${signature}`])
    await rejected(token);
});

test('2C2P rejects invalid UTF-8 inside independently authenticated signed payloads', async () => {
  const header = b64('{"alg":"HS256","typ":"JWT"}');
  const payload = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]).toString('base64url');
  const input = `${header}.${payload}`;
  await rejected(input + '.' + createHmac('sha256', SYNTHETIC_SECRET).update(input).digest('base64url'));
});

test('2C2P bounds signed token, decoded JSON, header, nesting and value count', async () => {
  const { sign2c2pJwt, TWOC2P_JWT_LIMITS } = await moduleReady;
  await rejected('x'.repeat(TWOC2P_JWT_LIMITS.tokenBytes + 1));
  await rejected(independentToken(body(), JSON.stringify({ alg: 'HS256', typ: 'JWT', extra: 'x'.repeat(1024) })));
  await rejected(independentToken({ text: 'x'.repeat(TWOC2P_JWT_LIMITS.payloadBytes) }));
  const nested = depth => ({ nested: depth ? nested(depth - 1) : 1 });
  await rejected(independentToken(nested(40)));
  await rejected(independentToken({ many: Array.from({ length: 2048 }, () => 1) }));
  await assert.rejects(sign2c2pJwt({ text: '🧪'.repeat(TWOC2P_JWT_LIMITS.payloadBytes / 4) }, SYNTHETIC_SECRET), error => error.status === 413);
  await assert.rejects(sign2c2pJwt(nested(40), SYNTHETIC_SECRET), error => error.status === 400);
});

test('2C2P signing refuses lossy or executable request JSON rather than silently changing server fields', async () => {
  const { sign2c2pJwt } = await moduleReady;
  let getterRan = false;
  const getter = { get amount() { getterRan = true; return 50; } };
  const circular = {}; circular.self = circular;
  const sparse = []; sparse[1] = 1;
  const extra = [1]; extra.extra = 2;
  const hidden = {}; Object.defineProperty(hidden, 'amount', { value: 50 });
  for (const payload of [null, [], { amount: NaN }, { amount: Infinity }, { amount: undefined },
    { amount: 50n }, { data: new Date() }, { data: () => 50 }, { data: Symbol('test') },
    { [Symbol('test')]: 50 }, { toJSON() { return body(); } }, getter, circular,
    { values: sparse }, { values: extra }, hidden])
    await assert.rejects(sign2c2pJwt(payload, SYNTHETIC_SECRET), error => error.status === 400);
  assert.equal(getterRan, false);
});

test('2C2P signing boundary refuses absent, weak, oversized and binary credential configuration', async () => {
  const { sign2c2pJwt, verify2c2pJwt } = await moduleReady;
  for (const secret of [undefined, '', 'short', Buffer.from(SYNTHETIC_SECRET), 'x'.repeat(4097)]) {
    await assert.rejects(sign2c2pJwt(body(), secret), error => error.status === 503);
    await assert.rejects(verify2c2pJwt(independentToken(body()), secret), error => error.status === 503);
  }
});

test('2C2P failure messages and serialization never include tokens, credentials or signed payment fields', async () => {
  const { verify2c2pJwt } = await moduleReady;
  const forged = independentToken({ invoiceNo: 'sensitive-fixture-invoice' }, undefined, OTHER_SECRET);
  try { await verify2c2pJwt(forged, SYNTHETIC_SECRET); assert.fail('Expected verification failure'); }
  catch (error) {
    const serialized = String(error) + JSON.stringify(error);
    for (const sensitive of [SYNTHETIC_SECRET, OTHER_SECRET, forged, 'sensitive-fixture-invoice'])
      assert.equal(serialized.includes(sensitive), false);
    assert.equal(error.name, 'Twoc2pJwtError');
  }
});
