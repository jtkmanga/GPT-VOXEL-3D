'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const sourcePath = name => path.resolve(__dirname, '../../src', name);
const imported = name => import(pathToFileURL(sourcePath(name)).href);
const clone = value => JSON.parse(JSON.stringify(value));

// Execute the authored staging overrides together with the real prediction,
// packet and reconciliation fragments. All identities and tokens are synthetic.
async function stagingClientFixture(options = {}) {
  const movement = await imported('shared/movement.mjs');
  const protocol = await imported('shared/protocol.mjs');
  const config = await imported('shared/config.mjs');
  let currentTime = options.now ?? 1_900_000_000_000;
  const sent = [], pendingTransport = [], elements = new Map();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  }
  const playerPos = { x: 0, y: 0, z: 0,
    set(x, y, z) { Object.assign(this, { x, y, z }); },
    copy(other) { this.set(other.x, other.y, other.z); } };
  class LocalWebSocket {}
  LocalWebSocket.OPEN = 1;
  const socket = { readyState: 1, send(raw) {
    const message = JSON.parse(raw);
    sent.push(message);
    if (options.send) pendingTransport.push(options.send(message));
  } };
  const context = vm.createContext({
    movement, protocol, config, Date: ClockDate, WebSocket: LocalWebSocket,
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame() {},
    document: { hidden: false, addEventListener() {}, getElementById(id) {
      if (!elements.has(id)) elements.set(id, { disabled: false, src: '', innerText: '' });
      return elements.get(id);
    } }, window: { addEventListener() {} }, startGame() {}, alert() {},
    STAGING_CLIENT_ENABLED: true, STAGING_PUBLIC_CONFIG: { authMode: 'popup' },
    console, playerPos, playerVel: { x: 0, z: 0 }, playerVelocityY: 0,
    playerRotation: 0, isGrounded: true, playerGroup: null,
    keys: {}, joystickVec: { x: 0, y: 0 }, cameraYaw: 0,
    buildings: options.obstacles ?? [], trees: [],
    state: { isPlaying: true, isPaused: false, serverPlayerId: options.playerId ?? 'synthetic-staging-player',
      score: 0, shop: { speedBuffExpires: 0 }, selectedServerId: options.serverId ?? 'free1', playerName: 'Synthetic staging' },
    auth: { currentUser: { uid: 'synthetic-staging-client' }, signOut: async () => {} },
    secureGameSocket: socket, secureGameReady: true, secureHandoffInProgress: false,
    secureCurrentZoneId: '5,5', secureLastStablePosition: null, secureLastMoveSentAt: 0,
    secureHandoffResumeTimer: null, secureHandoffResumeResolve: null, secureHandoffResumeReject: null,
    secureNow: () => currentTime, secureSetServerNow() {},
    SECURE_ZONE_GRID_SIZE: 10, SECURE_ZONE_SIZE: 150, MAP_SIZE: 1500,
    secureIntentionalSockets: new WeakSet(), secureRemoteSources: new Map(), secureGhostMembersByZone: new Map(),
    otherPlayers: {}, coins: [], luckyBox: null,
    addOtherPlayer() {}, updateOtherPlayer() {}, removeOtherPlayer() {}, removeAllOtherPlayers() {},
    updateScoreDisplay() {}, audio: { playJump() {}, playCoin() {} }
  });
  for (const fragment of ['secure-snapshots.js', 'secure-socket-handoff.js', 'secure-menu-economy.js', 'staging-runtime.js']) {
    vm.runInContext(fs.readFileSync(sourcePath(`client/${fragment}`), 'utf8'), context, { filename: fragment });
  }
  return { context, movement, sent,
    read: expression => clone(vm.runInContext(expression, context)),
    setTime(value) { currentTime = value; }, advance(ms) { currentTime += ms; },
    async flush() { await Promise.all(pendingTransport.splice(0)); },
    state: () => clone(context.secureMovementState()),
    reset(position = { x: 0, y: 0, z: 0, r: 0 }, motion = {}) {
      return context.secureResetPrediction(position, motion);
    }
  };
}

module.exports = { stagingClientFixture, imported };
