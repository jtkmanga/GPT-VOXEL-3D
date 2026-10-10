import { PLAYER_VISIBILITY_RADIUS, RESPAWN_MS, LUCKY_BOX_CLAIM_MS, LUCKY_BOX_RESPAWN_MS, ROOM_SOFT_CAP, MOVE_TICK_MS, VIP_ENTITLEMENT_CAP } from '../shared/config.mjs';
import { PAYMENT_CONFIG } from '../shared/catalog.mjs';
import { WS_MESSAGE, PROTOCOL_VERSION } from '../shared/protocol.mjs';
import { normalizePlayerName, normalizeZoneId, allZoneIds, zonesAreAdjacent, zoneFromPosition, zoneIdsNearPosition } from './spatial.mjs';
import { COINS, coinPosition, luckyBoxPosition, secureLuckyReward } from './world.mjs';
import { verifyFirebaseIdToken } from './firebase-auth.mjs';

export class GameRoom {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.projectId=env.FIREBASE_PROJECT_ID;
    this.sql=ctx.storage.sql;
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

    // Server-authoritative paid entitlements
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_entitlements (
      uid TEXT PRIMARY KEY,
      speed_expires INTEGER NOT NULL DEFAULT 0,
      coin_expires INTEGER NOT NULL DEFAULT 0,
      vip1_expires INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);

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
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS voxel_zone_handoffs_exp_idx ON voxel_zone_handoffs(expires_at)');

    this.ready=ctx.blockConcurrencyWhile(async()=>{
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
    });
  }
  player(ws) { return ws.deserializeAttachment(); }
  sockets() { return this.ctx.getWebSockets(); }
  count() { return this.sockets().filter(ws=>this.player(ws)?.uid).length; }
  send(ws,value) { try { ws.send(JSON.stringify(value)); } catch (_) {} }
  broadcast(value,except) {
    const data=JSON.stringify(value);
    for(const ws of this.sockets()) if(ws!==except && this.player(ws)?.uid) {
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
      if (!other?.uid) continue;
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
  coinSnapshot() {
    const rows = new Map(
      this.sql.exec('SELECT id, respawn_at, cycle FROM voxel_coins').toArray()
        .map(row => [Number(row.id), {respawnAt:Number(row.respawn_at)||0, cycle:Number(row.cycle)||0}])
    );
    return COINS.map((_,id) => {
      const row = rows.get(id) || {respawnAt:0, cycle:0};
      const pos = coinPosition(id, row.cycle);
      return {id,x:pos.x,z:pos.z,respawnAt:row.respawnAt,cycle:row.cycle};
    });
  }
  top() {
    return this.sql.exec('SELECT nickname, score FROM voxel_scores ORDER BY score DESC, updated_at ASC LIMIT 10').toArray();
  }

  async sendZoneEvent(zoneIds,event) {
    const ids=[...new Set((zoneIds||[]).map(normalizeZoneId).filter(Boolean))];
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
    return this.sendZoneEvent(allZoneIds(),event);
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
      const vip1Expires = Number(row.vip1_expires) || 0;

      const vip1Count = Number(
        this.sql.exec(
          'SELECT COUNT(*) AS count FROM voxel_entitlements WHERE vip1_expires>?',
          now
        ).toArray()[0]?.count || 0
      );

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
      const fromZone=normalizeZoneId(body?.fromZone);
      const toZone=normalizeZoneId(body?.toZone);
      const x=Number(body?.x), y=Number(body?.y), z=Number(body?.z), r=Number(body?.r);

      if (!uid || uid.length>128 || !playerId || playerId.length>128 ||
          !fromZone || !toZone || !zonesAreAdjacent(fromZone,toZone) ||
          ![x,y,z,r].every(Number.isFinite) ||
          Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 ||
          zoneFromPosition(x,z)!==toZone) {
        return Response.json({ok:false,error:'Invalid handoff'},{status:400});
      }

      const now=Date.now();
      const expiresAt=now+12000;
      const token=crypto.randomUUID();
      this.sql.exec('DELETE FROM voxel_zone_handoffs WHERE expires_at<=?',now);
      this.sql.exec(
        `INSERT INTO voxel_zone_handoffs
         (token,uid,player_id,from_zone,to_zone,x,y,z,r,expires_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        token,uid,playerId,fromZone,toZone,x,y,z,r,expiresAt,now
      );

      return Response.json({ok:true,token,expiresAt,toZone});
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
          `SELECT token,uid,player_id,from_zone,to_zone,x,y,z,r,expires_at,created_at
           FROM voxel_zone_handoffs WHERE token=?`,
          token
        ).toArray()[0];

        if (!row || row.uid!==uid || row.to_zone!==toZone || Number(row.expires_at||0)<=now) {
          return null;
        }

        this.sql.exec('DELETE FROM voxel_zone_handoffs WHERE token=?',token);
        return {
          playerId:String(row.player_id),
          fromZone:String(row.from_zone),
          toZone:String(row.to_zone),
          x:Number(row.x),y:Number(row.y),z:Number(row.z),r:Number(row.r),
          createdAt:Number(row.created_at)||now
        };
      });

      if (!result) return Response.json({ok:false,error:'Handoff expired or invalid'},{status:409});
      return Response.json({ok:true,...result,serverNow:now});
    }

    // Global coin collection for zoned players.
    if (
      url.pathname === '/_internal/zone-collect' &&
      request.method === 'POST'
    ) {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid=String(body?.uid||'');
      const id=Number(body?.id);
      const px=Number(body?.x), py=Number(body?.y), pz=Number(body?.z);
      const now=Date.now();

      if (!uid || uid.length>128 || !Number.isInteger(id) || id<0 || id>=COINS.length ||
          ![px,py,pz].every(Number.isFinite)) {
        return Response.json({ok:false,error:'Invalid collect request'},{status:400});
      }

      const visibleRow=this.sql.exec(
        'SELECT respawn_at,cycle FROM voxel_coins WHERE id=?',id
      ).toArray()[0] || {respawn_at:0,cycle:0};
      const visibleCycle=Number(visibleRow.cycle||0);
      const oldPos=coinPosition(id,visibleCycle);

      if (Math.hypot(px-oldPos.x,pz-oldPos.z)>2.35 || py>2.6) {
        return Response.json({ok:false,error:'Too far from coin'},{status:403});
      }

      let result;
      try {
        result=this.ctx.storage.transactionSync(()=>{
          const row=this.sql.exec(
            'SELECT respawn_at,cycle FROM voxel_coins WHERE id=?',id
          ).toArray()[0] || {respawn_at:0,cycle:0};
          const activeAfter=Number(row.respawn_at)||0;
          const oldCycle=Number(row.cycle)||0;
          if (activeAfter>now) return {collected:false,activeAfter,oldCycle};

          const nextCycle=oldCycle+1;
          const respawnAt=now+RESPAWN_MS;
          this.sql.exec(
            `INSERT INTO voxel_coins(id,respawn_at,cycle) VALUES (?,?,?)
             ON CONFLICT(id) DO UPDATE SET respawn_at=excluded.respawn_at,cycle=excluded.cycle`,
            id,respawnAt,nextCycle
          );

          const ent=this.sql.exec(
            'SELECT coin_expires FROM voxel_entitlements WHERE uid=?',uid
          ).toArray()[0];
          const reward=Number(ent?.coin_expires||0)>now ? 2 : 1;

          this.sql.exec(
            'UPDATE voxel_scores SET score=score+?,updated_at=? WHERE uid=?',
            reward,now,uid
          );
          const score=Number(
            this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score||0
          );
          return {collected:true,respawnAt,nextCycle,oldCycle,reward,score};
        });
      } catch (_) {
        return Response.json({ok:false,error:'Score storage unavailable'},{status:500});
      }

      if (!result.collected) {
        return Response.json({
          ok:true,collected:false,id,activeAfter:result.activeAfter,serverNow:now
        });
      }

      const nextPos=coinPosition(id,result.nextCycle);
      const event={
        type:WS_MESSAGE.COIN_COLLECTED,id,x:nextPos.x,z:nextPos.z,cycle:result.nextCycle,
        respawnAt:result.respawnAt,serverNow:now
      };
      const affected=[
        ...zoneIdsNearPosition(oldPos.x,oldPos.z),
        ...zoneIdsNearPosition(nextPos.x,nextPos.z)
      ];
      const leaderboard=this.top();

      // Do not hold the collector's response open while multiple Zone Durable Objects
      // receive fan-out updates. The collector gets an immediate authoritative ACK;
      // world/leaderboard propagation continues in waitUntil().
      this.ctx.waitUntil(this.sendZoneEvent(affected,event));
      this.ctx.waitUntil(this.sendAllZones({type:WS_MESSAGE.LEADERBOARD,top:leaderboard}));

      return Response.json({
        ok:true,collected:true,event,score:result.score,reward:result.reward,
        leaderboard,serverNow:now
      });
    }

    if (
      url.pathname === '/_internal/zone-collect-box' &&
      request.method === 'POST'
    ) {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid=String(body?.uid||'');
      const px=Number(body?.x), py=Number(body?.y), pz=Number(body?.z);
      const now=Date.now();
      if (!uid || uid.length>128 || ![px,py,pz].every(Number.isFinite)) {
        return Response.json({ok:false,error:'Invalid Lucky Box request'},{status:400});
      }

      const snap=this.boxSnapshot(now);
      if (!snap.active) {
        return Response.json({ok:true,claimed:false,box:snap,serverNow:now});
      }
      if (Math.hypot(px-snap.x,pz-snap.z)>2.8 || py>3.2) {
        return Response.json({ok:false,error:'Too far from Lucky Box'},{status:403});
      }

      let claimed=false;
      try {
        claimed=this.ctx.storage.transactionSync(()=>{
          const row=this.sql.exec(
            'SELECT next_spawn_at,claimed_uid,claim_expires_at FROM voxel_lucky_box WHERE id=1'
          ).toArray()[0];
          if (!row || Number(row.next_spawn_at||0)>now) return false;
          if (row.claimed_uid && Number(row.claim_expires_at||0)>now && row.claimed_uid!==uid) return false;
          this.sql.exec(
            'UPDATE voxel_lucky_box SET claimed_uid=?,claim_expires_at=? WHERE id=1',
            uid,now+LUCKY_BOX_CLAIM_MS
          );
          return true;
        });
      } catch (_) {
        return Response.json({ok:false,error:'Lucky Box storage unavailable'},{status:500});
      }

      const state=this.boxSnapshot(now);
      await this.sendAllZones({type:WS_MESSAGE.BOX_STATE,box:state,serverNow:now});
      return Response.json({ok:true,claimed,box:state,serverNow:now});
    }

    if (
      url.pathname === '/_internal/zone-spin-box' &&
      request.method === 'POST'
    ) {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid=String(body?.uid||'');
      const now=Date.now();
      if (!uid || uid.length>128) {
        return Response.json({ok:false,error:'Invalid Lucky Box request'},{status:400});
      }

      const reward=secureLuckyReward();
      let result;
      try {
        result=this.ctx.storage.transactionSync(()=>{
          const row=this.sql.exec(
            'SELECT next_spawn_at,cycle,claimed_uid,claim_expires_at FROM voxel_lucky_box WHERE id=1'
          ).toArray()[0];
          if (!row) return {ok:false,error:'Lucky Box state missing'};
          if (Number(row.next_spawn_at||0)>now) return {ok:false,error:'Lucky Box is cooling down'};
          if (row.claimed_uid!==uid || Number(row.claim_expires_at||0)<=now) {
            return {ok:false,error:'Lucky Box claim expired'};
          }

          this.sql.exec(
            'UPDATE voxel_scores SET score=score+?,updated_at=? WHERE uid=?',
            reward,now,uid
          );
          const score=Number(
            this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score||0
          );
          const nextSpawnAt=now+LUCKY_BOX_RESPAWN_MS;
          const nextCycle=Number(row.cycle||0)+1;
          this.sql.exec(
            `UPDATE voxel_lucky_box
             SET next_spawn_at=?,cycle=?,claimed_uid=NULL,claim_expires_at=0
             WHERE id=1`,
            nextSpawnAt,nextCycle
          );
          return {ok:true,reward,score,nextSpawnAt,nextCycle};
        });
      } catch (_) {
        return Response.json({ok:false,error:'Lucky Box storage unavailable'},{status:500});
      }

      if (!result?.ok) return Response.json(result,{status:409});

      const box=this.boxSnapshot(now);
      const leaderboard=this.top();
      await this.sendAllZones({type:WS_MESSAGE.BOX_STATE,box,serverNow:now});
      await this.sendAllZones({type:WS_MESSAGE.LEADERBOARD,top:leaderboard});

      return Response.json({
        ok:true,reward:result.reward,score:result.score,box,leaderboard,serverNow:now
      });
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
        this.ctx.waitUntil(this.sendAllZones({type:WS_MESSAGE.LEADERBOARD,top:leaderboardNow}));
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
    if (this.sockets().length>=ROOM_SOFT_CAP) return new Response('Scale test room full',{status:503});
    const pair=new WebSocketPair();
    const [client,server]=Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({authAttempts:0,acceptedAt:Date.now()});
    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws,message) {
    await this.ready;
    if (typeof message!=='string' || message.length>8192) { ws.close(1009,'Invalid message'); return; }
    let m; try { m=JSON.parse(message); } catch (_) { return; }
    const p=this.player(ws);
    if (!p) return;
    if (m?.type===WS_MESSAGE.AUTH) return this.handleAuth(ws,p,m);
    if (!p.uid || Math.floor(Date.now()/1000)>=p.exp) { ws.close(1008,'Sign in required'); return; }
    if (message.length>256) return;
    if (m?.type===WS_MESSAGE.MOVE) return this.handleMove(ws,p,m);
    if (m?.type===WS_MESSAGE.COLLECT) return this.handleCollect(ws,p,m);
      if (m?.type===WS_MESSAGE.COLLECT_BOX) return this.handleCollectBox(ws,p,m);
      if (m?.type===WS_MESSAGE.SPIN_BOX) return this.handleSpinBox(ws,p,m);
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
    if (p.uid && p.uid!==verified.uid) { ws.close(1008,'Different account'); return; }
    if (p.uid) { p.exp=verified.exp; ws.serializeAttachment(p); this.send(ws,{type:WS_MESSAGE.AUTH_REFRESHED}); return; }
    const uid=verified.uid, now=Date.now(), id=crypto.randomUUID();
    const nickname='Player-'+uid.slice(-6);
    this.sql.exec('INSERT INTO voxel_scores(uid,nickname,score,updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(uid) DO NOTHING',uid,nickname,now);
    const score=this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score||0;
    const n=this.count();
    Object.assign(p,{uid,exp:verified.exp,id,nickname:normalizePlayerName(m?.name,nickname),x:(n%5)*2-4,y:0,z:Math.floor(n/5)*2,r:0,at:now,last:0,lastCollect:0});
    ws.serializeAttachment(p);
    this.send(ws,{type:WS_MESSAGE.WELCOME,protocol:PROTOCOL_VERSION.LEGACY_ROOM,id,spawn:{x:p.x,y:p.y,z:p.z},
      players:this.nearbySockets(p,ws).map(other=>this.publicPlayer(this.player(other))).filter(Boolean),
      coins:this.coinSnapshot(),luckyBox:this.boxSnapshot(now),score,leaderboard:this.top(),serverNow:now,count:this.count()});
    this.broadcastNearby({type:WS_MESSAGE.JOIN,player:this.publicPlayer(p),count:this.count()},p,ws);
    this.broadcast({type:WS_MESSAGE.LEADERBOARD,top:this.top()});
  }

  boxSnapshot(now = Date.now()) {
    let row = this.sql.exec(
      'SELECT next_spawn_at, cycle, claimed_uid, claim_expires_at FROM voxel_lucky_box WHERE id=1'
    ).toArray()[0] || { next_spawn_at:0, cycle:0, claimed_uid:null, claim_expires_at:0 };

    if (row.claimed_uid && Number(row.claim_expires_at || 0) <= now && Number(row.next_spawn_at || 0) <= now) {
      this.sql.exec('UPDATE voxel_lucky_box SET claimed_uid=NULL, claim_expires_at=0 WHERE id=1');
      row = { ...row, claimed_uid:null, claim_expires_at:0 };
    }

    const cycle = Number(row.cycle || 0);
    const pos = luckyBoxPosition(cycle);
    const nextSpawnAt = Number(row.next_spawn_at || 0);
    const claimExpiresAt = Number(row.claim_expires_at || 0);
    const claimed = Boolean(row.claimed_uid && claimExpiresAt > now);

    return {
      active: nextSpawnAt <= now && !claimed,
      x: pos.x,
      z: pos.z,
      nextSpawnAt,
      cycle,
      claimed,
      claimExpiresAt,
      serverNow: now
    };
  }

  handleCollectBox(ws,p) {
    const now = Date.now();
    const snap = this.boxSnapshot(now);
    if (!snap.active) {
      this.send(ws,{type:WS_MESSAGE.BOX_STATE,box:snap,serverNow:now});
      return;
    }
    if (Math.hypot(p.x-snap.x,p.z-snap.z) > 2.8 || p.y > 3.2) return;

    let claimed = false;
    try {
      claimed = this.ctx.storage.transactionSync(() => {
        const row = this.sql.exec(
          'SELECT next_spawn_at, claimed_uid, claim_expires_at FROM voxel_lucky_box WHERE id=1'
        ).toArray()[0];
        if (!row) return false;
        if (Number(row.next_spawn_at || 0) > now) return false;
        if (row.claimed_uid && Number(row.claim_expires_at || 0) > now && row.claimed_uid !== p.uid) return false;
        this.sql.exec(
          'UPDATE voxel_lucky_box SET claimed_uid=?, claim_expires_at=? WHERE id=1',
          p.uid, now + LUCKY_BOX_CLAIM_MS
        );
        return true;
      });
    } catch (_) { return; }

    const state = this.boxSnapshot(now);
    this.broadcast({type:WS_MESSAGE.BOX_STATE,box:state,serverNow:now});
    if (claimed) this.send(ws,{type:WS_MESSAGE.BOX_SPIN_READY,box:state,serverNow:now});
  }

  handleSpinBox(ws,p) {
    const now = Date.now();
    const reward = secureLuckyReward();
    let result;

    try {
      result = this.ctx.storage.transactionSync(() => {
        const row = this.sql.exec(
          'SELECT next_spawn_at, cycle, claimed_uid, claim_expires_at FROM voxel_lucky_box WHERE id=1'
        ).toArray()[0];
        if (!row) return {ok:false,message:'Lucky Box state missing'};
        if (Number(row.next_spawn_at || 0) > now) return {ok:false,message:'Lucky Box is cooling down'};
        if (row.claimed_uid !== p.uid || Number(row.claim_expires_at || 0) <= now) {
          return {ok:false,message:'Lucky Box claim expired'};
        }

        this.sql.exec(
          'UPDATE voxel_scores SET score=score+?, updated_at=? WHERE uid=?',
          reward, now, p.uid
        );
        const score = Number(this.sql.exec(
          'SELECT score FROM voxel_scores WHERE uid=?', p.uid
        ).toArray()[0]?.score || 0);

        const nextSpawnAt = now + LUCKY_BOX_RESPAWN_MS;
        const nextCycle = Number(row.cycle || 0) + 1;
        this.sql.exec(
          'UPDATE voxel_lucky_box SET next_spawn_at=?, cycle=?, claimed_uid=NULL, claim_expires_at=0 WHERE id=1',
          nextSpawnAt, nextCycle
        );
        return {ok:true,reward,score,nextSpawnAt,nextCycle};
      });
    } catch (_) {
      this.send(ws,{type:WS_MESSAGE.BOX_ERROR,message:'Lucky Box storage unavailable'});
      return;
    }

    if (!result?.ok) {
      this.send(ws,{type:WS_MESSAGE.BOX_ERROR,message:result?.message || 'Lucky Box spin failed'});
      this.send(ws,{type:WS_MESSAGE.BOX_STATE,box:this.boxSnapshot(now),serverNow:now});
      return;
    }

    this.send(ws,{type:WS_MESSAGE.BOX_REWARD,reward:result.reward,score:result.score,serverNow:now});
    this.broadcast({type:WS_MESSAGE.BOX_STATE,box:this.boxSnapshot(now),serverNow:now});
    this.broadcast({type:WS_MESSAGE.LEADERBOARD,top:this.top()});
  }


  handleMove(ws,p,m) {
    const now=Date.now();
    if (now-p.last<MOVE_TICK_MS) return;
    const {x,y,z,r}=m;
    if (![x,y,z,r].every(Number.isFinite)) return;
    if (Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 || Math.abs(r)>10000) return;
    const dt=Math.min(1.5,Math.max(0,(now-p.at)/1000));

    const speedEntitlement = this.sql.exec(
      'SELECT speed_expires FROM voxel_entitlements WHERE uid=?',
      p.uid
    ).toArray()[0];

    const speedActive =
      Number(speedEntitlement?.speed_expires || 0) > now;

    const maxHorizontalSpeed = speedActive ? 50 : 26;

    if (
      Math.hypot(x-p.x,z-p.z) > maxHorizontalSpeed*dt+.65 ||
      Math.abs(y-p.y) > 9*dt+.5
    ) return;
    Object.assign(p,{x,y,z,r,at:now,last:now});
    ws.serializeAttachment(p);
    this.broadcastNearby({type:WS_MESSAGE.MOVE,player:this.publicPlayer(p)},p,ws);
  }

  async handleCollect(ws,p,m) {
    const now=Date.now(), id=m.id;
    if (!Number.isInteger(id) || id<0 || id>=COINS.length || now-p.lastCollect<150) return;
    p.lastCollect=now; ws.serializeAttachment(p);
    const visibleRow = this.sql.exec(
      'SELECT cycle FROM voxel_coins WHERE id=?', id
    ).toArray()[0];
    const visibleCycle = Number(visibleRow?.cycle || 0);
    const {x,z} = coinPosition(id, visibleCycle);
    if (Math.hypot(p.x-x,p.z-z)>2.35 || p.y>2.6) return;
    let result;
    try {
      result=this.ctx.storage.transactionSync(()=>{
        const row=this.sql.exec(
          'SELECT respawn_at, cycle FROM voxel_coins WHERE id=?', id
        ).toArray()[0];
        const activeAfter=Number(row?.respawn_at)||0;
        if (activeAfter>now) return {activeAfter};
        const nextCycle=(Number(row?.cycle)||0)+1;
        const respawnAt=now+RESPAWN_MS;
        this.sql.exec(
          'INSERT INTO voxel_coins(id,respawn_at,cycle) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET respawn_at=excluded.respawn_at, cycle=excluded.cycle',
          id, respawnAt, nextCycle
        );
        const coinEntitlement = this.sql.exec(
          'SELECT coin_expires FROM voxel_entitlements WHERE uid=?',
          p.uid
        ).toArray()[0];

        const coinReward =
          Number(coinEntitlement?.coin_expires || 0) > now ? 2 : 1;

        this.sql.exec(
          'UPDATE voxel_scores SET score=score+?, updated_at=? WHERE uid=?',
          coinReward, now, p.uid
        );
        const score=this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',p.uid).toArray()[0].score;
        return {respawnAt,score,cycle:nextCycle};
      });
    } catch (_) { this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'Score storage unavailable'}); return; }
    if (result.activeAfter) {
      this.send(ws,{type:WS_MESSAGE.COIN_STATE,id,respawnAt:result.activeAfter,serverNow:now}); return;
    }
    const nextPos=coinPosition(id,Number(result.cycle)||0);
    this.broadcast({type:WS_MESSAGE.COIN_COLLECTED,id,x:nextPos.x,z:nextPos.z,cycle:result.cycle,respawnAt:result.respawnAt,serverNow:now});
    this.send(ws,{type:WS_MESSAGE.SCORE,score:result.score});
    this.broadcast({type:WS_MESSAGE.LEADERBOARD,top:this.top()});
  }

  async webSocketClose(ws) {
    const p=this.player(ws);
    if (p?.uid) this.broadcast({type:WS_MESSAGE.LEAVE,id:p.id,count:Math.max(0,this.count()-1)},ws);
    try { ws.close(1000,'Bye'); } catch (_) {}
  }
  async webSocketError(ws) {
    const p=this.player(ws);
    if (p?.uid) this.broadcast({type:WS_MESSAGE.LEAVE,id:p.id,count:Math.max(0,this.count()-1)},ws);
    try { ws.close(1011,'Connection error'); } catch (_) {}
  }
}
