import { PLAYER_VISIBILITY_RADIUS, BORDER_SNAPSHOT_INTERVAL_MS, ZONE_SOFT_CAP, MOVE_TICK_MS } from '../shared/config.mjs';
import { MOVEMENT } from '../shared/movement.mjs';
import { WS_MESSAGE, PROTOCOL_VERSION } from '../shared/protocol.mjs';
import { normalizePlayerName, normalizeZoneId, adjacentZoneIds, zonesAreAdjacent, zoneCenter, zoneFromPosition } from './spatial.mjs';
import { COINS } from './world.mjs';
import { verifyFirebaseIdToken } from './firebase-auth.mjs';
import { SECURITY, scheduleAuthDeadline, clearAuthDeadline } from './security.mjs';
import { enqueueFrame, enqueueSocketBarrier, sessionMetadata, checkpointPlayer } from './room-security.mjs';
import { initializeMotion, applyMovementIntent, publicMovement } from './movement.mjs';
import { ZoneVisibility } from './zone-visibility.mjs';
import { handoffMotion, handoffPosition } from './handoff-continuity.mjs';

// Phase 2A movement-zone Durable Object.
// World state, scores, payments, coins and Lucky Box remain authoritative in GameRoom.
export class ZoneRoom {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.projectId=env.FIREBASE_PROJECT_ID;
    this.lastBorderFlushAt=0;
    this.visibility=new ZoneVisibility(this);
    for (const ws of this.sockets()) scheduleAuthDeadline(this,ws);
  }

  player(ws) { return ws.deserializeAttachment(); }
  sockets() { return this.ctx.getWebSockets(); }
  async alarm() {
    const now=Date.now();
    let next=0;
    for (const ws of this.sockets()) {
      const player=this.player(ws);
      if (player?.uid || !Number.isFinite(Number(player?.acceptedAt))) continue;
      const due=Number(player.acceptedAt)+SECURITY.authDeadlineMs;
      if (now>=due) {
        clearAuthDeadline(ws);
        try { ws.close(1008,'Authentication deadline exceeded'); } catch (_) {}
      } else if (!next || due<next) next=due;
    }
    if (next) await this.ctx.storage.setAlarm(next);
  }
  activePlayer(p) { return Boolean(p?.uid && !p.revoked && !p.sessionClosed && !p.handoffResume &&
    !p.handoffPending?.sealed &&
    Number(p.exp)>Math.floor(Date.now()/1000) && Number(p.resumeExpiresAt)>Date.now()); }
  count() { return this.sockets().filter(ws=>this.activePlayer(this.player(ws))).length; }
  sessionOwner() { return 'zone:'+this.currentZoneId(); }
  async sessionCall(action,payload) {
    const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
      new Request(`https://internal/_internal/session/${action}`,{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify(payload)
      })
    );
    const result=await response.json();
    if (response.status>=500 || !result || typeof result!=='object') throw Error('Session authority unavailable');
    return result;
  }
  authenticationExpired(ws,p) {
    return ws.readyState!==1 || !p || p.revoked || p.sessionClosed ||
      (p.uid && Number(p.exp)<=Math.floor(Date.now()/1000)) ||
      (!p.uid && Date.now()>=Number(p.acceptedAt||0)+SECURITY.authDeadlineMs);
  }
  send(ws,value) { try { ws.send(JSON.stringify(value)); } catch (_) {} }
  broadcastAll(value,except) {
    const data=JSON.stringify(value);
    for(const ws of this.sockets()) {
      if(ws===except || !this.activePlayer(this.player(ws))) continue;
      try { ws.send(data); } catch (_) {}
    }
  }

  nearbySockets(sourcePlayer, except) {
    if (!sourcePlayer?.uid || sourcePlayer.revoked) return [];
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
    if (value.type===WS_MESSAGE.LEAVE) { this.visibility.leave(sourcePlayer,except); return; }
    if (except && [WS_MESSAGE.JOIN,WS_MESSAGE.MOVE].includes(value.type)) {
      this.visibility.local(except,sourcePlayer,value.type===WS_MESSAGE.MOVE);
      return;
    }
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
      .filter(ws=>ws!==exceptWs && this.activePlayer(this.player(ws)))
      .map(ws=>this.publicPlayer(this.player(ws)))
      .filter(Boolean);
  }

  async flushBorderSnapshot(force=false, exceptWs=null) {
    return this.visibility.flush(force,exceptWs);
  }

  async sendInitialGhostSnapshots(ws,p) {
    return this.visibility.initial(ws,p);
  }

  continuityState(p) {
    return {continuousHandoff:true,position:handoffPosition(p),motion:handoffMotion(p.motion),
      movement:publicMovement(p),ack:p.motion.seq,lastSequence:Math.max(p.motion.seq,
        Number.isSafeInteger(p.lastSequence) ? p.lastSequence : -1),
      checkpointRevision:Number(p.checkpointRevision)||0,zone:p.zoneId,serverNow:Date.now()};
  }

  async cancelContinuousTicket(ws,p) {
    const pending=p.handoffPending;
    if (!pending?.continuousHandoff || !pending.token) return false;
    const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
      new Request('https://internal/_internal/cancel-zone-handoff',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner(),token:pending.token})
      }));
    const result=await response.json();
    p=this.player(ws);
    if (!response.ok || !result?.ok || !p || p.revoked || ws.readyState!==1 ||
        p.handoffPending?.token!==pending.token) return false;
    p.handoffPending=null;
    p.continuousCancelled=true;
    p.motion.credit=0;
    // Cancellation does not integrate input. Retain the last simulation clock
    // so valid in-flight frames can spend newly elapsed server time once.
    ws.serializeAttachment(p);
    return true;
  }

  async handoffBarrier(request,unseal=false) {
    if (this.env.APP_ENV!=='staging') return Response.json({ok:false},{status:404});
    let body;
    try { body=await request.json(); }
    catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
    const ws=this.sockets().find(socket=>{
      const p=this.player(socket);
      return p?.uid===body?.uid && p.sessionId===body?.sessionId &&
        p.handoffPending?.token===body?.token;
    });
    if (!ws) return Response.json({ok:false,error:'Handoff source unavailable'},{status:409});
    return enqueueSocketBarrier(ws,async()=>{
      try {
        let p=this.player(ws);
        const pending=p?.handoffPending;
        if (!pending?.continuousHandoff || pending.token!==body.token ||
            pending.zone!==body.toZone || p.uid!==body.uid || p.sessionId!==body.sessionId ||
            p.revoked || p.sessionClosed || ws.readyState!==1 ||
            Number(p.exp)<=Math.floor(Date.now()/1000) || Number(pending.expiresAt)<=Date.now())
          return Response.json({ok:false,error:'Handoff source unavailable'},{status:409});
        const owned=await this.sessionCall('validate',{
          uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()});
        p=this.player(ws);
        if (!owned?.ok || !p || p.revoked || p.sessionClosed || ws.readyState!==1 ||
            p.handoffPending?.token!==body.token)
          return Response.json({ok:false,error:'Source session not owned'},{status:409});
        if (unseal) {
          p.handoffPending.sealed=false;
          ws.serializeAttachment(p);
          this.broadcastNearby({type:WS_MESSAGE.JOIN,player:this.publicPlayer(p),count:this.count()},p,ws);
          this.ctx.waitUntil(this.flushBorderSnapshot(true));
          return Response.json({ok:true,...this.continuityState(p)});
        }
        const currentZone=zoneFromPosition(p.x,p.z);
        if (currentZone!==body.toZone) {
          const cancelled=await this.cancelContinuousTicket(ws,p);
          if (!cancelled) return Response.json({ok:false,error:'Handoff route cancellation unavailable'},{status:409});
          p=this.player(ws);
          return Response.json({ok:false,...this.continuityState(p),
            cancelledToSource:currentZone===p.zoneId,
            ...(currentZone!==p.zoneId ? {retargetZone:currentZone} : {}),
            error:'Authoritative handoff route changed'},{status:409});
        }
        const state=this.continuityState(p);
        p.handoffPending.sealed=true;
        ws.serializeAttachment(p);
        this.visibility.leave(p,ws);
        this.ctx.waitUntil(this.flushBorderSnapshot(true,ws));
        return Response.json({ok:true,...state,uid:p.uid,sessionId:p.sessionId,
          fromZone:p.zoneId,toZone:body.toZone,token:body.token});
      } catch (_) {
        return Response.json({ok:false,error:'Handoff source unavailable'},{status:503});
      }
    });
  }

  async fetch(request) {
    const url=new URL(request.url);

    if (url.pathname==='/_internal/staging-handoff-seal' && request.method==='POST')
      return this.handoffBarrier(request);
    if (url.pathname==='/_internal/staging-handoff-unseal' && request.method==='POST')
      return this.handoffBarrier(request,true);

    if (url.pathname==='/_internal/session-revoke' && request.method==='POST') {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false},{status:400}); }
      if (typeof body?.uid!=='string' || typeof body?.sessionId!=='string')
        return Response.json({ok:false},{status:400});
      for (const ws of this.sockets()) {
        const p=this.player(ws);
        if ((p?.uid||p?.pendingUid)!==body.uid || (p.sessionId||p.pendingSessionId)!==body.sessionId) continue;
        if (body.handoffToken!==undefined && (this.env.APP_ENV!=='staging' ||
            !p.handoffPending?.sealed || p.handoffPending.token!==body.handoffToken)) continue;
        if (this.activePlayer(p)) this.broadcastNearby({
          type:WS_MESSAGE.LEAVE,id:p.id,count:Math.max(0,this.count()-1)
        },p,ws);
        p.revoked=true;
        ws.serializeAttachment(p);
        clearAuthDeadline(ws);
        ws.close(1008,'Session ownership transferred');
        this.ctx.waitUntil(this.flushBorderSnapshot(true,ws));
      }
      return Response.json({ok:true});
    }

    if (url.pathname==='/_internal/border-state' && request.method==='GET') {
      const destination=url.searchParams.has('destination') ? normalizeZoneId(url.searchParams.get('destination')) : null;
      if (url.searchParams.has('destination') && (!destination || !zonesAreAdjacent(this.currentZoneId(),destination)))
        return Response.json({ok:false,error:'Invalid destination zone'},{status:400});
      return Response.json({ok:true,zone:this.currentZoneId(),...this.visibility.snapshot(destination)});
    }

    if (url.pathname==='/_internal/border-snapshot' && request.method==='POST') {
      let body;
      try { body=await request.json(); }
      catch (_) { return new Response('Bad JSON',{status:400}); }
      const snapshot=this.visibility.normalizeSnapshot(body);
      if (snapshot.error) return new Response('Invalid border snapshot',{status:snapshot.error});
      this.visibility.receive(snapshot);
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

    // Expired transports already receive no projections or world fan-out.
    // Reclaim them when the raw transport bound would obstruct a fresh join;
    // otherwise their next packet retains the established explicit rejection.
    if (this.sockets().length>=ZONE_SOFT_CAP) {
      for (const ws of this.sockets()) {
        const p=this.player(ws);
        if (p?.uid && (Number(p.exp)<=Math.floor(Date.now()/1000) ||
            (p.handoffResume ? Date.now()>=Number(p.handoffResume.deadline||0) : !this.activePlayer(p))))
          await this.endSession(ws,1008,'Session expired');
      }
    }
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
    scheduleAuthDeadline(this,server);
    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws,message) {
    return enqueueFrame(this,ws,message,PROTOCOL_VERSION.ZONE_ROOM,
      (m,p)=>this.dispatchMessage(ws,p,m));
  }

  async dispatchMessage(ws,p,m) {
    if (m?.type===WS_MESSAGE.AUTH) return this.handleAuth(ws,p,m);
    if (m?.type===WS_MESSAGE.HANDOFF_RESUME) return this.handleHandoffResume(ws,p,m);
    if (m?.type===WS_MESSAGE.HANDOFF_CANCEL) {
      if (p.handoffResume) {
        // A provisional target cannot become an active owner by cancellation.
        p.revoked=true;
        ws.serializeAttachment(p);
        ws.close(1008,'Handoff cancelled');
        return;
      }
      const pending=p.handoffPending;
      if (pending?.token) {
        try {
          const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
            new Request('https://internal/_internal/cancel-zone-handoff',{
              method:'POST',headers:{'content-type':'application/json'},
              body:JSON.stringify({uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner(),token:pending.token})
            })
          );
          const result=await response.json();
          p=this.player(ws);
          if (!response.ok || !result?.ok || ws.readyState!==1 || p?.revoked) {
            ws.close(1008,'Handoff cancellation rejected');
            return;
          }
          if (pending.continuousHandoff) {
            p.continuousCancelled=true;
            p.motion.credit=0;
            // Preserve the last integrated clock; cancellation cannot consume
            // the elapsed interval backing still-unacknowledged frames.
            if (p.handoffPending.sealed) {
              p.handoffPending.sealed=false;
              ws.serializeAttachment(p);
              this.broadcastNearby({type:WS_MESSAGE.JOIN,player:this.publicPlayer(p),count:this.count()},p,ws);
              this.ctx.waitUntil(this.flushBorderSnapshot(true));
            }
          } else {
            const source=p.handoffPending?.source;
            if (!source || zoneFromPosition(source.x,source.z)!==p.zoneId) {
              ws.close(1011,'Handoff source unavailable');
              return;
            }
            Object.assign(p,{x:source.x,y:source.y,z:source.z,r:source.r,
              // Position rollback cannot refund time already spent crossing.
              motion:{...source.motion,clock:Date.now(),credit:0},at:Date.now(),last:Date.now()});
          }
          const checkpoint=await checkpointPlayer(this,ws,p);
          if (!checkpoint?.ok || ws.readyState!==1) {
            ws.close(1008,'Handoff cancellation ownership rejected');
            return;
          }
        } catch (_) {
          ws.close(1011,'Handoff cancellation authority unavailable');
          return;
        }
      }
      p.handoffPending=null;
      p.handoffResume=null;
      ws.serializeAttachment(p);
      this.send(ws,{type:WS_MESSAGE.HANDOFF_CANCELLED,zone:p.zoneId,serverNow:Date.now(),
        position:{x:p.x,y:p.y,z:p.z,r:p.r},movement:publicMovement(p),
        ...(pending?.continuousHandoff || p.continuousCancelled ? {continuousHandoff:true,ack:p.motion.seq} : {}),
        nextSequence:Math.max(Number.isSafeInteger(p.lastSequence) ? p.lastSequence : -1,
          Number.isSafeInteger(p.motion?.seq) ? p.motion.seq : -1)+1});
      return;
    }
    if (m?.type===WS_MESSAGE.MOVE) return this.handleMove(ws,p,m);
    if (m?.type===WS_MESSAGE.COLLECT) return this.handleCollect(ws,p,m);
    if (m?.type===WS_MESSAGE.COLLECT_BOX) return this.handleCollectBox(ws,p,m);
    if (m?.type===WS_MESSAGE.SPIN_BOX) return this.handleSpinBox(ws,p,m);
  }

  async handleAuth(ws,p,m) {
    let verified;
    try { verified=await verifyFirebaseIdToken(m.token,this.projectId); }
    catch (_) {
      this.send(ws,{type:WS_MESSAGE.AUTH_ERROR,message:'Firebase sign-in failed'});
      ws.close(1008,'Invalid ID token');
      return;
    }

    p=this.player(ws);
    if (this.authenticationExpired(ws,p) || verified.exp<=Math.floor(Date.now()/1000)) {
      ws.close(1008,'Authentication deadline exceeded');
      return;
    }

    if (p.uid && p.uid!==verified.uid) {
      ws.close(1008,'Different account');
      return;
    }

    let bootstrap;
    try {
      const refresh=Boolean(p.uid);
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request(`https://internal/_internal/${refresh ? 'get-entitlements' : 'zone-bootstrap'}`,{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify(refresh ? {uid:verified.uid} :
            {uid:verified.uid,name:normalizePlayerName(m?.name,'Player')})
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
    if (this.authenticationExpired(ws,p) || verified.exp<=Math.floor(Date.now()/1000)) {
      ws.close(1008,'Authentication deadline exceeded');
      return;
    }

    if (p.uid) {
      try {
        const identity={uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()};
        const valid=await this.sessionCall('validate',identity);
        if (!valid?.ok) {
          ws.close(1008,'Session no longer owned');
          return;
        }
        const refreshed=await this.sessionCall('checkpoint',{...identity,exp:verified.exp});
        p=this.player(ws);
        if (!refreshed?.ok || this.authenticationExpired(ws,p) || p?.sessionId!==identity.sessionId ||
            verified.exp<=Math.floor(Date.now()/1000)) {
          ws.close(1008,'Session no longer owned');
          return;
        }
        p.exp=verified.exp;
        p.speedExpires=Number(bootstrap.entitlements?.speedExpires)||0;
        p.resumeExpiresAt=Number(refreshed.resumeExpiresAt)||p.resumeExpiresAt;
        ws.serializeAttachment(p);
        clearAuthDeadline(ws);
        this.send(ws,{type:WS_MESSAGE.AUTH_REFRESHED,session:sessionMetadata(p),
          entitlements:bootstrap.entitlements||{},serverNow:Date.now()});
      } catch (_) {
        ws.close(1011,'Session authority unavailable');
      }
      return;
    }

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
              toZone:zoneId,
              continuousHandoff:this.env.APP_ENV==='staging' && m.continuousHandoff===true
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

    p=this.player(ws);
    if (this.authenticationExpired(ws,p) || verified.exp<=Math.floor(Date.now()/1000)) {
      ws.close(1008,'Authentication deadline exceeded');
      return;
    }
    const now=Date.now();
    const n=this.count();
    const col=n%10;
    const row=Math.floor(n/10)%10;
    const spawnX=handoff ? Number(handoff.x) : center.x+(col-4.5)*4;
    const spawnY=handoff ? Number(handoff.y) : 0;
    const spawnZ=handoff ? Number(handoff.z) : center.z+(row-4.5)*4;
    const spawnR=handoff ? Number(handoff.r) : 0;
    let id=handoff ? String(handoff.playerId) : crypto.randomUUID();
    let session=null;
    if (!handoff) {
      try {
        session=await this.sessionCall('acquire',{
          uid:verified.uid,
          exp:verified.exp,
          owner:this.sessionOwner(),
          playerId:id,
          position:{x:spawnX,y:spawnY,z:spawnZ,r:spawnR},
          ...(m.resumeToken ? {resumeToken:m.resumeToken} : {})
        });
        if (!session?.ok) {
          this.send(ws,{type:WS_MESSAGE.AUTH_ERROR,message:'Invalid or expired session resume',resumeZone:session?.resumeZone});
          ws.close(1008,'Session acquisition rejected');
          return;
        }
      } catch (_) {
        this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'Session authority unavailable'});
        ws.close(1011,'Session authority unavailable');
        return;
      }
      p=this.player(ws);
      if (!this.authenticationExpired(ws,p)) {
        p.pendingUid=verified.uid;
        p.pendingSessionId=session.sessionId;
        ws.serializeAttachment(p);
        try {
          const valid=await this.sessionCall('validate',{
            uid:verified.uid,sessionId:session.sessionId,owner:this.sessionOwner()
          });
          p=this.player(ws);
          if (!valid?.ok) {
            ws.close(1008,'Session no longer owned');
            return;
          }
        } catch (_) {
          ws.close(1011,'Session authority unavailable');
          return;
        }
      }
      if (this.authenticationExpired(ws,p) || verified.exp<=Math.floor(Date.now()/1000)) {
        try { await this.sessionCall('release',{uid:verified.uid,sessionId:session.sessionId,owner:this.sessionOwner()}); }
        catch (_) { /* A closed socket cannot act on a retained server lease. */ }
        ws.close(1008,'Authentication deadline exceeded');
        return;
      }
      id=String(session.playerId);
    } else if (typeof handoff.sessionId!=='string' || !handoff.sessionId) {
      ws.close(1008,'Invalid handoff session');
      return;
    }
    const position=session?.position||{x:spawnX,y:spawnY,z:spawnZ,r:spawnR};
    delete p.pendingUid;
    delete p.pendingSessionId;

    Object.assign(p,{
      uid:verified.uid,
      exp:verified.exp,
      id,
      zoneId,
      x:position.x,
      y:position.y,
      z:position.z,
      r:position.r,
      sessionId:session?.sessionId||handoff.sessionId,
      resumeToken:session?.resumeToken||null,
      resumeExpiresAt:Number(session?.resumeExpiresAt)||0,
      checkpointRevision:Number(session?.checkpointRevision)||0,
      revoked:false,
      at:now,
      last:0,
      lastCollect:0,
      handoffPending:null,
      continuousHandoff:this.env.APP_ENV==='staging' && m.continuousHandoff===true,
      handoffResume: handoff ? {
        token:handoffToken,
        continuousHandoff:handoff.continuousHandoff===true,
        anchorX:spawnX,
        anchorY:spawnY,
        anchorZ:spawnZ,
        fromZone:handoff.fromZone,
        createdAt:Number(handoff.createdAt)||now,
        deadline:Math.min(now+9000,Number(handoff.expiresAt)||now+9000)
      } : null,
      nickname:normalizePlayerName(bootstrap.nickname,m?.name || ('Player-'+verified.uid.slice(-6))),
      speedExpires:Number(bootstrap.entitlements?.speedExpires)||0
    });
    initializeMotion(p,now);

    ws.serializeAttachment(p);
    clearAuthDeadline(ws);

    p.localVisible=this.nearbySockets(p,ws).map(other=>this.player(other).id);
    ws.serializeAttachment(p);

    this.send(ws,{
      type:WS_MESSAGE.WELCOME,
      protocol:PROTOCOL_VERSION.ZONE_ROOM,
      phase:'2B1',
      handoff:Boolean(handoff),
      ...(p.continuousHandoff ? {continuousHandoff:true} : {}),
      fromZone:handoff?.fromZone||null,
      zone:zoneId,
      id,
      session:sessionMetadata(p),
      movement:publicMovement(p),
      entitlements:bootstrap.entitlements||{},
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

    if (!handoff) {
      this.broadcastNearby({
        type:WS_MESSAGE.JOIN,
        player:this.publicPlayer(p),
        count:this.count()
      },p,ws);
      this.ctx.waitUntil(this.sendInitialGhostSnapshots(ws,p));
      this.ctx.waitUntil(this.flushBorderSnapshot(true));
    }
  }

  async handleHandoffResume(ws,p,m) {
    const now=Date.now();
    const resume=p?.handoffResume;
    if (!resume || now>=Number(resume.deadline||0)) {
      if (p?.uid) {
        p.revoked=true;
        ws.serializeAttachment(p);
      }
      this.send(ws,{type:WS_MESSAGE.HANDOFF_RESUME_ERROR,message:'Handoff resume window expired'});
      ws.close(1008,'Handoff resume window expired');
      return;
    }

    if (resume.continuousHandoff) return this.handleContinuousResume(ws,p,m);

    // The signed, one-use server ticket fixes the transfer position. Legacy
    // coordinate fields are compatibility hints, never simulation authority.
    const x=Number(resume.anchorX), y=Number(resume.anchorY), z=Number(resume.anchorZ), r=Number(p.r);
    if (![x,y,z,r].every(Number.isFinite) || zoneFromPosition(x,z)!==p.zoneId ||
        (Object.hasOwn(m,'x') && (Math.hypot(m.x-x,m.z-z)>.25 || Math.abs(m.y-y)>.25))) {
      this.send(ws,{type:WS_MESSAGE.HANDOFF_RESUME_ERROR,message:'Invalid handoff resume position'});
      return;
    }

    let transferred;
    let worldState;
    try {
      transferred=await this.sessionCall('transfer',{
        uid:p.uid,
        sessionId:p.sessionId,
        fromOwner:'zone:'+resume.fromZone,
        toOwner:this.sessionOwner(),
        handoffToken:resume.token,
        playerId:p.id,
        position:{x,y,z,r}
      });
      p=this.player(ws);
      if (!transferred?.ok || ws.readyState!==1 || !p?.handoffResume ||
          Number(p?.exp)<=Math.floor(Date.now()/1000) ||
          Date.now()>=Number(p.handoffResume.deadline||0)) {
        if (transferred?.ok) await this.sessionCall('release',{
          uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()
        });
        ws.close(1008,'Handoff ownership rejected');
        return;
      }
      const checkpoint=await this.sessionCall('checkpoint',{
        uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner(),
        position:{x,y,z,r},exp:p.exp,revision:Number(transferred.checkpointRevision)+1
      });
      p=this.player(ws);
      if (!checkpoint?.ok || ws.readyState!==1 || p?.revoked || !p?.handoffResume ||
          Number(p?.exp)<=Math.floor(Date.now()/1000) ||
          Date.now()>=Number(p.handoffResume.deadline||0)) {
        await this.sessionCall('release',{uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()});
        ws.close(1008,'Handoff ownership rejected');
        return;
      }
      transferred.resumeExpiresAt=checkpoint.resumeExpiresAt;
      transferred.checkpointRevision=checkpoint.checkpointRevision;
      // Provisional sockets deliberately receive no world broadcasts. Read
      // current shared resources after ownership commits before acknowledging
      // the target, so changes during bootstrap cannot survive the transfer.
      worldState=await this.refreshWorldState(p);
      const stillOwned=await this.sessionCall('validate',{
        uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()
      });
      p=this.player(ws);
      if (!stillOwned?.ok || ws.readyState!==1 || p?.revoked || !p?.handoffResume ||
          Number(p?.exp)<=Math.floor(Date.now()/1000) ||
          Date.now()>=Number(p.handoffResume.deadline||0)) {
        await this.sessionCall('release',{uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()});
        ws.close(1008,'Handoff ownership rejected');
        return;
      }
    } catch (_) {
      if (transferred?.ok) {
        try { await this.sessionCall('release',{uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()}); }
        catch (_) { /* A failed CAS cannot release a successor generation. */ }
        try { await this.sessionCall('revoke',{uid:p.uid,sessionId:p.sessionId,owner:'zone:'+resume.fromZone}); }
        catch (_) { /* The durable owner already prevents source actions. */ }
      }
      this.send(ws,{type:WS_MESSAGE.HANDOFF_RESUME_ERROR,message:'Handoff authority unavailable'});
      ws.close(1011,'Handoff authority unavailable');
      return;
    }

    Object.assign(p,{
      x,y,z,r,
      at:Date.now(),
      last:Date.now(),
      resumeToken:transferred.resumeToken,
      resumeExpiresAt:transferred.resumeExpiresAt,
      checkpointRevision:transferred.checkpointRevision,
      handoffPending:null,
      handoffResume:null
    });
    initializeMotion(p,Date.now());
    if (Number.isSafeInteger(m.seq)) p.motion.seq=m.seq;
    ws.serializeAttachment(p);

    this.send(ws,{type:WS_MESSAGE.COIN_STATE,coins:worldState.coins,serverNow:worldState.serverNow});
    this.send(ws,{type:WS_MESSAGE.BOX_STATE,box:worldState.luckyBox,serverNow:worldState.serverNow});
    this.send(ws,{type:WS_MESSAGE.SCORE,score:worldState.score,serverNow:worldState.serverNow});
    this.send(ws,{type:WS_MESSAGE.LEADERBOARD,top:worldState.leaderboard,serverNow:worldState.serverNow});

    this.send(ws,{
      type:WS_MESSAGE.HANDOFF_RESUMED,
      x,y,z,r,
      zone:p.zoneId,
      session:sessionMetadata(p),
      movement:publicMovement(p),
      ack:Number.isSafeInteger(m.seq) ? m.seq : null,
      serverNow:now
    });

    // Ownership commits before ACK. Only after the target ACK is sent may the
    // source socket be closed; its matching generation cannot release us.
    try {
      const revoked=await this.sessionCall('revoke',{
        uid:p.uid,sessionId:p.sessionId,owner:'zone:'+resume.fromZone
      });
      if (!revoked?.ok) throw Error('Source revocation unavailable');
    } catch (_) {
      // Durable ownership already belongs to this target. Stop gameplay if
      // revocation cannot be confirmed; stale source packets also fail CAS.
      p=this.player(ws);
      p.revoked=true;
      ws.serializeAttachment(p);
      ws.close(1011,'Source revocation unavailable');
      return;
    }
    p=this.player(ws);
    if (ws.readyState!==1 || !this.activePlayer(p)) return;
    this.broadcastNearby({
      type:WS_MESSAGE.JOIN,
      player:this.publicPlayer(p),
      count:this.count()
    },p,ws);
    this.broadcastNearby({type:WS_MESSAGE.MOVE,player:this.publicPlayer(p)},p,ws);
    this.ctx.waitUntil(this.sendInitialGhostSnapshots(ws,p));
    this.ctx.waitUntil(this.flushBorderSnapshot(true));
  }

  async handleContinuousResume(ws,p,m) {
    const resume=p.handoffResume;
    const source=this.env.ZONE.getByName(`free-zone-${resume.fromZone}`);
    const identity={uid:p.uid,sessionId:p.sessionId,token:resume.token,toZone:p.zoneId};
    let sealed=false, transferred;
    try {
      const response=await source.fetch(new Request('https://zone.internal/_internal/staging-handoff-seal',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(identity)}));
      const snapshot=await response.json();
      p=this.player(ws);
      if (!response.ok || !snapshot?.ok) {
        this.send(ws,{type:WS_MESSAGE.HANDOFF_RESUME_ERROR,message:snapshot?.error||'Handoff source unavailable',
          ...(snapshot?.continuousHandoff ? {continuousHandoff:true,position:snapshot.position,
            movement:snapshot.movement,ack:snapshot.ack,zone:snapshot.zone,
            cancelledToSource:snapshot.cancelledToSource,retargetZone:snapshot.retargetZone} : {})});
        ws.close(1008,'Handoff source unavailable');
        return;
      }
      sealed=true;
      if (snapshot.uid!==identity.uid || snapshot.sessionId!==identity.sessionId ||
          snapshot.token!==identity.token || snapshot.fromZone!==resume.fromZone ||
          snapshot.toZone!==identity.toZone || !snapshot.continuousHandoff)
        throw Error('Invalid authoritative handoff source');
      const position=handoffPosition(snapshot.position), motion=handoffMotion(snapshot.motion);
      if (zoneFromPosition(position.x,position.z)!==p.zoneId ||
          snapshot.ack!==motion.seq || !Number.isSafeInteger(snapshot.lastSequence) ||
          snapshot.lastSequence<motion.seq || snapshot.lastSequence<0 ||
          ws.readyState!==1 || p.revoked || !p.handoffResume ||
          p.handoffResume.token!==resume.token || Date.now()>=resume.deadline ||
          Number(p.exp)<=Math.floor(Date.now()/1000))
        throw Error('Handoff source no longer available');
      const committed=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/staging-handoff-commit',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid,sessionId:p.sessionId,fromOwner:'zone:'+resume.fromZone,
            toOwner:this.sessionOwner(),handoffToken:resume.token,playerId:p.id,position,exp:p.exp})}));
      transferred=await committed.json();
      p=this.player(ws);
      if (!committed.ok || !transferred?.ok) throw Error('Handoff ownership rejected');
      if (ws.readyState!==1 || !p || p.revoked || !p.handoffResume ||
          p.handoffResume.token!==resume.token || Date.now()>=resume.deadline ||
          Number(p.exp)<=Math.floor(Date.now()/1000)) throw Error('Handoff target no longer available');
      const worldState=transferred.worldState;
      if (!worldState?.ok || !Array.isArray(worldState.coins) || worldState.coins.length!==COINS.length ||
          !worldState.luckyBox || !Number.isSafeInteger(worldState.score) || !Array.isArray(worldState.leaderboard))
        throw Error('Handoff world state unavailable');
      Object.assign(p,position,{motion,lastSequence:snapshot.lastSequence,at:Date.now(),last:Date.now(),
        resumeToken:transferred.resumeToken,resumeExpiresAt:transferred.resumeExpiresAt,
        checkpointRevision:transferred.checkpointRevision,handoffPending:null,handoffResume:null});
      ws.serializeAttachment(p);
      this.send(ws,{type:WS_MESSAGE.HANDOFF_RESUMED,...position,position,zone:p.zoneId,
        continuousHandoff:true,session:sessionMetadata(p),movement:publicMovement(p),
        ack:motion.seq,serverNow:Date.now()});
      // Only the acknowledged target may project the committed shared state.
      this.send(ws,{type:WS_MESSAGE.COIN_STATE,coins:worldState.coins,serverNow:worldState.serverNow});
      this.send(ws,{type:WS_MESSAGE.BOX_STATE,box:worldState.luckyBox,serverNow:worldState.serverNow});
      this.send(ws,{type:WS_MESSAGE.SCORE,score:worldState.score,serverNow:worldState.serverNow});
      this.send(ws,{type:WS_MESSAGE.LEADERBOARD,top:worldState.leaderboard,serverNow:worldState.serverNow});
      // The source is already sealed and the coordinator durably owns its
      // exact-generation eviction. Transport closure cannot stall target input.
      this.ctx.waitUntil(this.sessionCall('revoke',{uid:p.uid,sessionId:p.sessionId,
        owner:'zone:'+resume.fromZone,handoffToken:resume.token}).catch(()=>{/* Durable retry remains scheduled. */}));
      this.broadcastNearby({type:WS_MESSAGE.JOIN,player:this.publicPlayer(p),count:this.count()},p,ws);
      this.broadcastNearby({type:WS_MESSAGE.MOVE,player:this.publicPlayer(p)},p,ws);
      this.ctx.waitUntil(this.sendInitialGhostSnapshots(ws,p));
      this.ctx.waitUntil(this.flushBorderSnapshot(true));
      return {checkpointed:true};
    } catch (_) {
      if (transferred?.ok) {
        try { await this.sessionCall('release',{uid:identity.uid,sessionId:identity.sessionId,owner:this.sessionOwner()}); }
        catch (_) { /* A failed CAS cannot release a successor generation. */ }
        this.ctx.waitUntil(this.sessionCall('revoke',{uid:identity.uid,sessionId:identity.sessionId,
          owner:'zone:'+resume.fromZone,handoffToken:resume.token}).catch(()=>{}));
      } else if (sealed) {
        // Only a still-owning source can unseal; an ambiguous committed CAS
        // must never reactivate a stale generation.
        try { await source.fetch(new Request('https://zone.internal/_internal/staging-handoff-unseal',{
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(identity)})); }
        catch (_) { /* Client cancellation and durable expiry remain fenced. */ }
      }
      this.send(ws,{type:WS_MESSAGE.HANDOFF_RESUME_ERROR,message:'Handoff authority unavailable'});
      ws.close(1011,'Handoff authority unavailable');
    }
  }

  async handleMove(ws,p,m) {
    const now=Date.now();
    const speedActive=Number(p.speedExpires||0)>now;
    // Once a ticket is issued, freeze its authoritative anchor until transfer
    // or cancellation. Source packets cannot invalidate an in-flight ticket.
    if (p.handoffPending?.token && !p.handoffPending.continuousHandoff) {
      if (Number(p.handoffPending.expiresAt)<=now) {
        this.send(ws,{type:WS_MESSAGE.HANDOFF_ERROR,message:'Zone handoff expired'});
        ws.close(1008,'Zone handoff expired');
        return;
      }
      p.motion ||= initializeMotion(p,now);
      p.motion.seq=m.seq;
      p.motion.clock=now;
      ws.serializeAttachment(p);
      this.sendMovementAck(ws,p,m.seq,now);
      this.send(ws,{type:WS_MESSAGE.ZONE_CHANGE,from:p.zoneId,zone:p.handoffPending.zone,
        handoffToken:p.handoffPending.token,expiresAt:p.handoffPending.expiresAt,
        position:p.handoffPending.position});
      return;
    }
    if (p.handoffPending?.continuousHandoff && Number(p.handoffPending.expiresAt)<=now) {
      this.send(ws,{type:WS_MESSAGE.HANDOFF_ERROR,message:'Zone handoff expired'});
      ws.close(1008,'Zone handoff expired');
      return;
    }
    if (m.frames === undefined && now-p.last<MOVE_TICK_MS) {
      this.sendMovementAck(ws,p,m.seq,now,false);
      return;
    }
    const source={x:p.x,y:p.y,z:p.z,r:p.r,motion:{...p.motion}};
    if (!applyMovementIntent(p,m,speedActive ? MOVEMENT.entitledSpeed : MOVEMENT.speed,now)) return;
    const {x,y,z,r}=p;
    const authoritativeZone=zoneFromPosition(x,z);
    if (this.env.APP_ENV==='staging' && p.continuousHandoff && authoritativeZone &&
        authoritativeZone!==p.zoneId && !zonesAreAdjacent(p.zoneId,authoritativeZone)) {
      // A delayed target must not leave a source owning an unrelated region.
      // Keep the established adjacent-zone security fence and fail closed.
      this.send(ws,{type:WS_MESSAGE.HANDOFF_ERROR,message:'Zone transition exceeded adjacent ownership'});
      await this.endSession(ws,1008,'Zone transition exceeded adjacent ownership');
      return;
    }
    this.sendMovementAck(ws,p,m.seq,now);
    // Persist authoritative movement after the latency-sensitive ACK. This
    // preserves per-frame state durability while keeping storage work off the
    // response critical path.
    ws.serializeAttachment(p);

    // Warmup keeps the original owner and ticket while valid movement continues.
    // Cutover validates the latest route in the serialized source seal.
    if (p.handoffPending?.continuousHandoff) {
      this.broadcastNearby({type:WS_MESSAGE.MOVE,player:this.publicPlayer(p)},p,ws);
      this.ctx.waitUntil(this.visibility.refresh(ws));
      this.ctx.waitUntil(this.flushBorderSnapshot(false));
      return;
    }
    const requestedZone=authoritativeZone;
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
        continuousHandoff:this.env.APP_ENV==='staging' && p.continuousHandoff===true && m.frames!==undefined,
        zone:requestedZone,
        position:{x,y,z,r},
        source,
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
              sessionId:p.sessionId,
              playerId:p.id,
              fromZone:p.zoneId,
              toZone:requestedZone,
              continuousHandoff:p.handoffPending.continuousHandoff===true,
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
          continuousHandoff:result.continuousHandoff===true,
          zone:requestedZone,
          token:String(result.token),
          expiresAt:Number(result.expiresAt)||0,
          position:{x,y,z,r},
          source
        };
        ws.serializeAttachment(p);

        this.send(ws,{
          type:WS_MESSAGE.ZONE_CHANGE,
          from:p.zoneId,
          zone:requestedZone,
          handoffToken:p.handoffPending.token,
          expiresAt:p.handoffPending.expiresAt,
          position:p.handoffPending.position,
          ...(p.handoffPending.continuousHandoff ? {continuousHandoff:true} : {})
        });
      } catch (_) {
        p=this.player(ws);
        if (p?.uid) {
          p.handoffPending=null;
          ws.serializeAttachment(p);
        }
        this.send(ws,{type:WS_MESSAGE.HANDOFF_ERROR,message:'Could not prepare zone handoff'});
        ws.close(1011,'Handoff authority unavailable');
      }
      return;
    }

    Object.assign(p,{x,y,z,r,at:now,last:now,handoffPending:null,handoffResume:null});
    ws.serializeAttachment(p);

    this.broadcastNearby({
      type:WS_MESSAGE.MOVE,
      player:this.publicPlayer(p)
    },p,ws);

    if (this.env.APP_ENV==='staging' && p.continuousHandoff) this.ctx.waitUntil(this.visibility.refresh(ws));
    else await this.visibility.refresh(ws);
    this.ctx.waitUntil(this.flushBorderSnapshot(false));
  }

  async refreshWorldState(p) {
    const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
      new Request('https://internal/_internal/zone-world-state',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()})
      }));
    const state=await response.json();
    if (!response.ok || !state?.ok || !Array.isArray(state.coins) || state.coins.length!==COINS.length ||
        !state.luckyBox || !Number.isSafeInteger(state.score) || state.score<0 || !Array.isArray(state.leaderboard))
      throw Error('World state unavailable');
    return state;
  }

  sendMovementAck(ws,p,seq,now=Date.now(),applied=true,extra={}) {
    this.send(ws,{type:WS_MESSAGE.MOVE,player:this.publicPlayer(p),ack:seq,applied,
      movement:publicMovement(p),velocity:{x:p.motion.vx,y:p.motion.vy,z:p.motion.vz},
      grounded:p.motion.grounded,serverNow:now,...extra});
  }

  async checkpointEconomy(ws,p) {
    const checkpoint=await checkpointPlayer(this,ws,p);
    const current=this.player(ws);
    return checkpoint?.ok===true && ws.readyState===1 && !current?.revoked &&
      !current?.sessionClosed && current?.sessionId===p.sessionId;
  }

  async handleCollect(ws,p,m) {
    const now=Date.now();
    const id=Number(m?.id);
    if (!Number.isInteger(id) || id<0 || id>=COINS.length) return false;
    if (now-Number(p.lastCollect||0)<150) {
      this.send(ws,{type:WS_MESSAGE.COIN_COLLECT_RESULT,id,collected:false,
        serverNow:now,requestId:m.requestId,retryAfterMs:Math.min(150,150-(now-Number(p.lastCollect||0)))});
      return false;
    }

    // Collection uses the latest server simulation state. Legacy contact
    // coordinates remain accepted by the schema but cannot move a player.
    p.lastCollect=now;
    ws.serializeAttachment(p);

    try {
      if (!await this.checkpointEconomy(ws,p)) return false;
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-collect',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner(),id,requestId:m.requestId})
        })
      );
      const result=await response.json();

      if (!response.ok || !result?.ok) {
        if (response.status>=500) this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'Score storage unavailable',requestId:m.requestId});
        else this.send(ws,{type:WS_MESSAGE.COIN_COLLECT_RESULT,id,collected:false,
          activeAfter:Number(result?.activeAfter)||0,serverNow:Date.now(),requestId:m.requestId,
          event:result?.event||null,cycle:result?.cycle,
          retryAfterMs:Math.min(150,Math.max(0,150-(Date.now()-now)))});
        return false;
      }

      if (!result.collected) {
        this.send(ws,{
          type:WS_MESSAGE.COIN_COLLECT_RESULT,
          id,
          collected:false,
          activeAfter:Number(result.activeAfter)||0,
          serverNow:Number(result.serverNow)||now,
          requestId:m.requestId,receipt:result.receipt,replayed:result.replayed,
          event:result.event||null,cycle:result.cycle
        });
        return false;
      }

      this.send(ws,{
        type:WS_MESSAGE.COIN_COLLECT_RESULT,
        id,
        collected:true,
        event:result.event||null,
        score:Number(result.score)||0,
        reward:Number(result.reward)||0,
        serverNow:Number(result.serverNow)||now,
        requestId:m.requestId,receipt:result.receipt,replayed:result.replayed
      });
      // Local Zone gets the board immediately; GameRoom also fans it out globally.
      if (Array.isArray(result.leaderboard)) {
        this.broadcastAll({type:WS_MESSAGE.LEADERBOARD,top:result.leaderboard});
      }
      return true;
    } catch (_) {
      this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'World action unavailable',requestId:m.requestId});
      return false;
    }
  }

  async handleCollectBox(ws,p,m={}) {
    try {
      if (!await this.checkpointEconomy(ws,p)) return false;
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-collect-box',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner(),requestId:m.requestId})
        })
      );
      const result=await response.json();
      if (!response.ok || !result?.ok) {
        if (response.status>=500) this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'Lucky Box storage unavailable',requestId:m.requestId});
        else if (result?.box) this.send(ws,{type:WS_MESSAGE.BOX_STATE,box:result.box,
          serverNow:Date.now(),requestId:m.requestId,claimed:false});
        return false;
      }

      if (result.claimed) {
        this.send(ws,{
          type:WS_MESSAGE.BOX_SPIN_READY,
          box:result.box,
          serverNow:Number(result.serverNow)||Date.now(),
          requestId:m.requestId,receipt:result.receipt,replayed:result.replayed
        });
      } else if (result.box) {
        this.send(ws,{
          type:WS_MESSAGE.BOX_STATE,
          box:result.box,
          serverNow:Number(result.serverNow)||Date.now(),requestId:m.requestId,claimed:false
        });
      }
      return result.claimed===true;
    } catch (_) {
      this.send(ws,{type:WS_MESSAGE.SERVER_ERROR,message:'Lucky Box unavailable',requestId:m.requestId});
      return false;
    }
  }

  async handleSpinBox(ws,p,m={}) {
    try {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-spin-box',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner(),requestId:m.requestId})
        })
      );
      const result=await response.json();

      if (!response.ok || !result?.ok) {
        this.send(ws,{type:WS_MESSAGE.BOX_ERROR,message:result?.error||'Lucky Box spin failed',requestId:m.requestId});
        return false;
      }

      this.send(ws,{
        type:WS_MESSAGE.BOX_REWARD,
        reward:Number(result.reward)||0,
        score:Number(result.score)||0,
        serverNow:Number(result.serverNow)||Date.now(),
        requestId:m.requestId,receipt:result.receipt,replayed:result.replayed
      });
      if (Array.isArray(result.leaderboard)) {
        this.broadcastAll({type:WS_MESSAGE.LEADERBOARD,top:result.leaderboard});
      }
      return true;
    } catch (_) {
      this.send(ws,{type:WS_MESSAGE.BOX_ERROR,message:'Lucky Box storage unavailable',requestId:m.requestId});
      return false;
    }
  }

  async webSocketClose(ws) {
    return this.endSession(ws,1000,'Bye');
  }

  async webSocketError(ws) {
    return this.endSession(ws,1011,'Connection error');
  }

  async endSession(ws,code,reason) {
    clearAuthDeadline(ws);
    const p=this.player(ws);
    if (p?.sessionClosed) return;
    const wasActive=this.activePlayer(p);
    if (p) {
      p.sessionClosed=true;
      ws.serializeAttachment(p);
    }
    if (wasActive) {
      this.broadcastNearby({
        type:WS_MESSAGE.LEAVE,
        id:p.id,
        count:this.count()
      },p,ws);
      this.ctx.waitUntil(this.flushBorderSnapshot(true,ws));
    }
    try { ws.close(code,reason); } catch (_) {}
    if ((p?.uid||p?.pendingUid) && (p.sessionId||p.pendingSessionId)) {
      try { await this.sessionCall('release',{uid:p.uid||p.pendingUid,sessionId:p.sessionId||p.pendingSessionId,owner:this.sessionOwner()}); }
      catch (_) { console.warn('Zone session release unavailable'); }
    }
  }
}
