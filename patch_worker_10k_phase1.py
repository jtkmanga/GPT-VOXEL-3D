from pathlib import Path
import re, shutil

p = Path('worker.js')
if not p.exists():
    raise SystemExit('ERROR: ไม่พบ worker.js ในโฟลเดอร์นี้')

s = p.read_text()
if 'FREE_10K_PHASE1' in s:
    raise SystemExit('ERROR: worker.js มี FREE_10K_PHASE1 อยู่แล้ว ไม่ต้องรันซ้ำ')

backup = Path('worker.before-10k-phase1.backup.js')
if not backup.exists():
    shutil.copy2(p, backup)

# 1) Tunables for the first scale step.
marker = "const LUCKY_BOX_CLAIM_MS = 90 * 1000;"
if marker not in s:
    raise SystemExit('ERROR: ไม่พบ LUCKY_BOX_CLAIM_MS ใน worker.js')
s = s.replace(marker, marker + r'''
// FREE_10K_PHASE1
// Phase 1: reduce movement traffic and only fan out nearby player movement.
// This is the safe foundation before spatial zone sharding in Phase 2.
const MOVE_TICK_MS = 200;              // 5 movement updates/sec
const PLAYER_VISIBILITY_RADIUS = 120;   // only nearby avatars are streamed
const ROOM_SOFT_CAP = 160;              // temporary per-room test cap before sharding
''', 1)

# 2) Add proximity helpers while preserving broadcast() for global room events.
old = r'''  broadcast(value,except) {
    const data=JSON.stringify(value);
    for(const ws of this.sockets()) if(ws!==except && this.player(ws)?.uid) {
      try { ws.send(data); } catch (_) {}
    }
  }
  publicPlayer(p) { return p?.uid && {id:p.id,x:p.x,y:p.y,z:p.z,r:p.r}; }'''
new = r'''  broadcast(value,except) {
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
  publicPlayer(p) { return p?.uid && {id:p.id,x:p.x,y:p.y,z:p.z,r:p.r}; }'''
if old not in s:
    raise SystemExit('ERROR: ไม่พบบล็อก broadcast/publicPlayer เดิม')
s=s.replace(old,new,1)

# 3) Temporary cap for load tests in the single-room phase.
old_cap="if (this.sockets().length>=64) return new Response('Demo room full',{status:503});"
new_cap="if (this.sockets().length>=ROOM_SOFT_CAP) return new Response('Scale test room full',{status:503});"
if old_cap not in s:
    raise SystemExit('ERROR: ไม่พบ room cap 64 เดิม')
s=s.replace(old_cap,new_cap,1)

# 4) Welcome only includes players already nearby the new spawn.
old_players="players:this.sockets().filter(other=>other!==ws).map(other=>this.publicPlayer(this.player(other))).filter(Boolean),"
new_players="players:this.nearbySockets(p,ws).map(other=>this.publicPlayer(this.player(other))).filter(Boolean),"
if old_players not in s:
    raise SystemExit('ERROR: ไม่พบ welcome players เดิม')
s=s.replace(old_players,new_players,1)

# 5) Join event only goes to nearby players; leaderboard remains room-wide for Phase 1.
old_join="this.broadcast({type:'join',player:this.publicPlayer(p),count:this.count()},ws);"
new_join="this.broadcastNearby({type:'join',player:this.publicPlayer(p),count:this.count()},p,ws);"
if old_join not in s:
    raise SystemExit('ERROR: ไม่พบ join broadcast เดิม')
s=s.replace(old_join,new_join,1)

# 6) Reduce movement processing to 5Hz and fan out only nearby.
old_tick="if (now-p.last<70) return;"
if old_tick not in s:
    raise SystemExit('ERROR: ไม่พบ movement throttle 70ms เดิม')
s=s.replace(old_tick,"if (now-p.last<MOVE_TICK_MS) return;",1)

old_move="this.broadcast({type:'move',player:this.publicPlayer(p)},ws);"
new_move="this.broadcastNearby({type:'move',player:this.publicPlayer(p)},p,ws);"
if old_move not in s:
    raise SystemExit('ERROR: ไม่พบ move broadcast เดิม')
s=s.replace(old_move,new_move,1)

p.write_text(s)
print('OK: FREE 10K Phase 1 Worker patch applied')
print('Backup:', backup)
print('Movement: 5Hz | Proximity radius: 120 | Temporary cap: 160')
