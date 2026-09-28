from pathlib import Path
import re, shutil

p = Path('worker.js')
if not p.exists():
    raise SystemExit('ERROR: ไม่พบ worker.js ในโฟลเดอร์นี้')

s = p.read_text()
if 'WORLD_LUCKYBOX_V2_PATCH' in s:
    raise SystemExit('ERROR: worker.js มี WORLD_LUCKYBOX_V2_PATCH อยู่แล้ว ไม่ต้องรันซ้ำ')

backup = Path('worker.before-world-luckybox-v2.backup.js')
if not backup.exists():
    shutil.copy2(p, backup)

# 1) Replace demo COINS with a full 1500x1500 deterministic world helper.
coin_pat = re.compile(r"const\s+COINS\s*=\s*\[[\s\S]*?\];\s*\n\s*const\s+RESPAWN_MS\s*=\s*60_000\s*;")
world_code = r'''// WORLD_LUCKYBOX_V2_PATCH
const SERVER_MAP_SIZE = 1500;
const SERVER_WORLD_SEED = 'free1';
const SERVER_COIN_COUNT = 200;
const LUCKY_BOX_RESPAWN_MS = 4 * 60 * 60 * 1000;
const LUCKY_BOX_CLAIM_MS = 90 * 1000;

function serverSeededRandom(seedText) {
  let seed = 2166136261;
  const str = String(seedText || 'default-map');
  for (let i = 0; i < str.length; i++) {
    seed ^= str.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return function() {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildServerCollisionWorld(seedText) {
  const rng = serverSeededRandom(seedText);
  const buildings = [];
  const trees = [];

  for (let bx = -600; bx <= 600; bx += 200) {
    for (let bz = -600; bz <= 600; bz += 200) {
      if (Math.abs(bx) < 100 && Math.abs(bz) < 100) continue;
      const width = 18 + Math.floor(rng() * 20);
      const depth = 18 + Math.floor(rng() * 20);
      28 + Math.floor(rng() * 65); // advance height RNG
      Math.floor(rng() * 3);       // advance material RNG
      const posX = bx + (rng() - 0.5) * 60;
      const posZ = bz + (rng() - 0.5) * 60;
      buildings.push({
        minX: posX - width / 2 - 2,
        maxX: posX + width / 2 + 2,
        minZ: posZ - depth / 2 - 2,
        maxZ: posZ + depth / 2 + 2
      });
    }
  }

  for (let i = 0; i < 250; i++) {
    const tx = (rng() - 0.5) * (SERVER_MAP_SIZE - 50);
    const tz = (rng() - 0.5) * (SERVER_MAP_SIZE - 50);
    const insideBuilding = buildings.some(b => tx >= b.minX && tx <= b.maxX && tz >= b.minZ && tz <= b.maxZ);
    if (insideBuilding || (Math.abs(tx) < 25 && Math.abs(tz) < 25)) continue;
    6 + rng() * 4; // advance trunkHeight RNG
    6 + rng() * 3; // advance leafSize RNG
    trees.push({
      minX: tx - 1.8,
      maxX: tx + 1.8,
      minZ: tz - 1.8,
      maxZ: tz + 1.8
    });
  }

  return { buildings, trees };
}

const SERVER_WORLD = buildServerCollisionWorld(SERVER_WORLD_SEED);

function safeWorldPosition(seedText, minDistanceFromSpawn = 0, margin = 12) {
  const rng = serverSeededRandom(seedText);
  let rx = 0, rz = 0;
  for (let attempt = 0; attempt < 2000; attempt++) {
    rx = (rng() - 0.5) * (SERVER_MAP_SIZE - margin);
    rz = (rng() - 0.5) * (SERVER_MAP_SIZE - margin);
    if (minDistanceFromSpawn > 0 && Math.hypot(rx, rz) < minDistanceFromSpawn) continue;
    const collision =
      SERVER_WORLD.buildings.some(b => rx >= b.minX && rx <= b.maxX && rz >= b.minZ && rz <= b.maxZ) ||
      SERVER_WORLD.trees.some(t => rx >= t.minX && rx <= t.maxX && rz >= t.minZ && rz <= t.maxZ);
    if (!collision) return { x: rx, z: rz };
  }
  return { x: minDistanceFromSpawn + 50, z: 0 };
}

function coinPosition(id, cycle = 0) {
  return safeWorldPosition(`${SERVER_WORLD_SEED}:coin:${Number(id) || 0}:cycle:${Number(cycle) || 0}`, 0, 12);
}

const COINS = Array.from({length:SERVER_COIN_COUNT}, (_,id) => {
  const pos = coinPosition(id, 0);
  return [pos.x, pos.z];
});

function luckyBoxPosition(cycle = 0) {
  return safeWorldPosition(`${SERVER_WORLD_SEED}:position:lucky-box-${Number(cycle) || 0}`, 120, 20);
}

function secureLuckyReward() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  const roll = (a[0] / 4294967296) * 100;
  if (roll < 50) return 100;      // 50.0%
  if (roll < 80) return 500;      // 30.0%
  if (roll < 99) return 1000;     // 19.0%
  if (roll < 99.9) return 5000;   // 0.9%
  return 9999;                    // 0.1%
}

const RESPAWN_MS = 60_000;'''

s, n = coin_pat.subn(world_code, s, count=1)
if n != 1:
    raise SystemExit('ERROR: ไม่พบ const COINS ... const RESPAWN_MS แบบที่คาดไว้ — ยังไม่ได้แก้ worker.js')

# 2) Full 1500x1500 map bounds and a mobile-friendly secure collect radius.
s, n = re.subn(r"Math\.abs\(x\)>24\s*\|\|\s*Math\.abs\(z\)>24", "Math.abs(x)>748 || Math.abs(z)>748", s, count=1)
if n != 1:
    raise SystemExit('ERROR: ไม่พบขอบเขต demo +/-24 ใน handleMove')

s, n = re.subn(r"Math\.hypot\(p\.x-x,p\.z-z\)>1\.35", "Math.hypot(p.x-x,p.z-z)>2.35", s, count=1)
if n != 1:
    raise SystemExit('ERROR: ไม่พบระยะเก็บเหรียญเดิม 1.35')

# 3) Add coin cycle migration + one Lucky Box row.
coin_table = "this.sql.exec('CREATE TABLE IF NOT EXISTS voxel_coins (id INTEGER PRIMARY KEY, respawn_at INTEGER NOT NULL)');"
if coin_table not in s:
    raise SystemExit('ERROR: ไม่พบตาราง voxel_coins ใน constructor')
extra_sql = coin_table + r'''
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
      VALUES (1, 0, 0, NULL, 0)`);'''
s = s.replace(coin_table, extra_sql, 1)

# 4) Dynamic coin snapshot: each pickup increments cycle, so next spawn is a new random safe location.
coin_snapshot_pat = re.compile(
    r"coinSnapshot\(\)\s*\{[\s\S]*?return\s+COINS\.map\(\(\[x,z\],id\)=>\(\{id,x,z,respawnAt:Number\(respawns\.get\(id\)\|\|0\)\}\)\);\s*\}",
    re.M
)
coin_snapshot_new = r"""coinSnapshot() {
    const rows = new Map(
      this.sql.exec('SELECT id, respawn_at, cycle FROM voxel_coins').toArray()
        .map(row => [Number(row.id), {respawnAt:Number(row.respawn_at)||0, cycle:Number(row.cycle)||0}])
    );
    return COINS.map((_,id) => {
      const row = rows.get(id) || {respawnAt:0, cycle:0};
      const pos = coinPosition(id, row.cycle);
      return {id,x:pos.x,z:pos.z,respawnAt:row.respawnAt,cycle:row.cycle};
    });
  }"""
s, n = coin_snapshot_pat.subn(coin_snapshot_new, s, count=1)
if n != 1:
    raise SystemExit('ERROR: ไม่พบ coinSnapshot() รูปแบบเดิม')

coin_start_old = """    const [x,z]=COINS[id];
    if (Math.hypot(p.x-x,p.z-z)>2.35 || p.y>2.6) return;"""
coin_start_new = """    const visibleRow = this.sql.exec(
      'SELECT cycle FROM voxel_coins WHERE id=?', id
    ).toArray()[0];
    const visibleCycle = Number(visibleRow?.cycle || 0);
    const {x,z} = coinPosition(id, visibleCycle);
    if (Math.hypot(p.x-x,p.z-z)>2.35 || p.y>2.6) return;"""
if coin_start_old not in s:
    raise SystemExit('ERROR: ไม่พบตำแหน่ง COINS[id] ใน handleCollect')
s = s.replace(coin_start_old, coin_start_new, 1)

active_old = """        const activeAfter=Number(this.sql.exec('SELECT respawn_at FROM voxel_coins WHERE id=?',id).toArray()[0]?.respawn_at)||0;
        if (activeAfter>now) return {activeAfter};
        const respawnAt=now+RESPAWN_MS;"""
active_new = """        const row=this.sql.exec(
          'SELECT respawn_at, cycle FROM voxel_coins WHERE id=?', id
        ).toArray()[0];
        const activeAfter=Number(row?.respawn_at)||0;
        if (activeAfter>now) return {activeAfter};
        const nextCycle=(Number(row?.cycle)||0)+1;
        const respawnAt=now+RESPAWN_MS;"""
if active_old not in s:
    raise SystemExit('ERROR: ไม่พบ SELECT respawn_at เดิมใน handleCollect')
s = s.replace(active_old, active_new, 1)

insert_old = "this.sql.exec('INSERT INTO voxel_coins(id,respawn_at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET respawn_at=excluded.respawn_at',id,respawnAt);"
insert_new = """this.sql.exec(
          'INSERT INTO voxel_coins(id,respawn_at,cycle) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET respawn_at=excluded.respawn_at, cycle=excluded.cycle',
          id, respawnAt, nextCycle
        );"""
if insert_old not in s:
    raise SystemExit('ERROR: ไม่พบ INSERT voxel_coins เดิม')
s = s.replace(insert_old, insert_new, 1)

if "return {respawnAt,score};" not in s:
    raise SystemExit('ERROR: ไม่พบ return {respawnAt,score} ใน handleCollect')
s = s.replace("return {respawnAt,score};", "return {respawnAt,score,cycle:nextCycle};", 1)

broadcast_old = "this.broadcast({type:'coin_collected',id,respawnAt:result.respawnAt,serverNow:now});"
broadcast_new = """const nextPos=coinPosition(id,Number(result.cycle)||0);
    this.broadcast({type:'coin_collected',id,x:nextPos.x,z:nextPos.z,cycle:result.cycle,respawnAt:result.respawnAt,serverNow:now});"""
if broadcast_old not in s:
    raise SystemExit('ERROR: ไม่พบ broadcast coin_collected เดิม')
s = s.replace(broadcast_old, broadcast_new, 1)

# 5) Lucky Box methods before handleMove.
move_marker = re.search(r"\n\s*handleMove\(ws,p,m\)\s*\{", s)
if not move_marker:
    raise SystemExit('ERROR: ไม่พบ handleMove(ws,p,m)')
insert_at = move_marker.start()
box_methods = r'''

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
      this.send(ws,{type:'box_state',box:snap,serverNow:now});
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
    this.broadcast({type:'box_state',box:state,serverNow:now});
    if (claimed) this.send(ws,{type:'box_spin_ready',box:state,serverNow:now});
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
      this.send(ws,{type:'box_error',message:'Lucky Box storage unavailable'});
      return;
    }

    if (!result?.ok) {
      this.send(ws,{type:'box_error',message:result?.message || 'Lucky Box spin failed'});
      this.send(ws,{type:'box_state',box:this.boxSnapshot(now),serverNow:now});
      return;
    }

    this.send(ws,{type:'box_reward',reward:result.reward,score:result.score,serverNow:now});
    this.broadcast({type:'box_state',box:this.boxSnapshot(now),serverNow:now});
    this.broadcast({type:'leaderboard',top:this.top()});
  }
'''
s = s[:insert_at] + box_methods + s[insert_at:]

# 6) New websocket messages.
collect_line = "if (m?.type==='collect') return this.handleCollect(ws,p,m);"
if collect_line not in s:
    raise SystemExit("ERROR: ไม่พบ websocket route type='collect'")
s = s.replace(
    collect_line,
    collect_line + "\n      if (m?.type==='collect_box') return this.handleCollectBox(ws,p,m);\n      if (m?.type==='spin_box') return this.handleSpinBox(ws,p,m);",
    1
)

# 7) Send Lucky Box state during welcome.
welcome_target = "coins:this.coinSnapshot(),score,leaderboard:this.top(),serverNow:now,count:this.count()"
if welcome_target not in s:
    raise SystemExit('ERROR: ไม่พบ welcome packet ตำแหน่ง coins/score/leaderboard')
s = s.replace(
    welcome_target,
    "coins:this.coinSnapshot(),luckyBox:this.boxSnapshot(now),score,leaderboard:this.top(),serverNow:now,count:this.count()",
    1
)

p.write_text(s)
print('OK: 200 coins + random 1-minute respawns + full map + secure Lucky Box added')
print('Backup:', backup)
