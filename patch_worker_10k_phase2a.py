from pathlib import Path
import json, re, shutil, subprocess

WORKER = Path('worker.js')
WRANGLER = Path('wrangler.jsonc')

if not WORKER.exists():
    raise SystemExit('ERROR: ไม่พบ worker.js')
if not WRANGLER.exists():
    raise SystemExit('ERROR: ไม่พบ wrangler.jsonc')

s = WORKER.read_text()

if 'FREE_10K_PHASE1' not in s:
    raise SystemExit('ERROR: worker.js ไม่ใช่ Phase 1 ที่คาดไว้')
if 'FREE_10K_PHASE2A' in s or 'export class ZoneRoom' in s:
    raise SystemExit('ERROR: Phase 2A ถูกเพิ่มไว้แล้ว ไม่ต้องรันซ้ำ')

worker_backup = Path('worker.before-10k-phase2a.backup.js')
wrangler_backup = Path('wrangler.before-10k-phase2a.backup.jsonc')
if not worker_backup.exists():
    shutil.copy2(WORKER, worker_backup)
if not wrangler_backup.exists():
    shutil.copy2(WRANGLER, wrangler_backup)

old_const = 'const ROOM_SOFT_CAP = 160;              // temporary per-room test cap before sharding'
new_const = r'''const ROOM_SOFT_CAP = 160;              // temporary per-room test cap before sharding
// FREE_10K_PHASE2A
// Phase 2A: additive movement-zone sharding.
// Existing /play without ?zone= stays on the already-tested Phase 1 room.
const ZONE_GRID_SIZE = 10;              // 10 x 10 = 100 movement zones
const ZONE_SIZE = SERVER_MAP_SIZE / ZONE_GRID_SIZE;
const ZONE_SOFT_CAP = 120;              // temporary per-zone soft cap

function normalizeZoneId(value) {
  const m = /^(\\d{1,2}),(\\d{1,2})$/.exec(String(value || ''));
  if (!m) return null;
  const zx = Number(m[1]), zz = Number(m[2]);
  if (!Number.isInteger(zx) || !Number.isInteger(zz) ||
      zx < 0 || zz < 0 || zx >= ZONE_GRID_SIZE || zz >= ZONE_GRID_SIZE) return null;
  return `${zx},${zz}`;
}

function zoneCenter(zoneId) {
  const normalized = normalizeZoneId(zoneId);
  if (!normalized) return null;
  const [zx,zz] = normalized.split(',').map(Number);
  const min = -SERVER_MAP_SIZE / 2;
  return {
    x: min + zx * ZONE_SIZE + ZONE_SIZE / 2,
    z: min + zz * ZONE_SIZE + ZONE_SIZE / 2
  };
}

function zoneFromPosition(x,z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const half = SERVER_MAP_SIZE / 2;
  if (x < -half || x >= half || z < -half || z >= half) return null;
  const zx = Math.min(ZONE_GRID_SIZE - 1, Math.max(0, Math.floor((x + half) / ZONE_SIZE)));
  const zz = Math.min(ZONE_GRID_SIZE - 1, Math.max(0, Math.floor((z + half) / ZONE_SIZE)));
  return `${zx},${zz}`;
}'''

if old_const not in s:
    raise SystemExit('ERROR: ไม่พบ ROOM_SOFT_CAP ของ Phase 1')
s = s.replace(old_const, new_const, 1)

old_router = "    return env.ROOM.getByName('free-v2-demo').fetch(request);"
new_router = r'''    const requestedZone = url.searchParams.get('zone');
    if (requestedZone !== null) {
      const zoneId = normalizeZoneId(requestedZone);
      if (!zoneId) return new Response('Invalid zone',{status:400});
      return env.ZONE.getByName(`free-zone-${zoneId}`).fetch(request);
    }

    // Backward-compatible path: current game remains on the tested Phase 1 room.
    return env.ROOM.getByName('free-v2-demo').fetch(request);'''

if s.count(old_router) != 1:
    raise SystemExit(f'ERROR: คาดว่า router เดิมต้องมี 1 จุด แต่พบ {s.count(old_router)}')
s = s.replace(old_router, new_router, 1)

bootstrap_route = r'''
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
      const nickname = 'Player-' + uid.slice(-6);

      this.sql.exec(
        'INSERT INTO voxel_scores(uid,nickname,score,updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(uid) DO NOTHING',
        uid, nickname, now
      );

      const score = Number(
        this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score || 0
      );

      const ent = this.sql.exec(
        `SELECT speed_expires, coin_expires, vip1_expires
         FROM voxel_entitlements WHERE uid=?`,
        uid
      ).toArray()[0] || {speed_expires:0,coin_expires:0,vip1_expires:0};

      return Response.json({
        ok:true,
        serverNow:now,
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

'''

grant_marker = "    if (\n      url.pathname === '/_internal/grant-payment' &&"
if grant_marker not in s:
    raise SystemExit('ERROR: ไม่พบตำแหน่ง internal grant-payment')
s = s.replace(grant_marker, bootstrap_route + grant_marker, 1)

zone_class = r'''

// Phase 2A movement-zone Durable Object.
// World state, scores, payments, coins and Lucky Box remain authoritative in GameRoom.
export class ZoneRoom {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.projectId=env.FIREBASE_PROJECT_ID;
  }

  player(ws) { return ws.deserializeAttachment(); }
  sockets() { return this.ctx.getWebSockets(); }
  count() { return this.sockets().filter(ws=>this.player(ws)?.uid).length; }
  send(ws,value) { try { ws.send(JSON.stringify(value)); } catch (_) {} }

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
    return p?.uid && {id:p.id,x:p.x,y:p.y,z:p.z,r:p.r};
  }

  async fetch(request) {
    const url=new URL(request.url);

    if (request.headers.get('Upgrade')?.toLowerCase()!=='websocket')
      return new Response('WebSocket required',{status:426});

    const zoneId=normalizeZoneId(url.searchParams.get('zone'));
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

    if (m?.type==='auth') return this.handleAuth(ws,p,m);

    if (!p.uid || Math.floor(Date.now()/1000)>=p.exp) {
      ws.close(1008,'Sign in required');
      return;
    }

    if (message.length>256) return;

    if (m?.type==='move') return this.handleMove(ws,p,m);

    // Phase 2A is intentionally movement-only.
    // Phase 2B will add secure zone handoff + world-changing actions.
    if (m?.type==='collect' || m?.type==='collect_box' || m?.type==='spin_box') {
      this.send(ws,{type:'phase2_pending',feature:m.type});
    }
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
      this.send(ws,{type:'auth_error',message:'Firebase sign-in failed'});
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
      this.send(ws,{type:'auth_refreshed'});
      return;
    }

    let bootstrap;
    try {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-bootstrap',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:verified.uid})
        })
      );
      bootstrap=await response.json();
      if (!response.ok || !bootstrap?.ok) throw Error('bootstrap failed');
    } catch (_) {
      this.send(ws,{type:'server_error',message:'World bootstrap unavailable'});
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

    const n=this.count();
    const col=n%10;
    const row=Math.floor(n/10)%10;
    const spawnX=center.x+(col-4.5)*4;
    const spawnZ=center.z+(row-4.5)*4;
    const now=Date.now();
    const id=crypto.randomUUID();

    Object.assign(p,{
      uid:verified.uid,
      exp:verified.exp,
      id,
      zoneId,
      x:spawnX,
      y:0,
      z:spawnZ,
      r:0,
      at:now,
      last:0,
      speedExpires:Number(bootstrap.entitlements?.speedExpires)||0
    });

    ws.serializeAttachment(p);

    this.send(ws,{
      type:'welcome',
      protocol:5,
      phase:'2A',
      zone:zoneId,
      id,
      spawn:{x:p.x,y:p.y,z:p.z},
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
      type:'join',
      player:this.publicPlayer(p),
      count:this.count()
    },p,ws);
  }

  handleMove(ws,p,m) {
    const now=Date.now();
    if (now-p.last<MOVE_TICK_MS) return;

    const {x,y,z,r}=m;
    if (![x,y,z,r].every(Number.isFinite)) return;
    if (Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 || Math.abs(r)>10000) return;

    const requestedZone=zoneFromPosition(x,z);
    if (!requestedZone) return;

    if (requestedZone!==p.zoneId) {
      this.send(ws,{
        type:'zone_change',
        from:p.zoneId,
        zone:requestedZone,
        position:{x:p.x,y:p.y,z:p.z,r:p.r}
      });
      return;
    }

    const dt=Math.min(1.5,Math.max(0,(now-p.at)/1000));
    const speedActive=Number(p.speedExpires||0)>now;
    const maxHorizontalSpeed=speedActive ? 50 : 26;

    if (
      Math.hypot(x-p.x,z-p.z)>maxHorizontalSpeed*dt+.65 ||
      Math.abs(y-p.y)>9*dt+.5
    ) return;

    Object.assign(p,{x,y,z,r,at:now,last:now});
    ws.serializeAttachment(p);

    this.broadcastNearby({
      type:'move',
      player:this.publicPlayer(p)
    },p,ws);
  }

  async webSocketClose(ws) {
    const p=this.player(ws);
    if (p?.uid) {
      this.broadcastNearby({
        type:'leave',
        id:p.id,
        count:Math.max(0,this.count()-1)
      },p,ws);
    }
    try { ws.close(1000,'Bye'); } catch (_) {}
  }

  async webSocketError(ws) {
    const p=this.player(ws);
    if (p?.uid) {
      this.broadcastNearby({
        type:'leave',
        id:p.id,
        count:Math.max(0,this.count()-1)
      },p,ws);
    }
    try { ws.close(1011,'Connection error'); } catch (_) {}
  }
}
'''

s += zone_class
WORKER.write_text(s)

raw = WRANGLER.read_text()
clean = re.sub(r'/\*[\s\S]*?\*/', '', raw)
clean = re.sub(r'(^|\s)//.*$', r'\1', clean, flags=re.M)
clean = re.sub(r',\s*([}\]])', r'\1', clean)

try:
    cfg = json.loads(clean)
except Exception as e:
    raise SystemExit(f'ERROR: อ่าน wrangler.jsonc ไม่ได้: {e}')

bindings = cfg.setdefault('durable_objects', {}).setdefault('bindings', [])
if not any(b.get('name') == 'ROOM' and b.get('class_name') == 'GameRoom' for b in bindings):
    raise SystemExit('ERROR: ไม่พบ ROOM -> GameRoom binding เดิม')

if not any(b.get('name') == 'ZONE' for b in bindings):
    bindings.append({'name':'ZONE','class_name':'ZoneRoom'})

migrations = cfg.setdefault('migrations', [])
if not any('ZoneRoom' in (m.get('new_sqlite_classes') or []) for m in migrations):
    existing_tags = {str(m.get('tag')) for m in migrations}
    tag = 'v2-zone-room'
    n = 2
    while tag in existing_tags:
        n += 1
        tag = f'v{n}-zone-room'
    migrations.append({'tag':tag,'new_sqlite_classes':['ZoneRoom']})

WRANGLER.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + '\n')

try:
    check = subprocess.run(['node','--check',str(WORKER)], capture_output=True, text=True)
except FileNotFoundError:
    check = None

if check is not None and check.returncode != 0:
    shutil.copy2(worker_backup, WORKER)
    shutil.copy2(wrangler_backup, WRANGLER)
    raise SystemExit('ERROR: node --check ไม่ผ่าน\n' + check.stderr)

print('OK: FREE 10K Phase 2A zone sharding patch applied')
print('Zones: 10 x 10 = 100')
print('Per-zone temporary cap: 120')
print('Legacy /play path: unchanged')
print('Zone path example: /play?zone=5,5')
print('Backups:')
print(' -', worker_backup)
print(' -', wrangler_backup)
