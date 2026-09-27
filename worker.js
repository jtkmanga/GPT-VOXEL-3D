// VOXEL RUN v2: anonymous presence and movement only. Never accepts scores.
// Deploy with wrangler.jsonc. No account or VIP access control exists in v2.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('VOXEL RUN v2 online', {headers:{'content-type':'text/plain'}});
    if (url.pathname !== '/play' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket endpoint: /play', {status:404});
    }
    if (env.ALLOWED_ORIGIN && request.headers.get('Origin') !== env.ALLOWED_ORIGIN) {
      return new Response('Origin not allowed', {status:403});
    }
    const room = env.ROOM.getByName('free-v2-demo');
    return room.fetch(request);
  }
};

export class GameRoom {
  constructor(ctx) { this.ctx = ctx; }

  player(ws) { return ws.deserializeAttachment(); }
  send(ws, value) { try { ws.send(JSON.stringify(value)); } catch (_) {} }
  broadcast(value, except) {
    const data = JSON.stringify(value);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except) {
      try { ws.send(data); } catch (_) {}
    }
  }
  count() { return this.ctx.getWebSockets().length; }

  async fetch() {
    if (this.count() >= 64) return new Response('Demo room full', {status:503});
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const n = this.count();
    const id = crypto.randomUUID();
    const now = Date.now();
    const p = {id, x:(n % 5) * 2 - 4, y:.93, z:Math.floor(n / 5) * 2, r:0, at:now, last:0};
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(p);
    this.send(server, {type:'welcome', id, spawn:{x:p.x,y:p.y,z:p.z},
      players:this.ctx.getWebSockets().filter(ws=>ws!==server).map(ws=>this.publicPlayer(this.player(ws))).filter(Boolean),
      count:this.count()});
    this.broadcast({type:'join',player:this.publicPlayer(p),count:this.count()},server);
    return new Response(null,{status:101,webSocket:client});
  }

  publicPlayer(p) { return p && {id:p.id,x:p.x,y:p.y,z:p.z,r:p.r}; }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string' || message.length > 256) { ws.close(1009,'Invalid message'); return; }
    let m; try { m=JSON.parse(message); } catch (_) { return; }
    if (m?.type !== 'move') return;
    const p=this.player(ws), now=Date.now();
    if (!p || now-p.last < 70) return;
    const {x,y,z,r}=m;
    if (![x,y,z,r].every(Number.isFinite)) return;
    if (Math.abs(x)>24 || Math.abs(z)>24 || y<.85 || y>5 || Math.abs(r)>10000) return;
    const dt=Math.min(1.5,Math.max(0,(now-p.at)/1000));
    // Movement is bounded for a presence demo, not a production anti-cheat engine.
    if (Math.hypot(x-p.x,z-p.z)>7.5*dt+.65 || Math.abs(y-p.y)>9*dt+.5) return;
    Object.assign(p,{x,y,z,r,at:now,last:now});
    ws.serializeAttachment(p);
    this.broadcast({type:'move',player:this.publicPlayer(p)},ws);
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
