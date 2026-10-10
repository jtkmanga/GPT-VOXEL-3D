'use strict';

// Runs the original ws smoke tests against the actual worker classes in the
// offline VM harness. This module never opens a real network connection.
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { createHarness } = require('./harness.cjs');

const LOCAL_BASE = 'ws://127.0.0.1/play';
const nativeSetTimeout = global.setTimeout;
const nativeClearTimeout = global.clearTimeout;
const nativeSetImmediate = global.setImmediate;

async function install() {
  const harness = createHarness();
  const token = await harness.token('synthetic-legacy-smoke-user');
  if (typeof token !== 'string' || !token) {
    throw new Error('Offline harness did not produce a synthetic Firebase token');
  }

  process.env.WS_BASE = LOCAL_BASE;
  process.env.FIREBASE_ID_TOKEN = token;
  delete process.env.FIREBASE_API_KEY;

  const blockedNetwork = () => {
    throw new Error('P0 offline safety gate: external network access is forbidden');
  };
  global.fetch = blockedNetwork;
  for (const name of ['node:http', 'node:https']) {
    const network = require(name);
    network.request = blockedNetwork;
    network.get = blockedNetwork;
  }
  const net = require('node:net');
  net.connect = blockedNetwork;
  net.createConnection = blockedNetwork;
  require('node:tls').connect = blockedNetwork;
  require('node:dgram').createSocket = blockedNetwork;

  let pending = 0;
  let stopped = false;
  let pumping = false;
  let pumpScheduled = false;
  let timerId = 0;
  let lastProgress = performance.now();
  const timers = new Map();
  const sockets = new Set();

  function schedulePump() {
    if (stopped || pumpScheduled || pumping || timers.size === 0) return;
    pumpScheduled = true;
    nativeSetImmediate(pump);
  }

  async function tracked(operation) {
    pending++;
    try {
      return await operation();
    } finally {
      pending--;
      lastProgress = performance.now();
      schedulePump();
    }
  }

  async function pump() {
    pumpScheduled = false;
    if (stopped || pumping || timers.size === 0) return;
    if (pending !== 0) {
      // Crypto and the VM's internal durable-object requests must complete
      // before jumping the virtual clock to the next legacy test timeout.
      pumpScheduled = true;
      nativeSetTimeout(pump, 1);
      return;
    }
    pumping = true;
    try {
      const next = Math.min(...Array.from(timers.values(), timer => timer.due));
      await harness.advance(Math.max(0, next - harness.now()));
      await harness.settle();
      const due = Array.from(timers.entries())
        .filter(([, timer]) => timer.due <= harness.now())
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.callback(...timer.args);
      }
      lastProgress = performance.now();
    } catch (error) {
      stopped = true;
      nativeSetImmediate(() => { throw error; });
    } finally {
      pumping = false;
      schedulePump();
    }
  }

  // The original tests retain every timeout and assertion. Their sleeps and
  // timeout callbacks advance one shared server clock without real waiting.
  Date.now = () => harness.now();
  global.setTimeout = (callback, delay = 0, ...args) => {
    if (typeof callback !== 'function') throw new TypeError('Callback must be a function');
    const id = ++timerId;
    const duration = Number(delay);
    timers.set(id, {
      due: harness.now() + (Number.isFinite(duration) ? Math.max(0, duration) : 0),
      callback,
      args
    });
    schedulePump();
    return id;
  };
  global.clearTimeout = id => timers.delete(id);

  class OfflineWebSocket extends EventEmitter {
    constructor(address) {
      super();
      const url = new URL(String(address));
      if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' ||
          url.port || url.pathname !== '/play' || url.username || url.password ||
          url.hash || !/^\d+,\d+$/.test(url.searchParams.get('zone') || '') ||
          Array.from(url.searchParams.keys()).some(key => key !== 'zone')) {
        throw new Error('P0 offline safety gate: only the virtual loopback /play endpoint is allowed');
      }
      this.readyState = OfflineWebSocket.CONNECTING;
      this.url = url.href;
      this.connection = null;
      sockets.add(this);
      void tracked(async () => {
        this.connection = await harness.open(url.pathname + url.search);
        this.connection.client.addEventListener('message', event => {
          this.emit('message', Buffer.from(String(event.data)));
        });
        this.connection.client.addEventListener('close', event => {
          this.readyState = OfflineWebSocket.CLOSED;
          sockets.delete(this);
          this.emit('close', event.code || 1000, Buffer.from(String(event.reason || '')));
        });
        this.readyState = OfflineWebSocket.OPEN;
        await new Promise(resolve => nativeSetImmediate(() => {
          this.emit('open');
          resolve();
        }));
      }).catch(error => this.emit('error', error));
    }

    send(data) {
      if (this.readyState !== OfflineWebSocket.OPEN) throw new Error('WebSocket is not open');
      void tracked(async () => {
        await this.connection.send(String(data));
        await harness.settle();
      }).catch(error => this.emit('error', error));
    }

    close(code = 1000, reason = '') {
      if (this.readyState === OfflineWebSocket.CLOSED) return;
      this.readyState = OfflineWebSocket.CLOSING;
      void tracked(async () => {
        if (this.connection) await this.connection.close(code, reason);
        await harness.settle();
      }).catch(error => this.emit('error', error));
    }

    terminate() {
      this.close(1006, 'offline test terminated');
    }
  }
  Object.assign(OfflineWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  Object.assign(OfflineWebSocket.prototype, {
    CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3
  });
  OfflineWebSocket.WebSocket = OfflineWebSocket;

  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'ws') return OfflineWebSocket;
    return originalLoad.call(this, request, parent, isMain);
  };

  // A real-time watchdog makes a stuck local operation a visible failure;
  // it never converts an unfinished assertion into a passing test.
  let watchdog;
  function checkProgress() {
    if (stopped) return;
    if ((pending || timers.size) && performance.now() - lastProgress > 15000) {
      throw new Error('P0 offline legacy harness stalled for 15 real seconds');
    }
    watchdog = nativeSetTimeout(checkProgress, 1000);
    watchdog.unref();
  }
  checkProgress();

  process.once('beforeExit', async () => {
    stopped = true;
    nativeClearTimeout(watchdog);
    for (const socket of sockets) {
      if (socket.connection) await socket.connection.close(1000, 'offline harness shutdown');
    }
    await harness.close();
  });
  return { harness, OfflineWebSocket };
}

module.exports = { install, LOCAL_BASE };
