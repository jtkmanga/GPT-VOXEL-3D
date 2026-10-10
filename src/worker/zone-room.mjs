import { PLAYER_VISIBILITY_RADIUS, BORDER_SNAPSHOT_INTERVAL_MS, ZONE_SOFT_CAP, MOVE_TICK_MS } from '../shared/config.mjs';
import { WS_MESSAGE, PROTOCOL_VERSION } from '../shared/protocol.mjs';
import { normalizePlayerName, normalizeZoneId, adjacentZoneIds, zonesAreAdjacent, zoneCenter, zoneFromPosition } from './spatial.mjs';
import { COINS } from './world.mjs';
import { verifyFirebaseIdToken } from './firebase-auth.mjs';

// Phase 2A movement-zone Durable Object.
// World state, scores, payments, coins and Lucky Box remain authoritative in GameRoom.
export class ZoneRoom {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.projectId=env.FIREBASE_PROJECT_ID;
    this.lastBorderFlushAt=0;
  }

  player(ws) { return ws.deserializeAttachment(); }
  sockets() { return this.ctx.getWebSockets(); }
  count() { return this.sockets().filter(ws=>this.player(ws)?.uid).length; }
  send(ws,value) { try { ws.send(JSON.stringify(value)); } catch (_) {} }
  broadcastAll(value,except) {
    const data=JSON.stringify(value);
    for(const ws of this.sockets()) {
      if(ws===except || !this.player(ws)?.uid) continue;
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

  publicPlayer(p) {
    return p?.uid && {
      id:p.id,x:p.x,y:p.y,z:p.z,r:p.r,
      name:normalizePlayerName(p.nickname,'Player')
    };
  }

  currentZoneId() {
    const objectName=String(this.ctx.id?.name||'');
    return normalizeZoneId(
      objectName.startsWith('free-zone-')
        ? objectName.slice('free-zone-'.length)
        : ''
    );
  }

  borderPlayers(exceptWs=null) {
    return this.sockets()
      .filter(ws=>ws!==exceptWs && this.player(ws)?.uid)
      .map(ws=>this.publicPlayer(this.player(ws)))
      .filter(Boolean);
  }

  async flushBorderSnapshot(force=false, exceptWs=null) {
    const now=Date.now();
    if (!force && now-this.lastBorderFlushAt<BORDER_SNAPSHOT_INTERVAL_MS) return;
    this.lastBorderFlushAt=now;

    const sourceZone=this.currentZoneId();
    if (!sourceZone) return;

    const players=this.borderPlayers(exceptWs);
    const payload=JSON.stringify({
      sourceZone,
      players,
      serverNow:now
    });

    await Promise.allSettled(
      adjacentZoneIds(sourceZone).map(zoneId=>
        this.env.ZONE.getByName(`free-zone-${zoneId}`).fetch(
          new Request('https://zone.internal/_internal/border-snapshot',{
            method:'POST',
            headers:{'content-type':'application/json'},
            body:payload
          })
        )
      )
    );
  }

  async sendInitialGhostSnapshots(ws,p) {
    const currentZone=this.currentZoneId();
    if (!currentZone || !p?.uid) return;

    await Promise.allSettled(
      adjacentZoneIds(currentZone).map(async zoneId=>{
        const response=await this.env.ZONE.getByName(`free-zone-${zoneId}`).fetch(
          new Request('https://zone.internal/_internal/border-state',{method:'GET'})
        );
        if (!response.ok) return;
        const state=await response.json();
        const players=Array.isArray(state?.players) ? state.players : [];
        const maxD2=PLAYER_VISIBILITY_RADIUS*PLAYER_VISIBILITY_RADIUS;
        const visible=players.filter(other=>{
          if (!other || typeof other.id!=='string' || other.id===p.id) return false;
          const x=Number(other.x), z=Number(other.z);
          if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
          const dx=x-Number(p.x||0), dz=z-Number(p.z||0);
          return dx*dx+dz*dz<=maxD2;
        });
        this.send(ws,{
          type:WS_MESSAGE.GHOST_SNAPSHOT,
          zone:zoneId,
          players:visible,
          serverNow:Number(state?.serverNow)||Date.now()
        });
      })
    );
  }

  async fetch(request) {
    const url=new URL(request.url);

    if (url.pathname==='/_internal/border-state' && request.method==='GET') {
      return Response.json({
        ok:true,
        zone:this.currentZoneId(),
        players:this.borderPlayers(),
        serverNow:Date.now()
      });
    }

    if (url.pathname==='/_internal/border-snapshot' && request.method==='POST') {
      let body;
      try { body=await request.json(); }
      catch (_) { return new Response('Bad JSON',{status:400}); }

      const currentZone=this.currentZoneId();
      const sourceZone=normalizeZoneId(body?.sourceZone);
      if (!currentZone || !sourceZone || !zonesAreAdjacent(currentZone,sourceZone)) {
        return new Response('Invalid source zone',{status:403});
      }

      const rawPlayers=Array.isArray(body?.players) ? body.players : [];
      if (rawPlayers.length>ZONE_SOFT_CAP+20) {
        return new Response('Snapshot too large',{status:413});
      }

      const players=[];
      for (const item of rawPlayers) {
        const id=String(item?.id||'');
        const x=Number(item?.x), y=Number(item?.y), z=Number(item?.z), r=Number(item?.r);
        if (!id || id.length>128 || ![x,y,z,r].every(Number.isFinite)) continue;
        if (Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 || Math.abs(r)>10000) continue;
        players.push({id,x,y,z,r,name:normalizePlayerName(item?.name,'Player')});
      }

      const maxD2=PLAYER_VISIBILITY_RADIUS*PLAYER_VISIBILITY_RADIUS;
      const serverNow=Number(body?.serverNow)||Date.now();

      for (const ws of this.sockets()) {
        const p=this.player(ws);
        if (!p?.uid) continue;

        const visible=players.filter(other=>{
          if (other.id===p.id) return false;
          const dx=other.x-Number(p.x||0);
          const dz=other.z-Number(p.z||0);
          return dx*dx+dz*dz<=maxD2;
        });

        this.send(ws,{
          type:WS_MESSAGE.GHOST_SNAPSHOT,
          zone:sourceZone,
          players:visible,
          serverNow
        });
      }

      return new Response('OK');
    }

    if (url.pathname==='/_internal/world-event' && request.method==='POST') {
      let event;
      try { event=await request.json(); }
      catch (_) { return new Response('Bad JSON',{status:400}); }
      this.broadcastAll(event);
      return new Response('OK');
    }

    if (request.headers.get('Upgrade')?.toLowerCase()!=='websocket')
      return new Response('WebSocket required',{status:426});

    const zoneId=this.currentZoneId();
    if (!zoneId) return new Response('Invalid zone',{status:400});

    if (this.sockets().length>=ZONE_SOFT_CAP)
      return new Response('Zone full',{status:503});

    const pair=new WebSocketPair();
    const [client,server]=Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      authAttempts:0,
      acceptedAt:Date.now(),
      zoneId
    });
    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws,message) {
    if (typeof message!=='string' || message.length>8192) {
      ws.close(1009,'Invalid message');
      return;
    }

    let m;
    try { m=JSON.parse(message); } catch (_) { return; }

    const p=this.player(ws);
    if (!p) return;

    if (m?.type===WS_MESSAGE.AUTH) return this.handleAuth(ws,p,m);

    if (!p.uid || Math.floor(Date.now()/1000)>=p.exp) {
      ws.close(1008,'Sign in required');
      return;
    }

    if (message.length>256) return;

    if (m?.type===WS_MESSAGE.HANDOFF_RESUME) return this.handleHandoffResume(ws,p,m);
    if (m?.type===WS_MESSAGE.HANDOFF_CANCEL) {
      p.handoffPending=null;
      p.handoffResume=null;
      ws.serializeAttachment(p);
      this.send(ws,{type:WS_MESSAGE.HANDOFF_CANCELLED,zone:p.zoneId,serverNow:Date.now()});
      return;
    }
    if (m?.type===WS_MESSAGE.MOVE) return this.handleMove(ws,p,m);
    if (m?.type===WS_MESSAGE.COLLECT) return this.handleCollect(ws,p,m);
    if (m?.type===WS_MESSAGE.COLLECT_BOX) return this.handleCollectBox(ws,p,m);
    if (m?.type===WS_MESSAGE.SPIN_BOX) return this.handleSpinBox(ws,p,m);
  }

  async handleAuth(ws,p,m) {
    if (!p.uid) {
      if (++p.authAttempts>3) {
        ws.close(1008,'Too many attempts');
        return;
      }
      ws.serializeAttachment(p);
    }

    let verified;
    try { verified=await verifyFirebaseIdToken(m.token,this.projectId); }
    catch (_) {
      this.send(ws,{type:WS_MESSAGE.AUTH_ERROR,message:'Firebase sign-in failed'});
      ws.close(1008,'Invalid ID token');
      return;
    }

    p=this.player(ws);

    if (p.uid && p.uid!==verified.uid) {
      ws.close(1008,'Different account');
      return;
    }

    if (p.uid) {
      p.exp=verified.exp;
      ws.serializeAttachment(p);
      this.send(ws,{type:WS_MESSAGE.AUTH_REFRESHED});
      return;
    }

    let bootstrap;
    try {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-bootstrap',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:verified.uid,name:normalizePlayerName(m?.name,'Player')})
        })
      );
      bootstrap=await response.json();
      if (!response.ok || !bootstrap?.ok) throw Error('bootstrap failed');
    } catch (_) {
      this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'World bootstrap unavailable'});
      ws.close(1011,'World bootstrap unavailable');
      return;
    }

    p=this.player(ws);
    const zoneId=normalizeZoneId(p.zoneId);
    const center=zoneCenter(zoneId);

    if (!center) {
      ws.close(1008,'Invalid zone');
      return;
    }

    let handoff=null;
    const handoffToken=String(m?.handoffToken||'');
    if (handoffToken) {
      try {
        const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
          new Request('https://internal/_internal/consume-zone-handoff',{
            method:'POST',
            headers:{'content-type':'application/json'},
            body:JSON.stringify({
              uid:verified.uid,
              token:handoffToken,
              toZone:zoneId
            })
          })
        );
        handoff=await response.json();
        if (!response.ok || !handoff?.ok) throw Error('handoff rejected');
      } catch (_) {
        this.send(ws,{type:WS_MESSAGE.HANDOFF_ERROR,message:'Zone handoff expired or invalid'});
        ws.close(1008,'Invalid handoff');
        return;
      }
    }

    const now=Date.now();
    const n=this.count();
    const col=n%10;
    const row=Math.floor(n/10)%10;
    const spawnX=handoff ? Number(handoff.x) : center.x+(col-4.5)*4;
    const spawnY=handoff ? Number(handoff.y) : 0;
    const spawnZ=handoff ? Number(handoff.z) : center.z+(row-4.5)*4;
    const spawnR=handoff ? Number(handoff.r) : 0;
    const id=handoff ? String(handoff.playerId) : crypto.randomUUID();

    Object.assign(p,{
      uid:verified.uid,
      exp:verified.exp,
      id,
      zoneId,
      x:spawnX,
      y:spawnY,
      z:spawnZ,
      r:spawnR,
      at:now,
      last:0,
      lastCollect:0,
      handoffPending:null,
      handoffResume: handoff ? {
        anchorX:spawnX,
        anchorY:spawnY,
        anchorZ:spawnZ,
        createdAt:Number(handoff.createdAt)||now,
        deadline:now+9000
      } : null,
      nickname:normalizePlayerName(bootstrap.nickname,m?.name || ('Player-'+verified.uid.slice(-6))),
      speedExpires:Number(bootstrap.entitlements?.speedExpires)||0
    });

    ws.serializeAttachment(p);

    this.send(ws,{
      type:WS_MESSAGE.WELCOME,
      protocol:PROTOCOL_VERSION.ZONE_ROOM,
      phase:'2B1',
      handoff:Boolean(handoff),
      fromZone:handoff?.fromZone||null,
      zone:zoneId,
      id,
      spawn:{x:p.x,y:p.y,z:p.z,r:p.r},
      players:this.nearbySockets(p,ws)
        .map(other=>this.publicPlayer(this.player(other)))
        .filter(Boolean),
      coins:Array.isArray(bootstrap.coins)?bootstrap.coins:[],
      luckyBox:bootstrap.luckyBox||null,
      score:Number(bootstrap.score)||0,
      leaderboard:Array.isArray(bootstrap.leaderboard)?bootstrap.leaderboard:[],
      serverNow:Number(bootstrap.serverNow)||now,
      count:this.count()
    });

    this.broadcastNearby({
      type:WS_MESSAGE.JOIN,
      player:this.publicPlayer(p),
      count:this.count()
    },p,ws);

    this.ctx.waitUntil(this.sendInitialGhostSnapshots(ws,p));
    this.ctx.waitUntil(this.flushBorderSnapshot(true));
  }

  async handleHandoffResume(ws,p,m) {
    const now=Date.now();
    const resume=p?.handoffResume;
    if (!resume || now>Number(resume.deadline||0)) {
      if (p?.uid) {
        p.handoffResume=null;
        ws.serializeAttachment(p);
      }
      this.send(ws,{type:WS_MESSAGE.HANDOFF_RESUME_ERROR,message:'Handoff resume window expired'});
      return;
    }

    const x=Number(m?.x), y=Number(m?.y), z=Number(m?.z), r=Number(m?.r);
    if (![x,y,z,r].every(Number.isFinite) ||
        Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 || Math.abs(r)>10000 ||
        zoneFromPosition(x,z)!==p.zoneId) {
      this.send(ws,{type:WS_MESSAGE.HANDOFF_RESUME_ERROR,message:'Invalid handoff resume position'});
      return;
    }

    const elapsed=Math.min(9,Math.max(0,(now-Number(resume.createdAt||now))/1000));
    const speedActive=Number(p.speedExpires||0)>now;
    const maxHorizontalSpeed=speedActive ? 50 : 26;
    const maxHorizontalDistance=maxHorizontalSpeed*elapsed+1.75;
    const maxVerticalDistance=9*elapsed+1.0;

    if (
      Math.hypot(x-Number(resume.anchorX||0),z-Number(resume.anchorZ||0))>maxHorizontalDistance ||
      Math.abs(y-Number(resume.anchorY||0))>maxVerticalDistance
    ) {
      this.send(ws,{
        type:WS_MESSAGE.HANDOFF_RESUME_ERROR,
        message:'Handoff resume movement exceeded server limit',
        retryable:true,
        serverNow:now
      });
      return;
    }

    Object.assign(p,{
      x,y,z,r,
      at:now,
      last:now,
      handoffPending:null,
      handoffResume:null
    });
    ws.serializeAttachment(p);

    this.broadcastNearby({
      type:WS_MESSAGE.MOVE,
      player:this.publicPlayer(p)
    },p,ws);
    this.ctx.waitUntil(this.flushBorderSnapshot(true));

    this.send(ws,{
      type:WS_MESSAGE.HANDOFF_RESUMED,
      x,y,z,r,
      zone:p.zoneId,
      serverNow:now
    });
  }

  async handleMove(ws,p,m) {
    const now=Date.now();
    if (now-p.last<MOVE_TICK_MS) return;

    const {x,y,z,r}=m;
    if (![x,y,z,r].every(Number.isFinite)) return;
    if (Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 || Math.abs(r)>10000) return;

    const dt=Math.min(1.5,Math.max(0,(now-p.at)/1000));
    const speedActive=Number(p.speedExpires||0)>now;
    const maxHorizontalSpeed=speedActive ? 50 : 26;

    if (
      Math.hypot(x-p.x,z-p.z)>maxHorizontalSpeed*dt+.65 ||
      Math.abs(y-p.y)>9*dt+.5
    ) return;

    const requestedZone=zoneFromPosition(x,z);
    if (!requestedZone) return;

    if (requestedZone!==p.zoneId) {
      if (!zonesAreAdjacent(p.zoneId,requestedZone)) return;

      const pending=p.handoffPending;
      if (pending?.zone===requestedZone && pending?.token && Number(pending.expiresAt||0)>now) {
        this.send(ws,{
          type:WS_MESSAGE.ZONE_CHANGE,
          from:p.zoneId,
          zone:requestedZone,
          handoffToken:pending.token,
          expiresAt:pending.expiresAt,
          position:pending.position
        });
        return;
      }
      if (pending?.creating && pending?.zone===requestedZone) return;

      p.handoffPending={
        creating:true,
        zone:requestedZone,
        position:{x,y,z,r},
        expiresAt:now+2000
      };
      p.last=now;
      ws.serializeAttachment(p);

      try {
        const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
          new Request('https://internal/_internal/create-zone-handoff',{
            method:'POST',
            headers:{'content-type':'application/json'},
            body:JSON.stringify({
              uid:p.uid,
              playerId:p.id,
              fromZone:p.zoneId,
              toZone:requestedZone,
              x,y,z,r
            })
          })
        );
        const result=await response.json();
        if (!response.ok || !result?.ok) throw Error('handoff create failed');

        p=this.player(ws);
        if (!p?.uid) return;
        p.handoffPending={
          creating:false,
          zone:requestedZone,
          token:String(result.token),
          expiresAt:Number(result.expiresAt)||0,
          position:{x,y,z,r}
        };
        ws.serializeAttachment(p);

        this.send(ws,{
          type:WS_MESSAGE.ZONE_CHANGE,
          from:p.zoneId,
          zone:requestedZone,
          handoffToken:p.handoffPending.token,
          expiresAt:p.handoffPending.expiresAt,
          position:p.handoffPending.position
        });
      } catch (_) {
        p=this.player(ws);
        if (p?.uid) {
          p.handoffPending=null;
          ws.serializeAttachment(p);
        }
        this.send(ws,{type:WS_MESSAGE.HANDOFF_ERROR,message:'Could not prepare zone handoff'});
      }
      return;
    }

    Object.assign(p,{x,y,z,r,at:now,last:now,handoffPending:null,handoffResume:null});
    ws.serializeAttachment(p);

    this.broadcastNearby({
      type:WS_MESSAGE.MOVE,
      player:this.publicPlayer(p)
    },p,ws);

    this.ctx.waitUntil(this.flushBorderSnapshot(false));
  }

  async handleCollect(ws,p,m) {
    const now=Date.now();
    const id=Number(m?.id);
    if (!Number.isInteger(id) || id<0 || id>=COINS.length || now-Number(p.lastCollect||0)<150) return;

    // A collect can happen between 5Hz movement packets. Accept a fresh client
    // contact position only when it passes the same server movement limits.
    const cx=Number(m?.x), cy=Number(m?.y), cz=Number(m?.z), cr=Number(m?.r);
    if ([cx,cy,cz,cr].every(Number.isFinite) && zoneFromPosition(cx,cz)===p.zoneId) {
      const dt=Math.min(1.5,Math.max(0,(now-Number(p.at||now))/1000));
      const speedActive=Number(p.speedExpires||0)>now;
      const maxHorizontalSpeed=speedActive ? 50 : 26;
      if (
        Math.hypot(cx-Number(p.x||0),cz-Number(p.z||0))<=maxHorizontalSpeed*dt+1.25 &&
        Math.abs(cy-Number(p.y||0))<=9*dt+.75 &&
        Math.abs(cx)<=748 && Math.abs(cz)<=748 && cy>=-.25 && cy<=8 && Math.abs(cr)<=10000
      ) {
        Object.assign(p,{x:cx,y:cy,z:cz,r:cr,at:now});
      }
    }

    p.lastCollect=now;
    ws.serializeAttachment(p);

    try {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-collect',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid,id,x:p.x,y:p.y,z:p.z})
        })
      );
      const result=await response.json();

      if (!response.ok || !result?.ok) {
        if (response.status>=500) this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'Score storage unavailable'});
        return;
      }

      if (!result.collected) {
        this.send(ws,{
          type:WS_MESSAGE.COIN_COLLECT_RESULT,
          id,
          collected:false,
          activeAfter:Number(result.activeAfter)||0,
          serverNow:Number(result.serverNow)||now
        });
        return;
      }

      this.send(ws,{
        type:WS_MESSAGE.COIN_COLLECT_RESULT,
        id,
        collected:true,
        event:result.event||null,
        score:Number(result.score)||0,
        reward:Number(result.reward)||0,
        serverNow:Number(result.serverNow)||now
      });
      // Local Zone gets the board immediately; GameRoom also fans it out globally.
      if (Array.isArray(result.leaderboard)) {
        this.broadcastAll({type:WS_MESSAGE.LEADERBOARD,top:result.leaderboard});
      }
    } catch (_) {
      this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'World action unavailable'});
    }
  }

  async handleCollectBox(ws,p) {
    try {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-collect-box',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid,x:p.x,y:p.y,z:p.z})
        })
      );
      const result=await response.json();
      if (!response.ok || !result?.ok) return;

      if (result.claimed) {
        this.send(ws,{
          type:WS_MESSAGE.BOX_SPIN_READY,
          box:result.box,
          serverNow:Number(result.serverNow)||Date.now()
        });
      } else if (result.box) {
        this.send(ws,{
          type:WS_MESSAGE.BOX_STATE,
          box:result.box,
          serverNow:Number(result.serverNow)||Date.now()
        });
      }
    } catch (_) {
      this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'Lucky Box unavailable'});
    }
  }

  async handleSpinBox(ws,p) {
    try {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-spin-box',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid})
        })
      );
      const result=await response.json();

      if (!response.ok || !result?.ok) {
        this.send(ws,{type:WS_MESSAGE.BOX_ERROR,message:result?.error||'Lucky Box spin failed'});
        return;
      }

      this.send(ws,{
        type:WS_MESSAGE.BOX_REWARD,
        reward:Number(result.reward)||0,
        score:Number(result.score)||0,
        serverNow:Number(result.serverNow)||Date.now()
      });
      if (Array.isArray(result.leaderboard)) {
        this.broadcastAll({type:WS_MESSAGE.LEADERBOARD,top:result.leaderboard});
      }
    } catch (_) {
      this.send(ws,{type:WS_MESSAGE.BOX_ERROR,message:'Lucky Box storage unavailable'});
    }
  }

  async webSocketClose(ws) {
    const p=this.player(ws);
    if (p?.uid) {
      this.broadcastNearby({
        type:WS_MESSAGE.LEAVE,
        id:p.id,
        count:Math.max(0,this.count()-1)
      },p,ws);
      this.ctx.waitUntil(this.flushBorderSnapshot(true,ws));
    }
    try { ws.close(1000,'Bye'); } catch (_) {}
  }

  async webSocketError(ws) {
    const p=this.player(ws);
    if (p?.uid) {
      this.broadcastNearby({
        type:WS_MESSAGE.LEAVE,
        id:p.id,
        count:Math.max(0,this.count()-1)
      },p,ws);
      this.ctx.waitUntil(this.flushBorderSnapshot(true,ws));
    }
    try { ws.close(1011,'Connection error'); } catch (_) {}
  }
}
