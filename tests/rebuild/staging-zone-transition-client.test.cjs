'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { stagingClientFixture, imported } = require('./staging-client-fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const pose = value => Object.fromEntries(['x', 'y', 'z', 'r'].map(key => [key, value[key]]));
const right = { x: 1, z: 0, jump: false };
async function flush() { for (let index = 0; index < 24; index++) await Promise.resolve(); }

// Execute the authored source/target socket handlers, ACK waiter, prediction and
// staging overrides. Socket time is synthetic; physics and the half-second
// server time budget are the real server movement implementation.
async function fixture() {
  const { SERVER_WORLD } = await imported('worker/world.mjs');
  const client = await stagingClientFixture({ obstacles:[...SERVER_WORLD.buildings,...SERVER_WORLD.trees] });
  const { applyMovementIntent, initializeMotion, publicMovement } = await imported('worker/movement.mjs');
  const sockets = [], packets = [], queue = [], scheduledFrames = [], timers = new Map();
  let timerId = 0;
  const c = client.context;
  c.SECURE_WORKER_WS_BASE = 'ws://zone-fixture.invalid/play';
  c.auth.currentUser = { uid: 'synthetic-staging-client', async getIdToken() { return 'synthetic-zone-id-token'; } };
  c.updateLeaderboardUI = () => {};
  c.requestAnimationFrame = callback => { scheduledFrames.push(callback); return scheduledFrames.length; };
  c.document.getElementById = () => ({ disabled: false, src: '', innerText: '', classList: { add() {}, remove() {} } });
  c.setTimeout = (callback, delay) => {
    const id = ++timerId; timers.set(id, { callback, due: client.read('Date.now()') + delay }); return id;
  };
  c.clearTimeout = id => timers.delete(id);
  const authoritative = { id: c.state.serverPlayerId, x: -.1, y: 0, z: -75, r: 0, at: client.read('Date.now()'), last: 0 };
  initializeMotion(authoritative, client.read('Date.now()'));
  authoritative.motion.vx = 22;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.index = sockets.length; sockets.push(this); }
    open() { if(this.readyState !== 0) return; this.readyState = 1; this.onopen?.(); }
    send(raw) {
      assert.equal(this.readyState, 1);
      const packet = JSON.parse(raw); packets.push({ socket: this, packet }); queue.push({ socket: this, packet });
    }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close(code = 1000) { if(this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
  }
  c.WebSocket = Socket;
  const opening = c.secureOpenZoneSocket('4,4');
  await flush(); const source = sockets[0]; source.open();
  source.receive({ type: 'welcome', zone: '4,4', id: authoritative.id, spawn: pose(authoritative),
    movement: publicMovement(authoritative), players: [], coins: [], leaderboard: [], score: 0 });
  await opening;
  c.secureRememberStablePosition();
  async function drain({ acknowledge = true } = {}) {
    for (const entry of queue.splice(0)) {
      if(entry.packet.type !== 'move') continue;
      assert.equal(entry.socket, source, 'warmup work reaches only the current source authority');
      assert.equal(applyMovementIntent(authoritative, entry.packet, 22, client.read('Date.now()')), true);
      if(acknowledge) source.receive({ type: 'move', player: { ...pose(authoritative), id: authoritative.id },
        ack: authoritative.motion.seq, movement: publicMovement(authoritative), applied: true });
    }
    await flush();
  }
  async function tick(count = 1, { acknowledge = true, force = false } = {}) {
    for(let index = 0; index < count; index++) {
      client.advance(1000 / 60); c.securePredictMovement(1 / 60); c.syncMyPlayerData(force); await drain({ acknowledge });
    }
  }
  async function begin() {
    const work = c.secureBeginZoneHandoff({ from: '4,4', zone: '5,4', handoffToken: 'synthetic-one-use-ticket',
      expiresAt: client.read('Date.now()') + 12000, continuousHandoff: true });
    await flush(); const target = sockets[1]; assert.ok(target); return { work, target };
  }
  async function welcome(target) {
    target.open(); target.receive({ type: 'welcome', handoff: true, continuousHandoff: true, zone: '5,4',
      id: authoritative.id, players: [], coins: [], leaderboard: [], score: 0 }); await flush();
  }
  function ack(target, overrides = {}) {
    target.receive({ type: 'handoff_resumed', continuousHandoff: true, zone: '5,4',
      position: pose(authoritative), movement: publicMovement(authoritative), ack: authoritative.motion.seq, ...overrides });
  }
  return { client, c, sockets, packets, queue, scheduledFrames, source, authoritative, tick, begin, welcome, ack, drain,
    vm: expression => vm.runInContext(expression, c),
    movePackets: socket => packets.filter(entry => entry.socket === socket && entry.packet.type === 'move').map(entry => entry.packet),
    async expire(ms) { client.advance(ms); for(const [id, timer] of [...timers]) if(timer.due <= client.read('Date.now()')) {
      timers.delete(id); timer.callback(); await flush();
    } }
  };
}

test('staging source prediction and validated MOVE ACKs continue through two seconds of target warmup', async t => {
  const f = await fixture(); f.c.keys.d = true;
  const { work, target } = await f.begin();
  assert.equal(f.packets.find(entry => entry.packet.type === 'auth').packet.continuousHandoff, true);
  const start = f.client.state();
  await f.tick(60); await f.welcome(target); await f.tick(60);
  f.c.syncMyPlayerData(true); await f.drain();
  const end = f.client.state();
  assert.ok(end.x > start.x + 40, 'two seconds of real client input are processed without a boundary pause');
  assert.ok(Math.hypot(end.x-f.authoritative.x, end.y-f.authoritative.y, end.z-f.authoritative.z) < 4,
    `prediction=${JSON.stringify(pose(end))}, authority=${JSON.stringify(pose(f.authoritative))}`);
  assert.equal(f.movePackets(target).length, 0, 'provisional target cannot receive normal movement');
  assert.ok(f.movePackets(f.source).length >= 9);
  assert.equal(f.source.readyState, 1);
  const before = f.client.state(); f.ack(target); await work;
  assert.ok(Math.hypot(f.client.state().x-before.x, f.client.state().y-before.y, f.client.state().z-before.z) < 1e-6);
  assert.equal(f.source.readyState, 3); assert.equal(f.c.secureGameSocket, target);
  assert.equal(f.c.secureHandoffInProgress, false);
  const groups = f.movePackets(f.source);
  assert.deepEqual(groups.map(packet => packet.seq), groups.map((_, index) => index));
  assert.ok(groups.every(packet => f.client.movement.validMovementFrames(packet.frames)));
  t.diagnostic('Simulated target authentication/welcome/resume latency: 2000 ms; source movement remained continuous.');
});

test('staging cutover retains and resends every unacknowledged original sequence including airborne input', async () => {
  const f = await fixture(); f.c.keys.d = true; await f.tick(12);
  const { work, target } = await f.begin(); await f.welcome(target);
  await f.tick(1, { force: true });
  const snapshot = plain(f.authoritative);
  const accepted = snapshot.motion.seq;
  // Seal is a rejected, not applied, source response. Inputs generated between
  // the source snapshot and target ACK remain unacknowledged prediction work.
  f.source.receive({ type: 'move', applied: false, sealed: true, ack: accepted,
    player: { ...pose(snapshot), id: snapshot.id }, movement: { ...snapshot.motion, lastSeq: accepted } });
  f.c.secureQueueJump(); await f.tick(10);
  const before = f.client.state();
  const pending = f.client.read('securePendingFrames').filter(frame => frame.seq > accepted);
  assert.ok(pending.length >= 10); assert.ok(pending.some(frame => frame.input.jump));
  assert.ok(before.y > 0, 'jump prediction continues through the cutover');
  f.ack(target, { position: pose(snapshot), movement: { vx:snapshot.motion.vx, vy:snapshot.motion.vy,
    vz:snapshot.motion.vz, grounded:snapshot.motion.grounded, jumpHeld:snapshot.motion.jumpHeld, lastSeq:accepted }, ack:accepted });
  await work;
  assert.deepEqual(pose(f.client.state()), pose(before), 'target ACK replays retained input instead of resetting position');
  const replay = f.movePackets(target).filter(packet => packet.frames.some(frame => frame.delta > 0));
  assert.deepEqual(replay.flatMap(packet => packet.frames), pending.map(frame => ({ input:frame.input, delta:frame.delta })));
  assert.equal(replay[0].seq, pending[0].seq);
  assert.equal(f.client.read('secureJumpGeneration'), 2, 'ownership transfer does not erase the queued jump generation');
  assert.equal(f.client.read('secureJumpHeld'), true);
});

test('staging handoff isolates stale source ACKs, foreign sockets and provisional target movement', async () => {
  const f = await fixture(); f.c.keys.d = true; await f.tick(12);
  const { work, target } = await f.begin(); await f.welcome(target); await f.tick(12);
  const before = f.client.state();
  const bad = { type:'move', player:{ id:f.authoritative.id, x:700, y:0, z:700, r:0 },
    ack: f.authoritative.motion.seq+20, movement:{ vx:0,vy:0,vz:0,grounded:true,jumpHeld:false }, applied:true };
  target.receive(bad); f.source.receive(bad);
  const foreign = { readyState:1, secureAuthenticatedUid:'another-account' };
  assert.equal(f.c.secureDispatchContinuousHandoffSocket(foreign,bad),false);
  assert.deepEqual(f.client.state(),before);
  f.ack(target); await work;
  f.source.receive({ ...bad, ack:f.client.read('secureInputSequence')-1 });
  assert.deepEqual(f.client.state(),before,'completed source cannot write successor authority');
});

test('staging continuous cancellation keeps latest authority and retained input without a rollback teleport', async () => {
  const f = await fixture(); f.c.keys.d = true; await f.tick(12);
  const { work,target }=await f.begin(); await f.welcome(target); await f.tick(30);
  const before=f.client.state(),snapshot=plain(f.authoritative);
  target.receive({ type:'handoff_resume_error',continuousHandoff:true,retryable:false,cancelledToSource:true });
  await flush(); assert.equal(f.c.secureGameSocket,f.source);
  assert.ok(f.packets.some(entry=>entry.socket===f.source && entry.packet.type==='handoff_cancel'));
  f.source.receive({ type:'handoff_cancelled',continuousHandoff:true,zone:'4,4',position:pose(snapshot),
    movement:{ vx:snapshot.motion.vx,vy:snapshot.motion.vy,vz:snapshot.motion.vz,grounded:snapshot.motion.grounded,
      jumpHeld:snapshot.motion.jumpHeld,lastSeq:snapshot.motion.seq },ack:snapshot.motion.seq,nextSequence:snapshot.motion.seq+1 });
  await work;
  assert.deepEqual(pose(f.client.state()),pose(before));
  assert.equal(f.c.secureHandoffInProgress,false); assert.equal(target.readyState,3); assert.equal(f.source.readyState,1);
  const after=f.client.state(); target.receive({type:'handoff_resumed',continuousHandoff:true,zone:'5,4',position:{x:700,y:0,z:700,r:0}});
  assert.deepEqual(f.client.state(),after,'late cancelled target ACK cannot restore ownership');
});

test('staging coin pickup during target warmup flushes movement on the owning source socket', async () => {
  const f=await fixture(); f.c.keys.d=true; await f.tick(12);
  const {work,target}=await f.begin(); await f.welcome(target); await f.tick(3);
  const coin={active:true,serverId:0,mesh:{visible:true}}; f.c.coins=[coin];
  f.c.collectCoin(coin);
  const last=f.packets.slice(-2);
  assert.equal(last[0].socket,f.source); assert.equal(last[0].packet.type,'move');
  assert.equal(last[1].socket,f.source); assert.equal(last[1].packet.type,'collect');
  assert.equal(f.packets.some(entry=>entry.socket===target && entry.packet.type==='collect'),false);
  await f.drain(); f.ack(target); await work;
});

test('staging account cancellation fences late welcome/ACK continuations and never restores old source', async () => {
  const f=await fixture(); const {work,target}=await f.begin();
  f.c.secureAbortClientConnections('synthetic account change'); f.c.auth.currentUser={uid:'different-staging-user'};
  target.open(); target.receive({type:'welcome',handoff:true,zone:'5,4',id:f.authoritative.id,players:[],coins:[],leaderboard:[]});
  await f.expire(10001); await work;
  assert.equal(f.c.secureGameSocket,null); assert.equal(f.c.secureGameReady,false);
  assert.equal(f.source.readyState,3); assert.equal(target.readyState,3);
  assert.equal(f.movePackets(target).length,0);
});

test('staging rejects downgraded or malformed ownership ACK instead of discarding pending inputs', async () => {
  for(const overrides of [{continuousHandoff:false},{ack:999},{movement:{vx:0,vy:0,vz:0,lastSeq:-1}},
    {position:{x:900,y:0,z:0,r:0}},{movement:{vx:99,vy:0,vz:0,grounded:true,jumpHeld:false,lastSeq:-1}}]) {
    const f=await fixture(); const {work,target}=await f.begin(); await f.welcome(target);
    f.ack(target,overrides); await work;
    assert.equal(f.c.state.isPlaying,false); assert.equal(f.c.secureGameReady,false); assert.equal(f.c.secureGameSocket,null);
    assert.equal(f.source.readyState,3); assert.equal(target.readyState,3);
  }
});

test('staging unexpected source loss fails closed while source close before an in-flight target ACK is ordered safely', async () => {
  const initial=await fixture(); const first=await initial.begin(); initial.source.close(1006);
  await initial.expire(10001); await first.work;
  assert.equal(initial.c.secureGameSocket,null); assert.equal(initial.c.state.isPlaying,false);
  const f=await fixture(); f.c.keys.d=true; await f.tick(12);
  const {work,target}=await f.begin(); await f.welcome(target);
  f.source.close(1000); assert.equal(f.c.secureGameReady,true,'cross-socket close delivery cannot discard a pending valid target ACK');
  await f.tick(3); const before=f.client.state(); f.ack(target); await work;
  assert.deepEqual(pose(f.client.state()),pose(before)); assert.equal(f.c.secureGameSocket,target);
  assert.equal(f.c.state.isPlaying,true); assert.equal(f.c.secureHandoffInProgress,false);
});


test('staging provisional world snapshots cannot overwrite source economy and commit snapshots apply after ACK', async () => {
  const f=await fixture(); f.c.state.score=3;
  const {work,target}=await f.begin(); await f.welcome(target);
  assert.equal(f.c.state.score,3,'provisional WELCOME cannot reset the owning source score');
  assert.equal(f.scheduledFrames.length,0,'provisional WELCOME schedules no stale world writer after the ownership ACK');
  target.receive({type:'score',score:7});
  assert.equal(f.c.state.score,3,'unconfirmed target cannot change economy state');
  f.source.receive({type:'score',score:5});
  assert.equal(f.c.state.score,5,'captured source remains the only live authority while target warms');
  f.ack(target); await work;
  assert.equal(f.c.state.score,7,'captured commit world state applies after a valid ownership ACK');
  f.source.receive({type:'score',score:100});
  assert.equal(f.c.state.score,7,'old source cannot mutate successor economy');
});


test('staging source auth renewal stays bound to the captured source zone during target warmup', async () => {
  const f=await fixture(); const {work,target}=await f.begin(); await f.welcome(target);
  const now=f.client.read('Date.now()');
  f.source.receive({type:'auth_refreshed',session:{resumeToken:'synthetic-source-renewal',
    sessionId:'synthetic-source-session',resumeExpiresAt:now+300000,tokenExpiresAt:now+3600000},serverNow:now});
  assert.equal(f.client.read('secureGetResumeTicket("4,4").sessionId'),'synthetic-source-session');
  assert.equal(f.client.read('secureGetResumeTicket("5,4")'),null,'source renewal cannot become a provisional target capability');
  f.ack(target); await work;
});
