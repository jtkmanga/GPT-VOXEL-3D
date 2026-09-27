// VOXEL RUN v4 — Firebase Google identity + server-owned coins + persistent leaderboard.
// Scores live in the game's Durable Object, separate from Firebase Realtime Database.
const COINS = [
  [0,2],[3,4],[-4,5],[8,1],[-8,-2],[12,12],[-13,12],[15,-8],[-16,-9],
  [5,15],[-4,-16],[19,0],[-20,1],[11,-18],[-12,-18],[2,20],[-1,-8],[9,17]
];
const RESPAWN_MS = 60_000;
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let cachedCerts = null, certsExpireAt = 0;

function decodeBase64(value) {
  const normalized = value.replace(/-/g,'+').replace(/_/g,'/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,'='));
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
function readTlv(data,start) {
  if (start>=data.length) throw Error('Invalid certificate');
  const tag=data[start], lengthByte=data[start+1];
  if (lengthByte===undefined) throw Error('Invalid certificate');
  let length=lengthByte, header=2;
  if (lengthByte&0x80) {
    const count=lengthByte&0x7f;
    if (!count || count>3 || start+2+count>data.length) throw Error('Invalid certificate');
    length=0;
    for(let i=0;i<count;i++) length=length*256+data[start+2+i];
    header+=count;
  }
  const end=start+header+length;
  if (end>data.length) throw Error('Invalid certificate');
  return {tag,start,value:start+header,end};
}
function extractSpki(pem) {
  const raw=pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!raw) throw Error('Invalid certificate');
  const data=decodeBase64(raw[1].replace(/\s/g,''));
  const cert=readTlv(data,0), tbs=readTlv(data,cert.value);
  if (cert.tag!==0x30 || tbs.tag!==0x30 || cert.end!==data.length) throw Error('Invalid certificate');
  let offset=tbs.value;
  if (data[offset]===0xa0) offset=readTlv(data,offset).end; // optional version
  for(let i=0;i<5;i++) offset=readTlv(data,offset).end; // serial, sig, issuer, validity, subject
  const spki=readTlv(data,offset);
  if (spki.tag!==0x30 || spki.end>tbs.end) throw Error('Invalid certificate');
  return data.slice(spki.start,spki.end);
}
async function getCert(kid) {
  const now=Date.now();
  if (!cachedCerts || now>=certsExpireAt || !cachedCerts[kid]) {
    const response=await fetch(CERTS_URL);
    if (!response.ok) throw Error('Firebase certificates unavailable');
    const certs=await response.json();
    if (!certs || typeof certs!=='object') throw Error('Firebase certificates unavailable');
    const match=response.headers.get('cache-control')?.match(/max-age=(\d+)/i);
    cachedCerts=certs;
    certsExpireAt=now+Math.min(Number(match?.[1])||300,3600)*1000;
  }
  if (typeof cachedCerts[kid]!=='string') throw Error('Unknown Firebase signing key');
  return cachedCerts[kid];
}
export async function verifyFirebaseIdToken(token,projectId) {
  if (typeof token!=='string' || token.length>8192 || token.length<100 || !projectId) throw Error('Invalid token');
  const parts=token.split('.');
  if (parts.length!==3) throw Error('Invalid token');
  const header=JSON.parse(new TextDecoder().decode(decodeBase64(parts[0])));
  const claims=JSON.parse(new TextDecoder().decode(decodeBase64(parts[1])));
  const now=Math.floor(Date.now()/1000);
  if (header?.alg!=='RS256' || typeof header.kid!=='string' || header.kid.length>200 ||
      claims?.aud!==projectId || claims.iss!==`https://securetoken.google.com/${projectId}` ||
      typeof claims.sub!=='string' || !claims.sub || claims.sub.length>128 ||
      !Number.isInteger(claims.exp) || claims.exp<=now ||
      !Number.isInteger(claims.iat) || claims.iat>now ||
      !Number.isInteger(claims.auth_time) || claims.auth_time>now) throw Error('Invalid token claims');
  const publicKey=await crypto.subtle.importKey('spki',extractSpki(await getCert(header.kid)),
    {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',publicKey,
    decodeBase64(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
  if (!valid) throw Error('Invalid token signature');
  return {uid:claims.sub,exp:claims.exp};
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if (url.pathname==='/health') return new Response('VOXEL RUN v4 online',
      {headers:{'content-type':'text/plain; charset=utf-8'}});
    if (url.pathname!=='/play' || request.headers.get('Upgrade')?.toLowerCase()!=='websocket')
      return new Response('WebSocket endpoint: /play',{status:404});
    if (env.ALLOWED_ORIGIN && request.headers.get('Origin')!==env.ALLOWED_ORIGIN)
      return new Response('Origin not allowed',{status:403});
    return env.ROOM.getByName('free-v2-demo').fetch(request);
  }
};

export class GameRoom {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.projectId=env.FIREBASE_PROJECT_ID;
    this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS voxel_scores (uid TEXT PRIMARY KEY, nickname TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS voxel_coins (id INTEGER PRIMARY KEY, respawn_at INTEGER NOT NULL)');
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
  publicPlayer(p) { return p?.uid && {id:p.id,x:p.x,y:p.y,z:p.z,r:p.r}; }
  coinSnapshot() {
    const respawns=new Map(this.sql.exec('SELECT id,respawn_at FROM voxel_coins').toArray().map(row=>[row.id,row.respawn_at]));
    return COINS.map(([x,z],id)=>({id,x,z,respawnAt:Number(respawns.get(id))||0}));
  }
  top() {
    return this.sql.exec('SELECT nickname, score FROM voxel_scores ORDER BY score DESC, updated_at ASC LIMIT 10').toArray();
  }

  async fetch() {
    await this.ready;
    if (this.sockets().length>=64) return new Response('Demo room full',{status:503});
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
    if (m?.type==='auth') return this.handleAuth(ws,p,m);
    if (!p.uid || Math.floor(Date.now()/1000)>=p.exp) { ws.close(1008,'Sign in required'); return; }
    if (message.length>256) return;
    if (m?.type==='move') return this.handleMove(ws,p,m);
    if (m?.type==='collect') return this.handleCollect(ws,p,m);
  }

  async handleAuth(ws,p,m) {
    if (!p.uid) {
      if (++p.authAttempts>3) { ws.close(1008,'Too many attempts'); return; }
      ws.serializeAttachment(p);
    }
    let verified;
    try { verified=await verifyFirebaseIdToken(m.token,this.projectId); }
    catch (_) { this.send(ws,{type:'auth_error',message:'Firebase sign-in failed'}); ws.close(1008,'Invalid ID token'); return; }
    p=this.player(ws); // Another auth frame may have completed during certificate fetch.
    if (p.uid && p.uid!==verified.uid) { ws.close(1008,'Different account'); return; }
    if (p.uid) { p.exp=verified.exp; ws.serializeAttachment(p); this.send(ws,{type:'auth_refreshed'}); return; }
    const uid=verified.uid, now=Date.now(), id=crypto.randomUUID();
    const nickname='Player-'+uid.slice(-6);
    this.sql.exec('INSERT INTO voxel_scores(uid,nickname,score,updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(uid) DO NOTHING',uid,nickname,now);
    const score=this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score||0;
    const n=this.count();
    Object.assign(p,{uid,exp:verified.exp,id,x:(n%5)*2-4,y:.93,z:Math.floor(n/5)*2,r:0,at:now,last:0,lastCollect:0});
    ws.serializeAttachment(p);
    this.send(ws,{type:'welcome',protocol:4,id,spawn:{x:p.x,y:p.y,z:p.z},
      players:this.sockets().filter(other=>other!==ws).map(other=>this.publicPlayer(this.player(other))).filter(Boolean),
      coins:this.coinSnapshot(),score,leaderboard:this.top(),serverNow:now,count:this.count()});
    this.broadcast({type:'join',player:this.publicPlayer(p),count:this.count()},ws);
    this.broadcast({type:'leaderboard',top:this.top()});
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
    if (!Number.isInteger(id) || id<0 || id>=COINS.length || now-p.lastCollect<150) return;
    p.lastCollect=now; ws.serializeAttachment(p);
    const [x,z]=COINS[id];
    if (Math.hypot(p.x-x,p.z-z)>1.35 || p.y>2.6) return;
    let result;
    try {
      result=this.ctx.storage.transactionSync(()=>{
        const activeAfter=Number(this.sql.exec('SELECT respawn_at FROM voxel_coins WHERE id=?',id).toArray()[0]?.respawn_at)||0;
        if (activeAfter>now) return {activeAfter};
        const respawnAt=now+RESPAWN_MS;
        this.sql.exec('INSERT INTO voxel_coins(id,respawn_at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET respawn_at=excluded.respawn_at',id,respawnAt);
        this.sql.exec('UPDATE voxel_scores SET score=score+1, updated_at=? WHERE uid=?',now,p.uid);
        const score=this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',p.uid).toArray()[0].score;
        return {respawnAt,score};
      });
    } catch (_) { this.send(ws,{type:'server_error',message:'Score storage unavailable'}); return; }
    if (result.activeAfter) {
      this.send(ws,{type:'coin_state',id,respawnAt:result.activeAfter,serverNow:now}); return;
    }
    this.broadcast({type:'coin_collected',id,respawnAt:result.respawnAt,serverNow:now});
    this.send(ws,{type:'score',score:result.score});
    this.broadcast({type:'leaderboard',top:this.top()});
  }

  async webSocketClose(ws) {
    const p=this.player(ws);
    if (p?.uid) this.broadcast({type:'leave',id:p.id,count:Math.max(0,this.count()-1)},ws);
    try { ws.close(1000,'Bye'); } catch (_) {}
  }
  async webSocketError(ws) {
    const p=this.player(ws);
    if (p?.uid) this.broadcast({type:'leave',id:p.id,count:Math.max(0,this.count()-1)},ws);
    try { ws.close(1011,'Connection error'); } catch (_) {}
  }
}
