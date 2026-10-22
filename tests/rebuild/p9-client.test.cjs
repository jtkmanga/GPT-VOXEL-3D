'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const { buildClient } = require('../../scripts/rebuild/build-client.cjs');
const { buildStagingClient } = require('../../scripts/rebuild/build-staging-client.cjs');
const { validateStagingPublicConfig, STAGING_UNCONFIGURED } = require('../../src/shared/staging.mjs');
const protocol = require('../../src/shared/protocol.mjs');

const publicFixture = authMode => ({ environment: 'staging', workerName: 'gpt-voxel-3d-staging-p9-fixture',
  workerOrigin: 'https://gpt-voxel-3d-staging-p9-fixture.invalid',
  firebase: { apiKey: 'synthetic-public-staging-key', authDomain: 'voxel-staging-fixture.firebaseapp.com',
    projectId: 'voxel-staging-fixture', appId: '1:123456789:web:abcdef1234567890' },
  appCheck: { provider: 'recaptcha-enterprise', siteKey: '6L' + 'A'.repeat(38) },
  authMode: authMode || 'popup' });
const inline = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];

function runtimeFixture({ enabled = true, mode = 'popup' } = {}) {
  const events = [], elements = new Map(), windowListeners = new Map(), documentListeners = new Map();
  let epoch = 7, release;
  const user = { uid: 'synthetic-staging-browser-user', getIdToken: async () => 'synthetic-staging-token' };
  const ws = { readyState: 1, sent: [], send(value) { this.sent.push(JSON.parse(value)); } };
  function element(id) {
    if (!elements.has(id)) elements.set(id, { disabled: false, src: '', innerText: '' });
    return elements.get(id);
  }
  const auth = { currentUser: user,
    signInWithPopup: async () => events.push('popup'), signInWithRedirect: async () => events.push('redirect'),
    getRedirectResult: async () => events.push('redirect-result'), signOut: async () => events.push('sign-out') };
  const context = vm.createContext({ STAGING_PUBLIC_CONFIG: publicFixture(mode), STAGING_CLIENT_ENABLED: enabled,
    protocol, auth, googleProvider: {}, WebSocket: { OPEN: 1 },
    state: { isPlaying: true, selectedServerId: 'free1' },
    keys: { w: true, a: false, s: true, d: false }, joystickVec: { x: 1, y: -1 },
    secureJumpIntent: true, secureJumpHeld: true, secureGameSocket: ws,
    secureCurrentZoneId: '5,5', secureReconnectInProgress: false,
    document: { hidden: false, getElementById: element, addEventListener: (key, fn) => documentListeners.set(key, fn) },
    window: { addEventListener: (key, fn) => windowListeners.set(key, fn) },
    alert: message => events.push(message), startGame: async () => { events.push('start'); return true; },
    secureConnectionEpoch: () => epoch, secureConnectionIsCurrent: value => value === epoch,
    secureResumeDisconnectedSocket: async (...values) => { events.push(['resume', ...values]); return true; },
    secureCloseSocket: (_socket, code) => events.push(['close', code]),
    secureReturnToMenu: () => events.push('menu'),
    secureAbortClientConnections: () => { epoch++; context.secureGameSocket = null; events.push('abort'); }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/client/staging-runtime.js'), 'utf8'), context);
  return { context, auth, ws, user, events, element, windowListeners, documentListeners,
    bumpEpoch() { epoch++; }, holdToken() { user.getIdToken = () => new Promise(resolve => { release = resolve; }); },
    releaseToken() { user.getIdToken = async () => 'synthetic-staging-token'; release('synthetic-staging-token'); } };
}

test('P9 staging generation leaves the default generated P0-P8 client byte-for-byte unchanged', async () => {
  assert.equal(await buildClient(), fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8'));
  await buildStagingClient(STAGING_UNCONFIGURED);
  assert.equal(await buildClient(), fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8'));
});

test('P9 public manifest requires isolated matching staging Worker and Firebase project/domain', () => {
  const source = publicFixture();
  assert.deepEqual(validateStagingPublicConfig(source, { allowTest: true }), source);
  assert.throws(() => validateStagingPublicConfig(source), /origin must match/);
  const liveShape = { ...source, workerOrigin: 'https://gpt-voxel-3d-staging-p9-fixture.approved-account.workers.dev',
    firebase: { ...source.firebase, apiKey: 'AIza' + 'A'.repeat(35) } };
  assert.equal(validateStagingPublicConfig(liveShape).workerOrigin, liveShape.workerOrigin);
  for (const values of [
    { environment: 'production' }, { workerName: 'voxel-run-v2-demo' },
    { workerOrigin: 'https://voxel-run-v2-demo.hjinffv5426.workers.dev' },
    { workerOrigin: 'http://localhost:8787' }, { workerOrigin: source.workerOrigin + '/play' },
    { workerOrigin: 'https://user:password@gpt-voxel-3d-staging-p9-fixture.invalid' },
    { workerOrigin: 'https://gpt-voxel-3d-staging-other.approved-account.workers.dev' },
    { firebase: { ...source.firebase, projectId: 'lucky-game-6936b' } },
    { firebase: { ...source.firebase, apiKey: 'AIzaSyCwn4rJ48I_bsVI2Ez59szQJubShvhO1SE' } },
    { firebase: { ...source.firebase, appId: '1:541211602508:web:b41b55fb5462269fbc4ee9' } },
    { firebase: { ...source.firebase, appId: '1:541211602508:web:abcdef1234567890' } },
    { firebase: { ...source.firebase, messagingSenderId: '541211602508' } },
    { firebase: { ...source.firebase, messagingSenderId: '999999' } },
    { firebase: { ...source.firebase, authDomain: 'other-staging.firebaseapp.com' } },
    { appCheck: { provider: 'recaptcha-v3', siteKey: source.appCheck.siteKey } },
    { appCheck: { provider: 'recaptcha-enterprise', siteKey: 'invalid-site-key' } },
    { authMode: 'invented-flow' }
  ]) assert.throws(() => validateStagingPublicConfig({ ...source, ...values }, { allowTest: true }));
});

test('P9 public manifest rejects unknown privileged fields and unconfigured fallback data', () => {
  const source = publicFixture();
  for (const field of ['PAYMENT_WEBHOOK_SECRET', 'FIREBASE_ADMIN_PRIVATE_KEY', 'client_secret', 'databaseURL', 'production']) {
    assert.throws(() => validateStagingPublicConfig({ ...source, [field]: 'synthetic-forbidden-value' }, { allowTest: true }));
    assert.throws(() => validateStagingPublicConfig({ ...source, firebase: { ...source.firebase, [field]: 'synthetic-forbidden-value' } }, { allowTest: true }));
  }
  assert.throws(() => validateStagingPublicConfig(STAGING_UNCONFIGURED));
  assert.equal(validateStagingPublicConfig(STAGING_UNCONFIGURED, { allowUnconfigured: true }), STAGING_UNCONFIGURED);
  assert.throws(() => validateStagingPublicConfig({ ...STAGING_UNCONFIGURED, firebase: source.firebase }, { allowUnconfigured: true }));
});

test('P9 staging bundle removes production Firebase/Worker defaults and contains valid isolated executable syntax', async () => {
  const html = await buildStagingClient(publicFixture(), { allowTest: true });
  acorn.parse(inline(html), { ecmaVersion: 'latest' });
  assert.match(html, /gpt-voxel-3d-staging-p9-fixture\.invalid/);
  assert.match(html, /Free Server ฟรีไม่จำกัด/); assert.match(html, /ไม่จำกัดผู้เล่น/);
  assert.match(html, /50 บาท\/เดือน/); assert.match(html, /0\/100/);
  assert.match(html, /firebase-app-check-compat\.js/);
  assert.match(html, /ReCaptchaEnterpriseProvider/);
  assert.match(html, /appCheck\.activate/);
  for (const forbidden of ['lucky-game-6936b', 'voxel-run-v2-demo', 'localhost', '127.0.0.1',
    'PAYMENT_WEBHOOK_SECRET', 'SLIP2GO_API_SECRET', 'FIREBASE_ADMIN_PRIVATE_KEY', '0999999999']) assert.ok(!html.includes(forbidden), forbidden);
  const disabled = await buildStagingClient(STAGING_UNCONFIGURED);
  assert.match(disabled, /"configured":false/);
  assert.ok(!disabled.includes('synthetic-public-staging-key'));
});

test('P9 disabled scaffold blocks authentication and gameplay without initializing a fallback SDK', async () => {
  const f = runtimeFixture({ enabled: false });
  assert.equal(await f.context.loginWithGoogle(), false); assert.equal(await f.context.startGame(), false);
  assert.equal(f.element('btn-google-login').disabled, true); assert.equal(f.element('btn-start-game').disabled, true);
  assert.equal(f.events.includes('popup'), false); assert.equal(f.events.includes('start'), false);
  assert.match(f.element('staging-status').innerText, /NOT CONFIGURED/);
});

test('P9 Google popup and mobile redirect invoke only the configured SDK flow and redact SDK errors', async () => {
  const popup = runtimeFixture(); assert.equal(await popup.context.loginWithGoogle(), true);
  assert.equal(popup.events.filter(value => value === 'popup').length, 1); assert.equal(popup.events.includes('redirect'), false);
  const redirect = runtimeFixture({ mode: 'redirect' }); await Promise.resolve();
  assert.equal(await redirect.context.loginWithGoogle(), true); assert.ok(redirect.events.includes('redirect-result'));
  assert.equal(redirect.events.includes('popup'), false); assert.ok(redirect.events.includes('redirect'));
  redirect.auth.signInWithRedirect = async () => { throw Error('sensitive SDK token must not appear'); };
  assert.equal(await redirect.context.loginWithGoogle(), false);
  assert.ok(!JSON.stringify(redirect.events).includes('sensitive SDK token'));
});

test('P9 every staging purchase entrypoint is disabled for speed, coins and VIP with no QR or slip action', async () => {
  const f = runtimeFixture();
  for (const type of ['speed', 'coin', 'vip1']) assert.equal(f.context.openPaymentModal(type, 1, 'forged'), false);
  assert.equal(await f.context.verifyAndBuySlip(), false); assert.equal(f.context.grantPurchasedItem(), false);
  assert.equal(f.element('slip-file-input').disabled, true); assert.equal(f.element('btn-verify-slip').disabled, true);
  assert.equal(f.element('promptpay-qr-img').src, ''); assert.equal(f.ws.sent.length, 0);
});

test('P9 foreground refresh deduplicates and fences captured SDK identity, socket and connection generation', async () => {
  for (const replacement of ['identity', 'epoch', 'socket', 'server']) {
    const f = runtimeFixture(); f.holdToken();
    const one = f.context.stagingResumeForeground(), two = f.context.stagingResumeForeground();
    if (replacement === 'identity') f.auth.currentUser = { ...f.user };
    if (replacement === 'epoch') f.bumpEpoch();
    if (replacement === 'socket') f.context.secureGameSocket = { ...f.ws };
    if (replacement === 'server') f.context.state.selectedServerId = 'vip1';
    f.releaseToken(); assert.equal(await one, false); assert.equal(await two, false); assert.equal(f.ws.sent.length, 0);
  }
  const f = runtimeFixture(); f.holdToken();
  const one = f.context.stagingResumeForeground(), two = f.context.stagingResumeForeground();
  f.releaseToken(); assert.equal(await one, true); assert.equal(await two, true);
  assert.equal(f.ws.sent.length, 1); assert.equal(f.ws.sent[0].protocol, 6);
  f.context.state.selectedServerId = 'vip1'; assert.equal(await f.context.stagingResumeForeground(), true);
  assert.equal(f.ws.sent.at(-1).protocol, 4);
});

test('P9 background clears held input; persisted-page and online recovery reuse the original ownership scope', async () => {
  const f = runtimeFixture(); f.context.document.hidden = true;
  f.documentListeners.get('visibilitychange')();
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.keys)), { w: false, a: false, s: false, d: false });
  assert.equal(f.context.joystickVec.x, 0); assert.equal(f.context.secureJumpIntent, false); assert.equal(f.ws.sent.length, 0);
  f.windowListeners.get('pagehide')(); assert.ok(f.events.includes('abort'));
  f.context.document.hidden = false; f.windowListeners.get('pageshow')({ persisted: true });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.events.find(Array.isArray), ['resume', '5,5', f.user.uid, 'free1']);
  const offline = runtimeFixture(); offline.context.secureGameSocket = null;
  offline.context.secureReconnectInProgress = true;
  assert.equal(await offline.context.stagingResumeForeground(), false);
  assert.equal(offline.events.some(Array.isArray), false);
});

test('P9 staging exposes policy session revocation without exposing identifiers or confusing active handoff', () => {
  const f = runtimeFixture();
  f.context.stagingOnSocketClose(f.ws, { code: 1008, reason: 'Session replaced' });
  assert.equal(f.element('staging-status').innerText, 'STAGING · SESSION REVOKED · TEST PAYMENTS ONLY');
  f.element('staging-status').innerText = '';
  f.context.secureHandoffInProgress = true;
  f.context.stagingOnSocketClose(f.ws, { code: 1008, reason: 'Session ownership transferred' });
  assert.equal(f.element('staging-status').innerText, '');
  f.context.secureHandoffInProgress = false;
  f.context.stagingOnSocketClose(f.ws, { code: 1000, reason: 'normal close' });
  assert.equal(f.element('staging-status').innerText, '');
});

test('P9 foreground token failure retires the active socket without logging raw authentication material', async () => {
  const f = runtimeFixture(); f.user.getIdToken = async () => { throw Error('sensitive refresh material'); };
  assert.equal(await f.context.stagingResumeForeground(), false);
  assert.deepEqual(f.events, [['close', 1008], 'menu']); assert.equal(f.ws.sent.length, 0);
  assert.match(f.element('staging-status').innerText, /AUTH REFRESH FAILED/);
  assert.ok(!JSON.stringify(f.events).includes('sensitive refresh material'));
});

test('P9 generated staging token calls sanitize SDK failures before legacy error handlers receive them', async () => {
  const html = await buildStagingClient(publicFixture(), { allowTest: true });
  const ast = acorn.parse(inline(html), { ecmaVersion: 'latest' });
  const helper = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'stagingGetIdToken');
  assert.ok(helper);
  const context = vm.createContext({});
  vm.runInContext(inline(html).slice(helper.start, helper.end), context);
  const rawSdkError = 'sensitive SDK failure containing a token';
  await assert.rejects(context.stagingGetIdToken({ async getIdToken() { throw Error(rawSdkError); } }),
    error => error.message === 'Staging authentication token is unavailable.' && !error.message.includes(rawSdkError));
  assert.equal(await context.stagingGetIdToken({ async getIdToken() { return 'synthetic-valid-token'; } }), 'synthetic-valid-token');
  assert.match(html, /stagingGetIdToken\(auth.currentUser, true\)/);
  assert.match(html, /stagingGetIdToken\(user, forceTokenRefresh\)/);
});
