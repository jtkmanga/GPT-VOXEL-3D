// VOXEL RUN v3 — one demo room, server-owned coins and session scores.
// Anonymous sessions and client-reported movement are NOT production anti-cheat.
const COINS = [
  [0,2],[3,4],[-4,5],[8,1],[-8,-2],[12,12],[-13,12],[15,-8],[-16,-9],
  [5,15],[-4,-16],[19,0],[-20,1],[11,-18],[-12,-18],[2,20],[-1,-8],[9,17]
];
const RESPAWN_MS = 60_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('VOXEL RUN v3 online', {
      headers:{'content-type':'text/plain; charset=utf-8'}
    });
    if (url.pathname !== '/play' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket endpoint: /play', {status:404});
    }
    if (env.ALLOWED_ORIGIN && request.headers.get('Origin') !== env.ALLOWED_ORIGIN) {
      return new Response('Origin not allowed', {status:403});
    }
    return env.ROOM.getByName('free-v2-demo').fetch(request);
  }
};

export class GameRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.ready = ctx.storage.get('coinRespawns').then(saved => {
      this.coinRespawns = saved && typeof saved === 'object' ? saved : {};
    });
  }

  player(ws) { return ws.deserializeAttachment(); }
  count() { return this.ctx.getWebSockets().length; }
  send(ws, value) { try { ws.send(JSON.stringify(value)); } catch (_) {} }
  broadcast(value, except) {
    const data = JSON.stringify(value);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) {
      try { ws.send(data); } catch (_) {}
    }
  }
  publicPlayer(p) { return p && {id:p.id,x:p.x,y:p.y,z:p.z,r:p.r}; }
  coinSnapshot() {
    return COINS.map(([x,z],id)=>({id,x,z,respawnAt:Number(this.coinRespawns[id])||0}));
  }

  async fetch() {
    await this.ready;
    if (this.count() >= 64) return new Response('Demo room full', {status:503});
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const n = this.count(), now = Date.now(), id = crypto.randomUUID();
    const p = {id,x:(n%5)*2-4,y:.93,z:Math.floor(n/5)*2,r:0,at:now,last:0,score:0,lastCollect:0};
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(p);
    this.send(server, {type:'welcome',protocol:3,id,spawn:{x:p.x,y:p.y,z:p.z},
      players:this.ctx.getWebSockets().filter(ws=>ws!==server)
        .map(ws=>this.publicPlayer(this.player(ws))).filter(Boolean),
      coins:this.coinSnapshot(),score:p.score,serverNow:now,count:this.count()});
    this.broadcast({type:'join',player:this.publicPlayer(p),count:this.count()},server);
    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    if (typeof message !== 'string' || message.length > 256) {
      ws.close(1009,'Invalid message'); return;
    }
    let m; try { m=JSON.parse(message); } catch (_) { return; }
    const p = this.player(ws);
    if (!p) return;
    if (m?.type === 'move') return this.handleMove(ws,p,m);
    if (m?.type === 'collect') return this.handleCollect(ws,p,m);
  }

  handleMove(ws,p,m) {
    const now=Date.now();
    if (now-p.last<70) return;
    const {x,y,z,r}=m;
    if (![x,y,z,r].every(Number.isFinite)) return;
    if (Math.abs(x)>24 || Math.abs(z)>24 || y<.85 || y>5 || Math.abs(r)>10000) return;
    const dt=Math.min(1.5,Math.max(0,(now-p.at)/1000));
    if (Math.hypot(x-p.x,z-p.z)>7.5*dt+.65 || Math.abs(y-p.y)>9*dt+.5) return;
    Object.assign(p,{x,y,z,r,at:now,last:now});
    ws.serializeAttachment(p);
    this.broadcast({type:'move',player:this.publicPlayer(p)},ws);
  }

  async handleCollect(ws,p,m) {
    const now=Date.now(), id=m.id;
    if (!Number.isInteger(id) || id<0 || id>=COINS.length) return;
    if (now-p.lastCollect<150) return;
    p.lastCollect=now; ws.serializeAttachment(p);
    const [x,z]=COINS[id];
    // Trust only the last server-accepted movement. Client does not choose coin coordinates or score.
    if (Math.hypot(p.x-x,p.z-z)>1.35 || p.y>2.6) return;
    const activeAfter=Number(this.coinRespawns[id])||0;
    if (activeAfter>now) {
      this.send(ws,{type:'coin_state',id,respawnAt:activeAfter,serverNow:now});
      return;
    }
    const respawnAt=now+RESPAWN_MS;
    this.coinRespawns[id]=respawnAt; // Claim synchronously; concurrent requests see the inactive state.
    try { await this.ctx.storage.put('coinRespawns',this.coinRespawns); }
    catch (err) {
      this.coinRespawns[id]=activeAfter;
      this.send(ws,{type:'server_error',message:'coin storage unavailable'});
      return;
    }
    p.score=(Number(p.score)||0)+1;
    ws.serializeAttachment(p);
    this.broadcast({type:'coin_collected',id,respawnAt,serverNow:now});
    this.send(ws,{type:'score',score:p.score});
  }

  async webSocketClose(ws) {
    const p=this.player(ws);
    this.broadcast({type:'leave',id:p?.id,count:Math.max(0,this.count()-1)},ws);
    try { ws.close(1000,'Bye'); } catch (_) {}
  }
  async webSocketError(ws) {
    const p=this.player(ws);
    this.broadcast({type:'leave',id:p?.id,count:Math.max(0,this.count()-1)},ws);
    try { ws.close(1011,'Connection error'); } catch (_) {}
  }
}
