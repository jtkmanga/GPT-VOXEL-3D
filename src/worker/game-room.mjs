import { PLAYER_VISIBILITY_RADIUS, RESPAWN_MS, LUCKY_BOX_CLAIM_MS, LUCKY_BOX_RESPAWN_MS, ROOM_SOFT_CAP, MOVE_TICK_MS, VIP_ENTITLEMENT_CAP } from '../shared/config.mjs';
import { MOVEMENT } from '../shared/movement.mjs';
import { PAYMENT_CONFIG } from '../shared/catalog.mjs';
import { WS_MESSAGE, PROTOCOL_VERSION } from '../shared/protocol.mjs';
import { normalizePlayerName, normalizeZoneId, adjacentZoneIds, zonesAreAdjacent, zoneFromPosition, zoneIdsNearPosition } from './spatial.mjs';
import { COINS, coinPosition, luckyBoxPosition, secureLuckyReward } from './world.mjs';
import { verifyFirebaseIdToken } from './firebase-auth.mjs';
import { SessionStore, SESSION_TTL_MS } from './sessions.mjs';
import { SECURITY, clearAuthDeadline, scheduleAuthDeadline } from './security.mjs';
import { enqueueFrame, sessionMetadata, checkpointPlayer } from './room-security.mjs';
import { initializeMotion, applyMovementIntent, publicMovement } from './movement.mjs';
import { EconomyStore } from './economy.mjs';
import { VipStore } from './vip-store.mjs';
import { validVipUid, VIP_PRODUCT, normalizePaymentEvent, paymentEventFingerprint } from './payment-events.mjs';
import { handoffPosition } from './handoff-continuity.mjs';
import { handle2c2pInternal } from './twoc2p-sandbox.mjs';

export class GameRoom {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.projectId=env.FIREBASE_PROJECT_ID;
    this.sql=ctx.storage.sql;
    this.sessions=new SessionStore(ctx);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_session_revocations (
      uid TEXT NOT NULL, session_id TEXT NOT NULL, owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
      PRIMARY KEY(uid,session_id,owner)
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS voxel_sessions_routing_idx ON voxel_sessions(owner,lease_expires,exp)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS voxel_scores (uid TEXT PRIMARY KEY, nickname TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS voxel_coins (id INTEGER PRIMARY KEY, respawn_at INTEGER NOT NULL)');
    try { this.sql.exec('ALTER TABLE voxel_coins ADD COLUMN cycle INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_lucky_box (
      id INTEGER PRIMARY KEY,
      next_spawn_at INTEGER NOT NULL DEFAULT 0,
      cycle INTEGER NOT NULL DEFAULT 0,
      claimed_uid TEXT,
      claim_expires_at INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`INSERT OR IGNORE INTO voxel_lucky_box
      (id, next_spawn_at, cycle, claimed_uid, claim_expires_at)
      VALUES (1, 0, 0, NULL, 0)`);
    this.economy=new EconomyStore(ctx,now=>this.economyPlayers(now));

    // Server-authoritative paid entitlements
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_entitlements (
      uid TEXT PRIMARY KEY,
      speed_expires INTEGER NOT NULL DEFAULT 0,
      coin_expires INTEGER NOT NULL DEFAULT 0,
      vip1_expires INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);
    this.vip=new VipStore(ctx);
    this.serverScope='free1';

    // One payment transaction can only be granted once
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_payments (
      transaction_id TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      item TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_zone_handoffs (
      token TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      player_id TEXT NOT NULL,
      from_zone TEXT NOT NULL,
      to_zone TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      r REAL NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      session_id TEXT
    )`);
    try { this.sql.exec('ALTER TABLE voxel_zone_handoffs ADD COLUMN session_id TEXT'); } catch (_) {}
    this.sql.exec('CREATE INDEX IF NOT EXISTS voxel_zone_handoffs_exp_idx ON voxel_zone_handoffs(expires_at)');
    // Consumption preserves a durable fence until ownership commits. A
    // source cancellation can invalidate a target that already has its ticket.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_handoff_grants (
      token TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      session_id TEXT NOT NULL,
      from_owner TEXT NOT NULL,
      to_owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL
    )`);

    this.ready=ctx.blockConcurrencyWhile(async()=>{
      const scope=await ctx.storage.get('serverScope');
      if (scope!==undefined && scope!=='vip1') throw Error('Invalid durable server scope');
      this.serverScope=scope||'free1';
      // Preserve the existing v3 coin cooldowns when the room upgrades.
      const old=await ctx.storage.get('coinRespawns');
      if (old && typeof old==='object') {
        ctx.storage.transactionSync(()=>{
          for(const [id,value] of Object.entries(old)) if (Number.isInteger(Number(id)) &&
              Number(id)>=0 && Number(id)<COINS.length && Number.isFinite(Number(value)))
            this.sql.exec('INSERT INTO voxel_coins(id,respawn_at) VALUES (?,?) ON CONFLICT(id) DO NOTHING',Number(id),Number(value));
        });
        await ctx.storage.delete('coinRespawns');
      }
      await this.scheduleEconomyAlarm();
    });
    for (const ws of this.sockets()) scheduleAuthDeadline(this,ws);
  }
  player(ws) { return ws.deserializeAttachment(); }
  sockets() { return this.ctx.getWebSockets(); }
  activePlayer(p) {
    if (!p?.uid || p.revoked || p.sessionClosed || Number(p.exp)<=Math.floor(Date.now()/1000) ||
        !this.sessions.validate({uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()})) return false;
    return this.serverScope!=='vip1' || Number(this.entitlementSnapshot(p.uid).vip1Expires)>Date.now();
  }
  count() { return this.sockets().filter(ws=>this.activePlayer(this.player(ws))).length; }
  sessionOwner() { return 'room'; }
  async vipCall(action,payload) {
    const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
      new Request(`https://internal/_internal/vip/${action}`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)
      }));
    const result=await response.json();
    if (response.status>=500 || !result || typeof result!=='object')
      throw Error('VIP authority unavailable');
    return result;
  }
  mirrorVipEntitlements(uid,entitlements) {
    if (!entitlements || !['speedExpires','coinExpires','vip1Expires'].every(key=>
      Number.isSafeInteger(entitlements[key]) && entitlements[key]>=0))
      throw Error('VIP entitlement snapshot unavailable');
    this.sql.exec(`INSERT INTO voxel_entitlements(uid,speed_expires,coin_expires,vip1_expires,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET speed_expires=excluded.speed_expires,
      coin_expires=excluded.coin_expires,vip1_expires=excluded.vip1_expires,updated_at=excluded.updated_at`,
    uid,entitlements.speedExpires,entitlements.coinExpires,entitlements.vip1Expires,Date.now());
  }
  async vipSessionCall(action,payload) {
    if (action==='transfer') return {ok:false,error:'VIP room has no zone handoff'};
    if (action==='acquire') {
      const result=this.sessions.acquire(payload);
      if (!result.ok) return result;
      const identity={uid:payload.uid,sessionId:result.sessionId,owner:this.sessionOwner()};
      try {
        const status=await this.vipCall('status',{uid:payload.uid});
        if (!status.ok || !this.sessions.validate(identity)) throw Error('VIP session no longer owned');
        const admitted=await this.vipCall('admit',{uid:payload.uid,sessionId:result.sessionId,
          exp:payload.exp,previousSessionId:status.seatSessionId||null});
        if (!admitted.ok || !this.sessions.validate(identity)) {
          this.sessions.release(identity);
          try { await this.vipCall('release',identity); } catch (_) {}
          return {ok:false,error:admitted.error||'VIP session no longer owned'};
        }
        this.mirrorVipEntitlements(payload.uid,admitted.entitlements);
        this.sql.exec('UPDATE voxel_sessions SET lease_expires=MIN(lease_expires,?) WHERE uid=? AND session_id=?',
          admitted.leaseExpiresAt,payload.uid,result.sessionId);
        if (result.previousOwner && result.previousSessionId)
          this.revokeSession({uid:payload.uid,sessionId:result.previousSessionId});
        return {...result,resumeExpiresAt:Math.min(result.resumeExpiresAt,admitted.leaseExpiresAt)};
      } catch (error) {
        this.sessions.release(identity);
        try { await this.vipCall('release',identity); } catch (_) {}
        throw error;
      }
    }
    if (action==='release') {
      const local=this.sessions.release(payload);
      if (!local.ok) return local;
      await this.vipCall('release',payload);
      return local;
    }
    if (!this.sessions.validate(payload)) return action==='validate' ? false : {ok:false,error:'Session no longer owned'};
    const seat=await this.vipCall(action==='checkpoint' ? 'renew' : 'validate',payload);
    if (!seat.ok || !this.sessions.validate(payload)) return action==='validate' ? false : {ok:false,error:'VIP seat no longer owned'};
    this.mirrorVipEntitlements(payload.uid,seat.entitlements);
    if (action==='validate') return true;
    const checkpoint=this.sessions.checkpoint(payload);
    if (checkpoint.ok) this.sql.exec('UPDATE voxel_sessions SET lease_expires=MIN(lease_expires,?) WHERE uid=? AND session_id=?',
      seat.leaseExpiresAt,payload.uid,payload.sessionId);
    return checkpoint.ok ? {...checkpoint,resumeExpiresAt:Math.min(checkpoint.resumeExpiresAt,seat.leaseExpiresAt)} : checkpoint;
  }
  async sessionCall(action,payload) {
    if (action==='revoke') return this.retireOwner(payload);
    if (!['acquire','validate','checkpoint','release','transfer'].includes(action))
      throw Error('Invalid session action');
    if (this.serverScope==='vip1') return this.vipSessionCall(action,payload);
    const result=action==='transfer' ? this.transferHandoff(payload) : action==='acquire' ? this.ctx.storage.transactionSync(()=>{
      const acquired=this.sessions.acquire(payload);
      if (acquired.ok && acquired.previousOwner && acquired.previousSessionId)
        this.sql.exec(`INSERT OR IGNORE INTO voxel_session_revocations
          (uid,session_id,owner,expires_at,next_attempt_at) VALUES (?,?,?,?,?)`,
        payload.uid,acquired.previousSessionId,acquired.previousOwner,
        Date.now()+SESSION_TTL_MS,Date.now()+1000);
      return acquired;
    }) : this.sessions[action](payload);
    if (action==='acquire' && result.ok && result.previousOwner && result.previousSessionId) {
      // Keep the exact retired generation durable before the RPC. Failed
      // delivery/restart cannot lose eviction or target a successor generation.
      await this.retireOwner({uid:payload.uid,owner:result.previousOwner,sessionId:result.previousSessionId});
    }
    return result;
  }
  transferHandoff(payload) {
    return this.ctx.storage.transactionSync(()=>{
      const grant=this.sql.exec('SELECT * FROM voxel_handoff_grants WHERE token=?',payload?.handoffToken||'').toArray()[0];
      if (!grant || grant.status!=='pending' || Number(grant.expires_at)<=Date.now() ||
          grant.uid!==payload.uid || grant.session_id!==payload.sessionId ||
          grant.from_owner!==payload.fromOwner || grant.to_owner!==payload.toOwner)
        return {ok:false,error:'Handoff grant unavailable'};
      const transfer=this.sessions.transfer(payload);
      if (transfer.ok) this.sql.exec("UPDATE voxel_handoff_grants SET status='complete' WHERE token=? AND status='pending'",grant.token);
      return transfer;
    });
  }
  completeStagingHandoff(payload) {
    if (this.env.APP_ENV!=='staging' || this.serverScope!=='free1' ||
        !String(payload?.handoffToken||'').startsWith('continuous:') ||
        !Number.isSafeInteger(payload?.exp) || payload.exp<=Math.floor(Date.now()/1000))
      return {ok:false,error:'Staging handoff unavailable'};
    const position=handoffPosition(payload.position);
    const fromZone=typeof payload.fromOwner==='string' && normalizeZoneId(payload.fromOwner.slice(5));
    const toZone=typeof payload.toOwner==='string' && normalizeZoneId(payload.toOwner.slice(5));
    if (!fromZone || payload.fromOwner!==`zone:${fromZone}` || !toZone ||
        payload.toOwner!==`zone:${toZone}` || !zonesAreAdjacent(fromZone,toZone) ||
        zoneFromPosition(position.x,position.z)!==toZone)
      return {ok:false,error:'Invalid staging handoff route'};
    return this.ctx.storage.transactionSync(()=>{
      const transfer=this.transferHandoff({...payload,position});
      if (!transfer.ok) return transfer;
      const checkpoint=this.sessions.checkpoint({uid:payload.uid,sessionId:payload.sessionId,
        owner:payload.toOwner,position,exp:payload.exp,revision:Number(transfer.checkpointRevision)+1});
      if (!checkpoint.ok) throw Error('Staging handoff checkpoint unavailable');
      // Queue exact-generation eviction durably before returning the ACK data.
      // Source sealing already fences gameplay while delivery retries run.
      const now=Date.now();
      this.sql.exec(`INSERT OR IGNORE INTO voxel_session_revocations
        (uid,session_id,owner,expires_at,next_attempt_at) VALUES (?,?,?,?,?)`,
      payload.uid,payload.sessionId,`sealed:${fromZone}|${payload.handoffToken}`,now+SESSION_TTL_MS,now+1000);
      return {...transfer,resumeExpiresAt:checkpoint.resumeExpiresAt,
        checkpointRevision:checkpoint.checkpointRevision,worldState:{ok:true,
          coins:this.coinSnapshot(),luckyBox:this.boxSnapshot(),score:this.economy.score(payload.uid),
          leaderboard:this.top(),serverNow:now}};
    });
  }
  async retireOwner(payload) {
    const {uid,sessionId,owner,handoffToken}=payload||{};
    const zone=typeof owner==='string' && owner.startsWith('zone:') && normalizeZoneId(owner.slice(5));
    if (typeof uid!=='string' || !uid || uid.length>128 || typeof sessionId!=='string' ||
        !sessionId || sessionId.length>256 || (owner!=='room' && (!zone || owner!==`zone:${zone}`)))
      return {ok:false,error:'Invalid session revocation'};
    if (handoffToken!==undefined && (this.env.APP_ENV!=='staging' || !zone ||
        typeof handoffToken!=='string' || !handoffToken.startsWith('continuous:') || handoffToken.length>128))
      return {ok:false,error:'Invalid staging session revocation'};
    const revocationOwner=handoffToken ? `sealed:${zone}|${handoffToken}` : owner;
    this.sql.exec(`INSERT OR IGNORE INTO voxel_session_revocations
      (uid,session_id,owner,expires_at,next_attempt_at) VALUES (?,?,?,?,?)`,
    uid,sessionId,revocationOwner,Date.now()+SESSION_TTL_MS,Date.now()+1000);
    await this.scheduleEconomyAlarm();
    const result=await this.revokeOwner({uid,sessionId,owner:revocationOwner});
    if (!result?.ok) throw Error('Session revocation unavailable');
    this.sql.exec('DELETE FROM voxel_session_revocations WHERE uid=? AND session_id=? AND owner=?',uid,sessionId,revocationOwner);
    await this.scheduleEconomyAlarm();
    return result;
  }
  revokeSession({uid,sessionId}) {
    let count=0;
    for (const ws of this.sockets()) {
      const p=this.player(ws);
      if (!p?.uid || p.uid!==uid || p.sessionId!==sessionId) continue;
      p.revoked=true;
      ws.serializeAttachment(p);
      clearAuthDeadline(ws);
      try { ws.close(1008,'Session replaced'); } catch (_) {}
      count++;
    }
    return {ok:true,count};
  }
  async revokeOwner({uid,sessionId,owner}) {
    if (typeof uid!=='string' || !uid || uid.length>128 ||
        typeof sessionId!=='string' || !sessionId || sessionId.length>256)
      return {ok:false,error:'Invalid session revocation'};
    if (owner==='room') return this.revokeSession({uid,sessionId});
    const sealed=this.env.APP_ENV==='staging' && typeof owner==='string' && /^sealed:([0-9],[0-9])\|(continuous:[a-f0-9-]{36})$/.exec(owner);
    const zoneId=sealed ? normalizeZoneId(sealed[1]) :
      typeof owner==='string' && owner.startsWith('zone:') && normalizeZoneId(owner.slice(5));
    if (!zoneId || (!sealed && owner!==`zone:${zoneId}`)) return {ok:false,error:'Invalid session owner'};
    const response=await this.env.ZONE.getByName(`free-zone-${zoneId}`).fetch(
      new Request('https://zone.internal/_internal/session-revoke',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uid,sessionId,...(sealed ? {handoffToken:sealed[2]} : {})})
      })
    );
    const result=await response.json();
    if (!response.ok || !result?.ok) throw Error('Session revocation unavailable');
    return result;
  }
  entitlementSnapshot(uid) {
    const row=this.sql.exec(
      'SELECT speed_expires,coin_expires,vip1_expires FROM voxel_entitlements WHERE uid=?',uid
    ).toArray()[0] || {};
    return {speedExpires:Number(row.speed_expires)||0,coinExpires:Number(row.coin_expires)||0,
      vip1Expires:this.serverScope==='vip1' ? Number(row.vip1_expires)||0 : this.vip.entitlement(uid).expiresAt};
  }
  ownsSession(ws,p) {
    const current=this.player(ws);
    const owned=current?.uid===p?.uid && current?.sessionId===p?.sessionId &&
      !current?.revoked && !current?.sessionClosed &&
      (typeof ws.readyState!=='number' || ws.readyState===1) &&
      this.sessions.validate({uid:p?.uid,sessionId:p?.sessionId,owner:this.sessionOwner()}) &&
      (this.serverScope!=='vip1' || this.activePlayer(p));
    if (!owned) ws.close(1008,'Session no longer owned');
    return owned;
  }
  ownsZoneSession(body,uid) {
    const owner=body?.owner;
    const zoneId=typeof owner==='string' && owner.startsWith('zone:') && normalizeZoneId(owner.slice(5));
    return Boolean(zoneId && owner===`zone:${zoneId}` &&
      this.sessions.validate({uid,sessionId:body?.sessionId,owner}));
  }
  send(ws,value) { try { ws.send(JSON.stringify(value)); } catch (_) {} }
  broadcast(value,except) {
    const data=JSON.stringify(value);
    for(const ws of this.sockets()) if(ws!==except && this.activePlayer(this.player(ws))) {
      try { ws.send(data); } catch (_) {}
    }
  }
  nearbySockets(sourcePlayer, except) {
    if (!sourcePlayer?.uid) return [];
    const out=[];
    const maxD2=PLAYER_VISIBILITY_RADIUS*PLAYER_VISIBILITY_RADIUS;
    for (const ws of this.sockets()) {
      if (ws===except) continue;
      const other=this.player(ws);
      if (!this.activePlayer(other)) continue;
      const dx=(Number(other.x)||0)-(Number(sourcePlayer.x)||0);
      const dz=(Number(other.z)||0)-(Number(sourcePlayer.z)||0);
      if (dx*dx+dz*dz<=maxD2) out.push(ws);
    }
    return out;
  }
  broadcastNearby(value,sourcePlayer,except) {
    const data=JSON.stringify(value);
    for (const ws of this.nearbySockets(sourcePlayer,except)) {
      try { ws.send(data); } catch (_) {}
    }
  }
  publicPlayer(p) { return p?.uid && {id:p.id,x:p.x,y:p.y,z:p.z,r:p.r,name:normalizePlayerName(p.nickname,'Player')}; }
  coinSnapshot() { return this.economy.coinSnapshot(); }
  economyPlayers(now=Date.now()) {
    const persisted=this.serverScope==='vip1'
      ? this.sql.exec(`SELECT s.x,s.z FROM voxel_sessions s JOIN voxel_entitlements e ON e.uid=s.uid
          WHERE s.lease_expires>? AND s.exp>? AND e.vip1_expires>?`,now,Math.floor(now/1000),now).toArray()
      : this.sql.exec('SELECT x,z FROM voxel_sessions WHERE lease_expires>? AND (exp=0 OR exp>?)',now,Math.floor(now/1000)).toArray();
    const local=this.sockets().map(ws=>this.player(ws)).filter(p=>this.serverScope==='vip1'
      ? this.activePlayer(p) : p?.uid && !p.revoked && !p.sessionClosed && p.exp>Math.floor(now/1000));
    return [...persisted,...local].filter(p=>Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.z)))
      .map(p=>({x:Number(p.x),z:Number(p.z)}));
  }
  async scheduleEconomyAlarm() {
    const row=this.sql.exec('SELECT next_spawn_at,claimed_uid,claim_expires_at FROM voxel_lucky_box WHERE id=1').toArray()[0];
    const future=[Number(row?.next_spawn_at)||0,
      row?.claimed_uid ? Number(row.claim_expires_at)||0 : 0].filter(value=>value>Date.now());
    const pending=this.sql.exec('SELECT next_attempt_at FROM voxel_session_revocations').toArray();
    for (const retry of pending) future.push(Math.max(Date.now()+1000,Number(retry.next_attempt_at)||0));
    const due=future.length ? Math.min(...future) : 0;
    const current=await this.ctx.storage.getAlarm();
    if (due>Date.now()) {
      if (Number(current)!==due) await this.ctx.storage.setAlarm(due);
    } else if (current!==null) await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    await this.ready;
    const now=Date.now();
    for (const retired of this.sql.exec('SELECT * FROM voxel_session_revocations WHERE next_attempt_at<=? LIMIT 64',now).toArray()) {
      let delivered=Number(retired.expires_at)<=now;
      if (!delivered) {
        try { delivered=(await this.revokeOwner({uid:retired.uid,sessionId:retired.session_id,owner:retired.owner}))?.ok===true; }
        catch (_) { /* The current durable generation still rejects mutations. */ }
      }
      if (delivered) this.sql.exec('DELETE FROM voxel_session_revocations WHERE uid=? AND session_id=? AND owner=?',
        retired.uid,retired.session_id,retired.owner);
      else this.sql.exec('UPDATE voxel_session_revocations SET next_attempt_at=? WHERE uid=? AND session_id=? AND owner=?',
        now+1000,retired.uid,retired.session_id,retired.owner);
    }
    const before=this.sql.exec('SELECT * FROM voxel_lucky_box WHERE id=1').toArray()[0];
    if ((before?.claimed_uid && Number(before.claim_expires_at)<=now) ||
        (Number(before?.next_spawn_at)>0 && Number(before.next_spawn_at)<=now && Number(before.spawn_cycle)!==Number(before.cycle))) {
      const box=this.boxSnapshot(now);
      this.broadcast({type:WS_MESSAGE.BOX_STATE,box,serverNow:now});
      await this.sendAllZones({type:WS_MESSAGE.BOX_STATE,box,serverNow:now});
    }
    await this.scheduleEconomyAlarm();
  }
  economyPosition(body,uid) {
    if (!this.ownsZoneSession(body,uid)) return null;
    const row=this.sessions.row(uid);
    return {x:Number(row.x),y:Number(row.y),z:Number(row.z),r:Number(row.r)};
  }
  publishCoin(result) {
    const event=result.event;
    this.broadcast(event);
    const old=result.oldPosition||event;
    this.ctx.waitUntil(this.sendZoneEvent([
      ...zoneIdsNearPosition(old.x,old.z),...zoneIdsNearPosition(event.x,event.z)
    ],event));
    const leaderboard=this.top();
    this.broadcast({type:WS_MESSAGE.LEADERBOARD,top:leaderboard});
    this.ctx.waitUntil(this.sendAllZones({type:WS_MESSAGE.LEADERBOARD,top:leaderboard}));
    return leaderboard;
  }
  publishBox(box,now=Date.now()) {
    const event={type:WS_MESSAGE.BOX_STATE,box,serverNow:now};
    this.broadcast(event);
    this.ctx.waitUntil(this.sendAllZones(event));
  }
  top() {
    return this.sql.exec('SELECT nickname, score FROM voxel_scores ORDER BY score DESC, updated_at ASC LIMIT 10').toArray();
  }

  async sendZoneEvent(zoneIds,event) {
    if (this.serverScope==='vip1') return;
    const ids=this.activeZoneIds(zoneIds);
    if (!ids.length) return;
    const body=JSON.stringify(event);
    await Promise.allSettled(ids.map(zoneId=>
      this.env.ZONE.getByName(`free-zone-${zoneId}`).fetch(
        new Request('https://zone.internal/_internal/world-event',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body
        })
      )
    ));
  }

  async sendAllZones(event) {
    return this.sendZoneEvent(null,event);
  }

  activeZoneIds(candidates=null) {
    const now=Date.now();
    const allowed=candidates===null ? null : new Set(candidates.map(normalizeZoneId).filter(Boolean));
    if (allowed && !allowed.size) return [];
    const owners=allowed ? [...allowed].map(zone=>'zone:'+zone) : [];
    const ownerFilter=allowed ? ` AND owner IN (${owners.map(()=>'?').join(',')})` : '';
    // Membership is derived from the same durable lease/generation that grants
    // action authority. There is no separate presence row to drift or revive.
    return this.sql.exec('SELECT DISTINCT owner FROM voxel_sessions WHERE lease_expires>? AND (exp=0 OR exp>?)'+ownerFilter,
      now,Math.floor(now/1000),...owners).toArray()
      .map(row=>typeof row.owner==='string' && row.owner.startsWith('zone:') ? normalizeZoneId(row.owner.slice(5)) : null)
      .filter(zone=>zone && (!allowed || allowed.has(zone)))
      .sort();
  }

  grantPayment(uid, item, amount, transactionId) {
    if (
      typeof uid !== 'string' || !uid ||
      typeof transactionId !== 'string' || !transactionId
    ) {
      return { ok:false, error:'Invalid payment data' };
    }

    const config = PAYMENT_CONFIG;

    const cfg = config[item];

    if (!cfg || Number(amount) !== cfg.price) {
      return { ok:false, error:'Invalid item or amount' };
    }

    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const oldPayment = this.sql.exec(
        'SELECT transaction_id FROM voxel_payments WHERE transaction_id=?',
        transactionId
      ).toArray()[0];

      if (oldPayment) {
        return { ok:false, duplicate:true, error:'Payment already granted' };
      }

      const current = this.sql.exec(
        'SELECT speed_expires, coin_expires, vip1_expires FROM voxel_entitlements WHERE uid=?',
        uid
      ).toArray()[0] || {
        speed_expires: 0,
        coin_expires: 0,
        vip1_expires: 0
      };

      const currentExpiry = Number(current[cfg.column]) || 0;

      // VIP จำกัดสูงสุด 100 บัญชีที่ยังมีสิทธิ์ใช้งาน
      // ผู้ที่มี VIP อยู่แล้วสามารถต่ออายุได้แม้ครบ 100 คน
      if (item === 'vip1' && currentExpiry <= now) {
        const activeVipCount = Number(
          this.sql.exec(
            'SELECT COUNT(*) AS count FROM voxel_entitlements WHERE vip1_expires>?',
            now
          ).toArray()[0]?.count || 0
        );

        if (activeVipCount >= VIP_ENTITLEMENT_CAP) {
          return {
            ok:false,
            error:'VIP server is full'
          };
        }
      }

      const base = currentExpiry > now ? currentExpiry : now;
      const newExpiry = base + cfg.duration;

      this.sql.exec(
        `INSERT INTO voxel_entitlements
          (uid, speed_expires, coin_expires, vip1_expires, updated_at)
         VALUES (?, 0, 0, 0, ?)
         ON CONFLICT(uid) DO NOTHING`,
        uid, now
      );

      this.sql.exec(
        `UPDATE voxel_entitlements
         SET ${cfg.column}=?, updated_at=?
         WHERE uid=?`,
        newExpiry, now, uid
      );

      this.sql.exec(
        `INSERT INTO voxel_payments
          (transaction_id, uid, item, amount, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        transactionId, uid, item, cfg.price, now
      );

      const entitlements = this.sql.exec(
        `SELECT speed_expires, coin_expires, vip1_expires
         FROM voxel_entitlements WHERE uid=?`,
        uid
      ).toArray()[0];

      return {
        ok:true,
        item,
        expiresAt:newExpiry,
        entitlements
      };
    });
  }

  async fetch(request) {
    await this.ready;

    const url = new URL(request.url);

    if (url.pathname.startsWith('/_internal/2c2p/')) return handle2c2pInternal(request,this);

    if (url.pathname==='/_internal/staging-handoff-commit' && request.method==='POST') {
      if (this.env.APP_ENV!=='staging') return Response.json({ok:false},{status:404});
      let payload;
      try { payload=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      try {
        const result=this.completeStagingHandoff(payload);
        if (result.ok) this.ctx.waitUntil(this.scheduleEconomyAlarm());
        return Response.json(result,{status:result.ok ? 200 : 409});
      } catch (_) { return Response.json({ok:false,error:'Staging handoff unavailable'},{status:503}); }
    }

    if (url.pathname==='/_internal/configure-scope' && request.method==='POST') {
      let body;
      try { body=await request.json(); } catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      if (!body || Object.keys(body).length!==1 || body.scope!=='vip1')
        return Response.json({ok:false,error:'Invalid server scope'},{status:400});
      // Only the Worker router can reach this private path. The named VIP room
      // durably keeps its scope across restart and never publishes Free events.
      await this.ctx.storage.put('serverScope','vip1');
      this.serverScope='vip1';
      return Response.json({ok:true,scope:this.serverScope});
    }
    if (url.pathname==='/_internal/session-revoke' && request.method==='POST') {
      if (this.serverScope!=='vip1') return Response.json({ok:false,error:'Not a VIP room'},{status:403});
      let body;
      try { body=await request.json(); } catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      if (!validVipUid(body?.uid) || typeof body.sessionId!=='string' || !body.sessionId || body.sessionId.length>256)
        return Response.json({ok:false,error:'Invalid session revocation'},{status:400});
      // No callback into the coordinator: its seat is already retired. Release
      // this exact local generation before closing to fence an in-flight frame.
      this.sessions.release({uid:body.uid,sessionId:body.sessionId,owner:this.sessionOwner()});
      return Response.json(this.revokeSession(body));
    }
    if (url.pathname.startsWith('/_internal/vip/')) {
      if (this.serverScope!=='free1') return Response.json({ok:false,error:'Not the entitlement authority'},{status:403});
      if (request.method!=='POST') return Response.json({ok:false,error:'Method not allowed'},{status:405});
      const action=url.pathname.slice('/_internal/vip/'.length);
      if (!['apply-event','admit','validate','renew','release','status'].includes(action))
        return Response.json({ok:false,error:'Unknown VIP action'},{status:404});
      let body;
      try { body=await request.json(); } catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      if (!body || typeof body!=='object' || Array.isArray(body))
        return Response.json({ok:false,error:'Invalid VIP request'},{status:400});
      try {
        let result;
        if (action==='apply-event') {
          const event=normalizePaymentEvent(body.event);
          if (body.fingerprint!==await paymentEventFingerprint(event))
            return Response.json({ok:false,error:'Provider event integrity conflict'},{status:400});
          result=this.vip.applyEvent({event,fingerprint:body.fingerprint});
          if (result.ok && result.revokedSessionId) {
            const response=await this.env.ROOM.getByName('vip1-v2-demo').fetch(
              new Request('https://internal/_internal/session-revoke',{
                method:'POST',headers:{'content-type':'application/json'},
                body:JSON.stringify({uid:result.uid,sessionId:result.revokedSessionId})
              }));
            const revoked=await response.json();
            if (!response.ok || !revoked?.ok) throw Error('VIP revocation unavailable');
          }
        } else if (action==='status') {
          if (body.uid!==undefined && !validVipUid(body.uid))
            return Response.json({ok:false,error:'Invalid VIP identity'},{status:400});
          const count=this.vip.count();
          result={ok:true,count,max:VIP_PRODUCT.capacity};
          if (body.uid) {
            result.entitlement=this.vip.entitlement(body.uid);
            result.entitlements=this.entitlementSnapshot(body.uid);
            result.seatSessionId=this.sql.exec('SELECT session_id FROM voxel_vip_seats WHERE uid=?',body.uid).toArray()[0]?.session_id||null;
          }
        } else {
          result=this.vip[action](body);
          if (result.ok && body.uid) result.entitlements=this.entitlementSnapshot(body.uid);
        }
        return Response.json(result,{status:result.ok ? 200 : result.status||409});
      } catch (_) { return Response.json({ok:false,error:'VIP authority unavailable'},{status:503}); }
    }

    if (url.pathname==='/_internal/active-zones' && request.method==='GET') {
      const zone=url.searchParams.has('zone') ? normalizeZoneId(url.searchParams.get('zone')) : null;
      if (url.searchParams.has('zone') && !zone)
        return Response.json({ok:false,error:'Invalid zone'},{status:400});
      try {
        return Response.json({ok:true,zones:this.activeZoneIds(zone ? adjacentZoneIds(zone) : null),serverNow:Date.now()});
      } catch (_) {
        return Response.json({ok:false,error:'Routing authority unavailable'},{status:503});
      }
    }

    if (url.pathname==='/_internal/zone-world-state' && request.method==='POST') {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      const uid=typeof body?.uid==='string' ? body.uid : '';
      if (!uid || uid.length>128) return Response.json({ok:false,error:'Invalid UID'},{status:400});
      try {
        if (!this.ownsZoneSession(body,uid))
          return Response.json({ok:false,error:'Session no longer owned'},{status:403});
        return Response.json({ok:true,coins:this.coinSnapshot(),luckyBox:this.boxSnapshot(),
          score:this.economy.score(uid),leaderboard:this.top(),serverNow:Date.now()});
      } catch (_) {
        return Response.json({ok:false,error:'World state unavailable'},{status:503});
      }
    }

    if (url.pathname.startsWith('/_internal/session/')) {
      const action=url.pathname.slice('/_internal/session/'.length);
      if (request.method!=='POST') return Response.json({ok:false,error:'Method not allowed'},{status:405});
      if (!['acquire','validate','checkpoint','release','transfer','revoke'].includes(action))
        return Response.json({ok:false,error:'Unknown session action'},{status:404});
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      if (!body || typeof body!=='object' || Array.isArray(body))
        return Response.json({ok:false,error:'Invalid session request'},{status:400});
      try {
        const result=await this.sessionCall(action,body);
        const value=typeof result==='boolean' ? {ok:result} : result;
        return Response.json(value,{status:value?.ok ? 200 : 409});
      } catch (_) {
        return Response.json({ok:false,error:'Session storage unavailable'},{status:503});
      }
    }

    if (
      url.pathname === '/_internal/get-entitlements' &&
      request.method === 'POST'
    ) {
      let body;

      try {
        body = await request.json();
      } catch {
        return Response.json(
          { ok:false, error:'Invalid JSON' },
          { status:400 }
        );
      }

      const uid = String(body.uid || '');

      if (!uid || uid.length > 128) {
        return Response.json(
          { ok:false, error:'Invalid UID' },
          { status:400 }
        );
      }

      const now = Date.now();

      const row = this.sql.exec(
        `SELECT speed_expires, coin_expires, vip1_expires
         FROM voxel_entitlements
         WHERE uid=?`,
        uid
      ).toArray()[0] || {
        speed_expires: 0,
        coin_expires: 0,
        vip1_expires: 0
      };

      const speedExpires = Number(row.speed_expires) || 0;
      const coinExpires = Number(row.coin_expires) || 0;
      const vip1Expires = this.vip.entitlement(uid).expiresAt;

      const vip1Count = this.vip.count(now);

      return Response.json({
        ok:true,
        serverNow:now,
        entitlements:{
          speedExpires,
          coinExpires,
          vip1Expires
        },
        servers:{
          vip1:{
            count:vip1Count,
            max:VIP_ENTITLEMENT_CAP
          }
        },
        active:{
          speed:speedExpires > now,
          coin:coinExpires > now,
          vip1:vip1Expires > now
        }
      });
    }



    // FREE_10K_PHASE2B1 — secure one-time handoff tickets.
    if (
      url.pathname === '/_internal/create-zone-handoff' &&
      request.method === 'POST'
    ) {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid=String(body?.uid||'');
      const playerId=String(body?.playerId||'');
      const sessionId=String(body?.sessionId||'');
      const fromZone=normalizeZoneId(body?.fromZone);
      const toZone=normalizeZoneId(body?.toZone);
      const x=Number(body?.x), y=Number(body?.y), z=Number(body?.z), r=Number(body?.r);

      if (!uid || uid.length>128 || !playerId || playerId.length>128 || !sessionId || sessionId.length>256 ||
          !fromZone || !toZone || !zonesAreAdjacent(fromZone,toZone) ||
          ![x,y,z,r].every(Number.isFinite) ||
          Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 ||
          zoneFromPosition(x,z)!==toZone) {
        return Response.json({ok:false,error:'Invalid handoff'},{status:400});
      }
      if (!this.sessions.validate({uid,sessionId,owner:`zone:${fromZone}`}) ||
          this.sessions.row(uid)?.player_id!==playerId)
        return Response.json({ok:false,error:'Source session not owned'},{status:409});

      const now=Date.now();
      const expiresAt=now+12000;
      const continuousHandoff=this.env.APP_ENV==='staging' && body.continuousHandoff===true;
      const token=(continuousHandoff ? 'continuous:' : '')+crypto.randomUUID();
      this.sql.exec('DELETE FROM voxel_zone_handoffs WHERE expires_at<=?',now);
      this.sql.exec('DELETE FROM voxel_handoff_grants WHERE expires_at<=?',now);
      this.sql.exec(
        `INSERT INTO voxel_zone_handoffs
         (token,uid,player_id,from_zone,to_zone,x,y,z,r,expires_at,created_at,session_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        token,uid,playerId,fromZone,toZone,x,y,z,r,expiresAt,now,sessionId
      );

      return Response.json({ok:true,token,expiresAt,toZone,...(continuousHandoff ? {continuousHandoff:true} : {})});
    }

    if (
      url.pathname === '/_internal/consume-zone-handoff' &&
      request.method === 'POST'
    ) {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid=String(body?.uid||'');
      const token=String(body?.token||'');
      const toZone=normalizeZoneId(body?.toZone);
      const now=Date.now();

      if (!uid || uid.length>128 || !token || token.length>128 || !toZone) {
        return Response.json({ok:false,error:'Invalid handoff'},{status:400});
      }

      const result=this.ctx.storage.transactionSync(()=>{
        const row=this.sql.exec(
          `SELECT token,uid,player_id,from_zone,to_zone,x,y,z,r,expires_at,created_at,session_id
           FROM voxel_zone_handoffs WHERE token=?`,
          token
        ).toArray()[0];

        if (!row || row.uid!==uid || row.to_zone!==toZone || Number(row.expires_at||0)<=now ||
            !this.sessions.validate({uid,sessionId:row.session_id,owner:`zone:${row.from_zone}`}) ||
            (this.env.APP_ENV==='staging' &&
              token.startsWith('continuous:')!==(body.continuousHandoff===true))) {
          return null;
        }

        this.sql.exec(`INSERT INTO voxel_handoff_grants
          (token,uid,session_id,from_owner,to_owner,expires_at,status)
          VALUES (?,?,?,?,?,?,'pending')`,token,uid,row.session_id,
          `zone:${row.from_zone}`,`zone:${row.to_zone}`,Number(row.expires_at));
        this.sql.exec('DELETE FROM voxel_zone_handoffs WHERE token=?',token);
        return {
          playerId:String(row.player_id),
          fromZone:String(row.from_zone),
          toZone:String(row.to_zone),
          sessionId:String(row.session_id),
          expiresAt:Number(row.expires_at),
          x:Number(row.x),y:Number(row.y),z:Number(row.z),r:Number(row.r),
          createdAt:Number(row.created_at)||now,
          ...(this.env.APP_ENV==='staging' && token.startsWith('continuous:') ? {continuousHandoff:true} : {})
        };
      });

      if (!result) return Response.json({ok:false,error:'Handoff expired or invalid'},{status:409});
      return Response.json({ok:true,...result,serverNow:now});
    }

    if (url.pathname==='/_internal/cancel-zone-handoff' && request.method==='POST') {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      const token=body?.token;
      if (typeof token!=='string' || !token || token.length>128 || !this.ownsZoneSession(body,body?.uid))
        return Response.json({ok:false,error:'Source session not owned'},{status:409});
      const cancelled=this.ctx.storage.transactionSync(()=>{
        const issued=this.sql.exec('SELECT uid,session_id,from_zone FROM voxel_zone_handoffs WHERE token=?',token).toArray()[0];
        const grant=this.sql.exec('SELECT * FROM voxel_handoff_grants WHERE token=?',token).toArray()[0];
        if (issued && (issued.uid!==body.uid || issued.session_id!==body.sessionId || `zone:${issued.from_zone}`!==body.owner)) return false;
        if (grant && (grant.uid!==body.uid || grant.session_id!==body.sessionId || grant.from_owner!==body.owner || grant.status==='complete')) return false;
        this.sql.exec('DELETE FROM voxel_zone_handoffs WHERE token=?',token);
        this.sql.exec("UPDATE voxel_handoff_grants SET status='cancelled' WHERE token=? AND status='pending'",token);
        return true;
      });
      return Response.json({ok:cancelled},{status:cancelled ? 200 : 409});
    }

    // Zones submit only a server-owned session generation. Contact comes
    // from its latest durable server checkpoint, never from request coordinates.
    if (url.pathname==='/_internal/zone-collect' && request.method==='POST') {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      const uid=String(body?.uid||'');
      const id=Number(body?.id);
      if (!uid || uid.length>128 || !Number.isInteger(id) || id<0 || id>=COINS.length)
        return Response.json({ok:false,error:'Invalid collect request'},{status:400});
      const position=this.economyPosition(body,uid);
      if (!position) return Response.json({ok:false,error:'Session no longer owned'},{status:403});
      let result;
      try { result=this.economy.collectCoin({uid,id,position,requestId:body.requestId}); }
      catch (_) { return Response.json({ok:false,error:'Score storage unavailable'},{status:500}); }
      if (!result.ok) {
        result.id=id;
        result.activeAfter=Number(this.economy.coinRow(id).respawn_at)||0;
      }
      if (!result.collected) {
        result.event=this.economy.coinEvent(id,Date.now());
        result.cycle=result.event.cycle;
      }
      if (result.collected) result.leaderboard=result.replayed ? this.top() : this.publishCoin(result);
      return Response.json(result,{status:result.ok ? 200 : result.status||409});
    }

    if (url.pathname==='/_internal/zone-collect-box' && request.method==='POST') {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      const uid=String(body?.uid||'');
      if (!uid || uid.length>128) return Response.json({ok:false,error:'Invalid Lucky Box request'},{status:400});
      const position=this.economyPosition(body,uid);
      if (!position) return Response.json({ok:false,error:'Session no longer owned'},{status:403});
      let result;
      try { result=this.economy.claimBox({uid,position,requestId:body.requestId}); }
      catch (_) { return Response.json({ok:false,error:'Lucky Box storage unavailable'},{status:500}); }
      if (!result.ok) result.box=this.boxSnapshot();
      if (result.box && !result.replayed) this.publishBox(result.box,result.serverNow);
      if (result.claimed && !result.replayed) this.ctx.waitUntil(this.scheduleEconomyAlarm());
      return Response.json(result,{status:result.ok ? 200 : result.status||409});
    }

    if (url.pathname==='/_internal/zone-spin-box' && request.method==='POST') {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      const uid=String(body?.uid||'');
      if (!uid || uid.length>128) return Response.json({ok:false,error:'Invalid Lucky Box request'},{status:400});
      if (!this.ownsZoneSession(body,uid)) return Response.json({ok:false,error:'Session no longer owned'},{status:403});
      let result;
      try { result=this.economy.spinBox({uid,requestId:body.requestId}); }
      catch (_) { return Response.json({ok:false,error:'Lucky Box storage unavailable'},{status:500}); }
      if (result.ok) {
        result.leaderboard=this.top();
        if (!result.replayed) {
          this.publishBox(result.box,result.serverNow);
          const event={type:WS_MESSAGE.LEADERBOARD,top:result.leaderboard};
          this.broadcast(event);
          this.ctx.waitUntil(this.sendAllZones(event));
          this.ctx.waitUntil(this.scheduleEconomyAlarm());
        }
      }
      return Response.json(result,{status:result.ok ? 200 : result.status||409});
    }

    if (
      url.pathname === '/_internal/zone-bootstrap' &&
      request.method === 'POST'
    ) {
      let body;
      try { body = await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid = String(body?.uid || '');
      if (!uid || uid.length > 128) {
        return Response.json({ok:false,error:'Invalid UID'},{status:400});
      }

      const now = Date.now();
      const fallbackName = 'Player-' + uid.slice(-6);
      const nickname = normalizePlayerName(body?.name, fallbackName);
      const previous = this.sql.exec(
        'SELECT nickname FROM voxel_scores WHERE uid=?',uid
      ).toArray()[0];

      this.sql.exec(
        `INSERT INTO voxel_scores(uid,nickname,score,updated_at)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(uid) DO UPDATE SET nickname=excluded.nickname`,
        uid, nickname, now
      );

      const score = Number(
        this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score || 0
      );

      if (!previous || String(previous.nickname || '') !== nickname) {
        const leaderboardNow=this.top();
        const fingerprint=JSON.stringify(leaderboardNow);
        // A newly registered player outside the top ten does not change the
        // shared board. Avoid quadratic identical fan-out during admission.
        // Every welcome still reads the current board; restart republishes on
        // its first bootstrap because this delivery cache is not authority.
        if (fingerprint!==this.lastZoneLeaderboard) {
          this.lastZoneLeaderboard=fingerprint;
          this.ctx.waitUntil(this.sendAllZones({type:WS_MESSAGE.LEADERBOARD,top:leaderboardNow}));
        }
      }

      const ent = this.sql.exec(
        `SELECT speed_expires, coin_expires, vip1_expires
         FROM voxel_entitlements WHERE uid=?`,
        uid
      ).toArray()[0] || {speed_expires:0,coin_expires:0,vip1_expires:0};

      return Response.json({
        ok:true,
        serverNow:now,
        nickname,
        score,
        leaderboard:this.top(),
        coins:this.coinSnapshot(),
        luckyBox:this.boxSnapshot(now),
        entitlements:{
          speedExpires:Number(ent.speed_expires)||0,
          coinExpires:Number(ent.coin_expires)||0,
          vip1Expires:Number(ent.vip1_expires)||0
        }
      });
    }

    if (
      url.pathname === '/_internal/grant-payment' &&
      request.method === 'POST'
    ) {
      let body;

      try {
        body = await request.json();
      } catch {
        return Response.json(
          { ok:false, error:'Invalid JSON' },
          { status:400 }
        );
      }

      try {
        const result = this.grantPayment(
          body.uid,
          body.item,
          body.amount,
          body.transactionId
        );

        return Response.json(
          result,
          { status:result.ok ? 200 : 400 }
        );
      } catch (err) {
        return Response.json(
          { ok:false, error:'Payment storage failed' },
          { status:500 }
        );
      }
    }
    for (const ws of this.sockets()) {
      const player=this.player(ws);
      if (player?.uid && !this.activePlayer(player))
        await this.closeSession(ws,1008,'Session expired');
    }
    if (this.sockets().length>=ROOM_SOFT_CAP) return new Response('Scale test room full',{status:503});
    const pair=new WebSocketPair();
    const [client,server]=Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({authAttempts:0,acceptedAt:Date.now()});
    scheduleAuthDeadline(this,server);
    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws,message) {
    await this.ready;
    return enqueueFrame(this,ws,message,PROTOCOL_VERSION.LEGACY_ROOM,async (m,p)=>{
      if (m.type===WS_MESSAGE.AUTH) return this.handleAuth(ws,p,m);
      if (m.type===WS_MESSAGE.MOVE) return this.handleMove(ws,p,m);
      if (m.type===WS_MESSAGE.COLLECT) return this.handleCollect(ws,p,m);
      if (m.type===WS_MESSAGE.COLLECT_BOX) return this.handleCollectBox(ws,p,m);
      if (m.type===WS_MESSAGE.SPIN_BOX) return this.handleSpinBox(ws,p,m);
      ws.close(1008,'Message unavailable in this room');
    });
  }

  async handleAuth(ws,p,m) {
    if (!p.uid) {
      if (++p.authAttempts>3) { ws.close(1008,'Too many attempts'); return; }
      ws.serializeAttachment(p);
    }
    let verified;
    try { verified=await verifyFirebaseIdToken(m.token,this.projectId); }
    catch (_) { this.send(ws,{type:WS_MESSAGE.AUTH_ERROR,message:'Firebase sign-in failed'}); ws.close(1008,'Invalid ID token'); return; }
    p=this.player(ws); // Another auth frame may have completed during certificate fetch.
    if (!p || p.revoked || p.sessionClosed || (typeof ws.readyState==='number' && ws.readyState!==1)) return;
    if (!p.uid && Date.now()>=Number(p.acceptedAt)+SECURITY.authDeadlineMs) {
      ws.close(1008,'Authentication deadline exceeded');
      return;
    }
    if (p.uid && p.uid!==verified.uid) { ws.close(1008,'Different account'); return; }
    if (m.handoffToken) { ws.close(1008,'Handoff requires a target zone'); return; }
    if (p.uid) {
      const identity={uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()};
      if (!await this.sessionCall('validate',identity)) { ws.close(1008,'Session no longer owned'); return; }
      p=this.player(ws);
      if (ws.readyState!==1 || p?.revoked || p?.sessionClosed || p?.sessionId!==identity.sessionId ||
          verified.exp<=Math.floor(Date.now()/1000)) return;
      const checkpoint=await this.sessionCall('checkpoint',{
        ...identity,exp:verified.exp
      });
      if (!checkpoint.ok) { ws.close(1008,'Session no longer owned'); return; }
      p=this.player(ws);
      if (ws.readyState!==1 || p?.revoked || p?.sessionClosed || p?.sessionId!==identity.sessionId ||
          verified.exp<=Math.floor(Date.now()/1000) || !this.sessions.validate(identity)) {
        ws.close(1008,'Session no longer owned'); return;
      }
      p.exp=verified.exp;
      p.resumeExpiresAt=checkpoint.resumeExpiresAt;
      p.entitlements=this.entitlementSnapshot(p.uid);
      ws.serializeAttachment(p);
      clearAuthDeadline(ws);
      this.send(ws,{type:WS_MESSAGE.AUTH_REFRESHED,session:sessionMetadata(p),entitlements:p.entitlements,serverNow:Date.now()});
      return;
    }
    const uid=verified.uid, now=Date.now();
    const n=this.count();
    const session=await this.sessionCall('acquire',{
      uid,owner:this.sessionOwner(),playerId:crypto.randomUUID(),
      position:{x:(n%5)*2-4,y:0,z:Math.floor(n/5)*2,r:0},exp:verified.exp,
      ...(Object.hasOwn(m,'resumeToken') ? {resumeToken:m.resumeToken} : {})
    });
    if (!session?.ok) {
      this.send(ws,{type:WS_MESSAGE.AUTH_ERROR,message:session?.error||'Session resume failed'});
      ws.close(1008,'Invalid session resume');
      return;
    }
    if (!this.sessions.validate({uid,sessionId:session.sessionId,owner:this.sessionOwner()})) {
      ws.close(1008,'Session no longer owned');
      return;
    }
    if ((typeof ws.readyState==='number' && ws.readyState!==1) ||
        Date.now()>=Number(p.acceptedAt)+SECURITY.authDeadlineMs ||
        verified.exp<=Math.floor(Date.now()/1000)) {
      await this.sessionCall('release',{uid,sessionId:session.sessionId,owner:this.sessionOwner()});
      ws.close(1008,'Authentication deadline exceeded');
      return;
    }
    const id=session.playerId;
    const nickname=normalizePlayerName(m?.name,'Player-'+uid.slice(-6));
    this.sql.exec('INSERT INTO voxel_scores(uid,nickname,score,updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(uid) DO UPDATE SET nickname=excluded.nickname',uid,nickname,now);
    const score=this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score||0;
    Object.assign(p,{uid,exp:verified.exp,id,nickname:normalizePlayerName(m?.name,nickname),
      ...session.position,sessionId:session.sessionId,resumeToken:session.resumeToken,
      resumeExpiresAt:session.resumeExpiresAt,checkpointRevision:session.checkpointRevision,at:now,last:0,lastCollect:0,
      entitlements:this.entitlementSnapshot(uid)});
    initializeMotion(p,now);
    ws.serializeAttachment(p);
    clearAuthDeadline(ws);
    this.send(ws,{type:WS_MESSAGE.WELCOME,protocol:PROTOCOL_VERSION.LEGACY_ROOM,id,...(this.serverScope==='vip1' ? {server:'vip1'} : {}),spawn:{x:p.x,y:p.y,z:p.z},
      players:this.nearbySockets(p,ws).map(other=>this.publicPlayer(this.player(other))).filter(Boolean),
      coins:this.coinSnapshot(),luckyBox:this.boxSnapshot(now),score,leaderboard:this.top(),serverNow:now,count:this.count(),
      session:sessionMetadata(p),resumed:session.resumed,entitlements:p.entitlements,movement:publicMovement(p)});
    this.broadcastNearby({type:WS_MESSAGE.JOIN,player:this.publicPlayer(p),count:this.count()},p,ws);
    this.broadcast({type:WS_MESSAGE.LEADERBOARD,top:this.top()});
  }

  boxSnapshot(now=Date.now()) { return this.economy.boxSnapshot(now); }

  handleCollectBox(ws,p,m={}) {
    if (!this.ownsSession(ws,p)) return false;
    let result;
    try { result=this.economy.claimBox({uid:p.uid,position:p,requestId:m.requestId}); }
    catch (_) { this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'Lucky Box storage unavailable',requestId:m.requestId}); return false; }
    if (!result.ok) {
      this.send(ws,{type:WS_MESSAGE.BOX_STATE,box:this.boxSnapshot(),serverNow:Date.now(),requestId:m.requestId,claimed:false});
      return false;
    }
    if (!result.replayed) this.publishBox(result.box,result.serverNow);
    if (result.claimed && !result.replayed) this.ctx.waitUntil(this.scheduleEconomyAlarm());
    if (result.claimed) this.send(ws,{type:WS_MESSAGE.BOX_SPIN_READY,box:result.box,serverNow:result.serverNow,
      receipt:result.receipt,replayed:result.replayed,requestId:m.requestId});
    else this.send(ws,{type:WS_MESSAGE.BOX_STATE,box:result.box,serverNow:result.serverNow,requestId:m.requestId,claimed:false});
    return result.claimed===true;
  }

  handleSpinBox(ws,p,m={}) {
    if (!this.ownsSession(ws,p)) return false;
    let result;
    try { result=this.economy.spinBox({uid:p.uid,requestId:m.requestId}); }
    catch (_) { this.send(ws,{type:WS_MESSAGE.BOX_ERROR,message:'Lucky Box storage unavailable',requestId:m.requestId}); return false; }
    if (!result.ok) {
      this.send(ws,{type:WS_MESSAGE.BOX_ERROR,message:result.error||'Lucky Box spin failed',requestId:m.requestId});
      this.send(ws,{type:WS_MESSAGE.BOX_STATE,box:this.boxSnapshot(),serverNow:Date.now()});
      return false;
    }
    this.send(ws,{type:WS_MESSAGE.BOX_REWARD,reward:result.reward,score:result.score,serverNow:result.serverNow,
      receipt:result.receipt,replayed:result.replayed,requestId:m.requestId});
    if (!result.replayed) {
      this.publishBox(result.box,result.serverNow);
      const event={type:WS_MESSAGE.LEADERBOARD,top:this.top()};
      this.broadcast(event);
      this.ctx.waitUntil(this.sendAllZones(event));
      this.ctx.waitUntil(this.scheduleEconomyAlarm());
    }
    return true;
  }

  handleMove(ws,p,m) {
    if (!this.ownsSession(ws,p)) return;
    const now=Date.now();
    if (m.frames === undefined && now-p.last<MOVE_TICK_MS) {
      this.send(ws,{type:WS_MESSAGE.MOVE,player:this.publicPlayer(p),ack:m.seq,applied:false,
        movement:publicMovement(p),velocity:{x:p.motion.vx,y:p.motion.vy,z:p.motion.vz},
        grounded:p.motion.grounded,serverNow:now});
      return;
    }
    const speedEntitlement = this.sql.exec(
      'SELECT speed_expires FROM voxel_entitlements WHERE uid=?',
      p.uid
    ).toArray()[0];

    const speedActive =
      Number(speedEntitlement?.speed_expires || 0) > now;

    if (!applyMovementIntent(p,m,speedActive ? MOVEMENT.entitledSpeed : MOVEMENT.speed,now)) return;
    ws.serializeAttachment(p);
    this.send(ws,{type:WS_MESSAGE.MOVE,player:this.publicPlayer(p),ack:m.seq,applied:true,
      movement:publicMovement(p),velocity:{x:p.motion.vx,y:p.motion.vy,z:p.motion.vz},
      grounded:p.motion.grounded,serverNow:now});
    this.broadcastNearby({type:WS_MESSAGE.MOVE,player:this.publicPlayer(p)},p,ws);
  }

  async handleCollect(ws,p,m) {
    if (!this.ownsSession(ws,p)) return false;
    const now=Date.now(), id=m.id;
    if (!Number.isInteger(id) || id<0 || id>=COINS.length) return false;
    if (now-p.lastCollect<150) {
      this.send(ws,{...this.economy.coinEvent(id,now),type:WS_MESSAGE.COIN_STATE,
        requestId:m.requestId,retryAfterMs:Math.min(150,150-(now-p.lastCollect))});
      return false;
    }
    p.lastCollect=now;
    ws.serializeAttachment(p);
    let result;
    try { result=this.economy.collectCoin({uid:p.uid,id,position:p,requestId:m.requestId,now}); }
    catch (_) { this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'Score storage unavailable',requestId:m.requestId}); return false; }
    if (!result.ok) {
      this.send(ws,{...this.economy.coinEvent(id,now),type:WS_MESSAGE.COIN_STATE,
        requestId:m.requestId,retryAfterMs:150});
      return false;
    }
    if (!result.collected) {
      this.send(ws,{...this.economy.coinEvent(id,now),type:WS_MESSAGE.COIN_STATE,requestId:m.requestId});
      return false;
    }
    if (!result.replayed) this.publishCoin(result);
    else this.send(ws,result.event);
    this.send(ws,{type:WS_MESSAGE.SCORE,score:result.score,requestId:m.requestId,receipt:result.receipt,replayed:result.replayed});
    return true;
  }

  async webSocketClose(ws) {
    return this.closeSession(ws,1000,'Bye');
  }
  async webSocketError(ws) {
    return this.closeSession(ws,1011,'Connection error');
  }
  async closeSession(ws,code,reason) {
    clearAuthDeadline(ws);
    const p=this.player(ws);
    if (p?.uid && !p.sessionClosed) {
      p.sessionClosed=true;
      ws.serializeAttachment(p);
      try {
        const released=await this.sessionCall('release',{uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()});
        if (released.ok && !p.revoked && !p.provisional)
          this.broadcast({type:WS_MESSAGE.LEAVE,id:p.id,count:this.count()},ws);
      } catch (_) { /* Durable ownership remains fail-closed while storage is unavailable. */ }
    }
    try { ws.close(code,reason); } catch (_) {}
  }
}
