'use strict';

// Local-only runtime adapter. Bundle the actual ESM graph with native import
// resolution, including the production entrypoint. No network fetch or saved key.
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { generateKeyPairSync, sign, webcrypto } = require('node:crypto');
const { buildSync } = require('esbuild');
const workerBundles = new Map();

const PROJECT_ID = 'rebuild-synthetic-project';
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const SLIP_URL = 'https://connect.slip2go.com/api/verify-slip/qr-image/info';
const NativeResponse = globalThis.Response;
let signingFixture;

function der(tag, body) {
  let size = body.length;
  const bytes = [];
  if (size < 128) bytes.push(size);
  else {
    while (size) { bytes.unshift(size & 255); size >>>= 8; }
    bytes.unshift(0x80 | bytes.length);
  }
  return Buffer.concat([Buffer.from([tag, ...bytes]), body]);
}

function firebaseFixture() {
  if (signingFixture) return signingFixture;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // Minimal synthetic X.509-shaped DER containing a real RSA SPKI. The worker
  // extracts SPKI; certificate trust is supplied by the isolated mock fetch.
  const skippedFields = Array.from({ length: 5 }, () => der(0x30, Buffer.alloc(0)));
  const certificate = der(0x30, der(0x30, Buffer.concat([...skippedFields, spki])));
  signingFixture = {
    privateKey,
    kid: 'rebuild-synthetic-rsa-key',
    certificate: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64')}\n-----END CERTIFICATE-----`
  };
  return signingFixture;
}

class WorkerResponse extends NativeResponse {
  constructor(body, init = {}) {
    if (init.status === 101) {
      super(null, { status: 200, headers: init.headers });
      Object.defineProperty(this, 'status', { value: 101 });
      Object.defineProperty(this, 'ok', { value: false });
      this.webSocket = init.webSocket;
    } else super(body, init);
  }
}

class MockSocket {
  constructor() {
    this.peer = null;
    this.inbox = [];
    this.listeners = new Map();
    this.closed = false;
    this.closeInfo = null;
    this.attachment = null;
    this.readyState = 1;
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatch(type, event) {
    this[`on${type}`]?.(event);
    for (const callback of this.listeners.get(type) || []) callback(event);
  }
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  send(data) {
    if (this.closed || this.peer?.closed) throw Error('Mock WebSocket is closed');
    if (this.onClientSend) return this.onClientSend(data);
    this.peer.inbox.push(String(data));
    this.peer.dispatch('message', { data: String(data) });
  }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    for (const socket of [this, this.peer]) {
      if (!socket || socket.closed) continue;
      socket.closed = true;
      socket.readyState = 3;
      socket.closeInfo = { code, reason };
      socket.dispatch('close', { code, reason, wasClean: code === 1000 });
    }
  }
}

class MockWebSocketPair {
  constructor() {
    this[0] = new MockSocket();
    this[1] = new MockSocket();
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

function createStorage() {
  const db = new DatabaseSync(':memory:');
  const kv = new Map();
  let transactionDepth = 0;
  return {
    db,
    sql: {
      exec(query, ...bindings) {
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows.map(row => ({ ...row })), [Symbol.iterator]: () => rows[Symbol.iterator]() };
      }
    },
    async get(key) { return structuredClone(kv.get(key)); },
    async put(key, value) { kv.set(key, structuredClone(value)); },
    async delete(key) { return kv.delete(key); },
    transactionSync(callback) {
      if (transactionDepth) return callback();
      db.exec('BEGIN IMMEDIATE');
      transactionDepth++;
      try {
        const result = callback();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally { transactionDepth--; }
    }
  };
}

function createHarness(options = {}) {
  let currentTime = options.now ?? 1_900_000_000_000;
  let uuidCounter = 0;
  let randomState = options.randomSeed ?? 0x12345678;
  let timerCounter = 0;
  const pending = new Set();
  const timers = new Map();
  const records = { fetches: [], routes: [], logs: [] };
  const fixture = firebaseFixture();
  let slipResult = options.slipResult ?? {
    code: '200000',
    data: { amount: 50, transRef: 'synthetic-transaction-001', sender: { bank: { id: 'mock-bank' } } }
  };
  let slipStatus = options.slipStatus ?? 200;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  function track(promise) {
    const tracked = Promise.resolve(promise);
    pending.add(tracked);
    // Avoid unhandled-rejection races; settle() still propagates each rejection.
    tracked.catch(() => {});
    return tracked;
  }
  function setTimer(callback, delay = 0, interval = 0) {
    const id = ++timerCounter;
    timers.set(id, { callback, at: currentTime + Math.max(0, Number(delay) || 0), interval });
    return id;
  }
  async function advance(ms) {
    if (!Number.isFinite(ms) || ms < 0) throw Error('Clock advance must be finite and nonnegative');
    const target = currentTime + ms;
    let fired = 0;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      if (++fired > 100_000) throw Error('Synthetic timer loop exceeded harness limit');
      const [id, timer] = next;
      currentTime = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else timers.delete(id);
      await timer.callback();
      await settle();
    }
    currentTime = target;
    return currentTime;
  }
  async function settle() {
    for (let rounds = 0; pending.size; rounds++) {
      if (rounds > 1000) throw Error('waitUntil did not settle');
      const batch = [...pending];
      batch.forEach(promise => pending.delete(promise));
      const results = await Promise.allSettled(batch);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
  }
  async function mockFetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    records.fetches.push({ url: request.url, method: request.method });
    if (request.url === CERTS_URL) return NativeResponse.json({ [fixture.kid]: fixture.certificate }, {
      headers: { 'cache-control': 'public, max-age=3600' }
    });
    if (request.url === SLIP_URL) {
      if (request.headers.get('Authorization') !== 'synthetic-slip-secret') throw Error('Only synthetic payment credentials allowed');
      return NativeResponse.json(slipResult, { status: slipStatus });
    }
    throw Error(`External traffic denied by rebuild harness: ${request.url}`);
  }
  const runtimeCrypto = {
    subtle: webcrypto.subtle,
    randomUUID() { return `00000000-0000-4000-8000-${(++uuidCounter).toString(16).padStart(12, '0')}`; },
    getRandomValues(array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        bytes[i] = randomState & 255;
      }
      return array;
    }
  };
  const context = vm.createContext({
    Request, Response: WorkerResponse, Headers, URL, URLSearchParams,
    FormData, File, Blob, TextEncoder, TextDecoder, atob, btoa,
    crypto: runtimeCrypto, fetch: mockFetch, Date: FakeDate,
    WebSocketPair: MockWebSocketPair, structuredClone,
    setTimeout: (callback, delay) => setTimer(callback, delay), clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => setTimer(callback, delay, Math.max(1, Number(delay) || 1)), clearInterval: id => timers.delete(id),
    performance: { now: () => currentTime - (options.now ?? 1_900_000_000_000) },
    console: Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(level => [level, (...args) => records.logs.push({ level, args })]))
  });
  const workerPath = options.workerPath ?? path.resolve(__dirname, '../../worker.js');
  if (!workerBundles.has(workerPath)) {
    workerBundles.set(workerPath, buildSync({ entryPoints: [workerPath], bundle: true,
      write: false, format: 'iife', globalName: '__workerModule', platform: 'neutral',
      banner: { js: '"use strict";' } }).outputFiles[0].text);
  }
  const source = workerBundles.get(workerPath);
  vm.runInContext(`${source}\n;globalThis.__runtime = {worker: __workerModule.default, GameRoom: __workerModule.GameRoom, ZoneRoom: __workerModule.ZoneRoom, verifyFirebaseIdToken: __workerModule.verifyFirebaseIdToken};`, context, { filename: workerPath });
  const runtime = context.__runtime;
  const rooms = new Map();
  const zones = new Map();
  const allStores = new Set();
  const env = {
    FIREBASE_PROJECT_ID: PROJECT_ID,
    ALLOWED_ORIGIN: options.allowedOrigin ?? 'https://rebuild.invalid',
    SLIP2GO_API_SECRET: 'synthetic-slip-secret',
    PAYMENT_RECEIVER_ACCOUNT: 'synthetic-test-receiver',
    ...options.env
  };
  function namespace(Class, instances, binding) {
    function object(name) {
      if (!instances.has(name)) {
        const storage = createStorage();
        allStores.add(storage);
        const ctx = {
          id: { name }, storage, sockets: [],
          blockConcurrencyWhile: callback => Promise.resolve().then(callback),
          acceptWebSocket(ws) { this.sockets.push(ws); },
          getWebSockets() { return this.sockets.filter(ws => !ws.closed); },
          waitUntil: track
        };
        instances.set(name, { instance: new Class(ctx, env), ctx });
      }
      return instances.get(name);
    }
    return {
      getByName(name) {
        return { async fetch(request) {
          records.routes.push({ binding, name, path: new URL(request.url).pathname });
          return object(name).instance.fetch(request);
        } };
      },
      object
    };
  }
  env.ROOM = namespace(runtime.GameRoom, rooms, 'ROOM');
  env.ZONE = namespace(runtime.ZoneRoom, zones, 'ZONE');
  function token(uid = 'synthetic-user', overrides = {}, headerOverrides = {}) {
    const now = Math.floor(currentTime / 1000);
    const header = { alg: 'RS256', kid: fixture.kid, ...headerOverrides };
    const claims = {
      aud: PROJECT_ID, iss: `https://securetoken.google.com/${PROJECT_ID}`,
      sub: uid, exp: now + 3600, iat: now - 1, auth_time: now - 1, ...overrides
    };
    const content = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return `${content}.${sign('RSA-SHA256', Buffer.from(content), fixture.privateKey).toString('base64url')}`;
  }
  async function request(pathname, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has('Origin')) headers.set('Origin', env.ALLOWED_ORIGIN);
    return runtime.worker.fetch(new Request(`https://rebuild-worker.invalid${pathname}`, { ...init, headers }), env);
  }
  async function open(pathname = '/play') {
    const response = await request(pathname, { headers: { Upgrade: 'websocket' } });
    if (response.status !== 101) throw Error(`Local WebSocket upgrade rejected: ${response.status} ${await response.text()}`);
    const client = response.webSocket;
    const server = client.peer;
    const zoneId = new URL(`https://rebuild-worker.invalid${pathname}`).searchParams.get('zone');
    const instance = zoneId === null ? env.ROOM.object('free-v2-demo').instance : env.ZONE.object(`free-zone-${zoneId}`).instance;
    const connection = {
      client, server, instance,
      async send(value) {
        const message = typeof value === 'string' ? value : JSON.stringify(value);
        if (server.closed) throw Error('Cannot send to a closed mock socket');
        await instance.webSocketMessage(server, message);
        await settle();
      },
      messages(type) {
        const messages = client.inbox.map(value => JSON.parse(value));
        return type ? messages.filter(message => message.type === type) : messages;
      },
      clear() { client.inbox.length = 0; },
      attachment() { return server.deserializeAttachment(); },
      async close() { await instance.webSocketClose(server); await settle(); }
    };
    client.onClientSend = value => connection.send(value);
    return connection;
  }
  async function connect(input = {}) {
    const connection = await open(input.zone ? `/play?zone=${encodeURIComponent(input.zone)}` : '/play');
    if (input.auth !== false) await connection.send({ type: 'auth', token: input.token ?? token(input.uid), name: input.name ?? 'Test player', ...(input.handoffToken ? { handoffToken: input.handoffToken } : {}) });
    return connection;
  }
  function place(connection, position) {
    // Explicit server fixture, never a client command or a substitute for a
    // movement test. Lets economy tests start at an actual generated item.
    const player = connection.attachment();
    Object.assign(player, position, { at: currentTime, last: 0 });
    connection.server.serializeAttachment(player);
    return player;
  }
  function restartRoom({ keepSockets = false } = {}) {
    const entry = env.ROOM.object('free-v2-demo');
    if (!keepSockets) {
      entry.ctx.sockets.forEach(ws => ws.close(1012, 'Synthetic restart'));
      entry.ctx.sockets.length = 0;
    }
    entry.instance = new runtime.GameRoom(entry.ctx, env);
    return entry.instance;
  }
  return {
    env, worker: runtime.worker, runtime, records, context, token, request, open, connect, place,
    advance, settle, now: () => currentTime,
    setTime(value) { if (value < currentTime) throw Error('Synthetic clock cannot move backwards'); return advance(value - currentTime); },
    room: () => env.ROOM.object('free-v2-demo').instance,
    zone: zoneId => env.ZONE.object(`free-zone-${zoneId}`).instance,
    restartRoom,
    setSlipResult(result, status = 200) { slipResult = result; slipStatus = status; },
    async close() { await settle(); for (const storage of allStores) storage.db.close(); }
  };
}

module.exports = { createHarness, PROJECT_ID, CERTS_URL, SLIP_URL };
