from pathlib import Path
import shutil

# Prefer the secure V2 filename, but allow index.html if the user renamed it.
candidates=[Path('index_secure_worker_beta_v2.html'),Path('index.html')]
p=next((x for x in candidates if x.exists()),None)
if p is None:
    raise SystemExit('ERROR: ไม่พบ index_secure_worker_beta_v2.html หรือ index.html')

s=p.read_text()
if 'FREE_10K_PHASE1_CLIENT' in s:
    raise SystemExit('ERROR: HTML มี FREE_10K_PHASE1_CLIENT อยู่แล้ว ไม่ต้องรันซ้ำ')

backup=p.with_name(p.stem+'.before-10k-phase1.backup'+p.suffix)
if not backup.exists():
    shutil.copy2(p,backup)

# 1) Client movement send rate: 5Hz. Force packets still go immediately.
old="if (!force && now - secureLastMoveSentAt < 100) return;"
new="if (!force && now - secureLastMoveSentAt < 200) return; // FREE_10K_PHASE1_CLIENT: 5Hz"
if old not in s:
    raise SystemExit('ERROR: ไม่พบ secure movement send interval 100ms')
s=s.replace(old,new,1)

# 2) Track when each remote player was last streamed from the server.
old_obj="""                name: data.name || 'Player'\n            };"""
new_obj="""                name: data.name || 'Player',\n                _secureLastSeenAt: performance.now()\n            };"""
if old_obj not in s:
    raise SystemExit('ERROR: ไม่พบบล็อก otherPlayers ตอนสร้างผู้เล่น')
s=s.replace(old_obj,new_obj,1)

old_update="""            p.targetRot = data.rotY || 0;\n            if (data.name && p.name !== data.name) {"""
new_update="""            p.targetRot = data.rotY || 0;\n            p._secureLastSeenAt = performance.now();\n            if (data.name && p.name !== data.name) {"""
if old_update not in s:
    raise SystemExit('ERROR: ไม่พบบล็อก updateOtherPlayer')
s=s.replace(old_update,new_update,1)

# 3) Stale nearby avatars disappear after 3.5s if the server stops streaming them
# because they moved outside the 120-unit AOI.
old_loop="""                Object.keys(otherPlayers).forEach(id => {\n                    const op = otherPlayers[id];\n                    op.mesh.position.lerp(op.targetPos, 0.15);"""
new_loop="""                Object.keys(otherPlayers).forEach(id => {\n                    const op = otherPlayers[id];\n                    if (op._secureLastSeenAt && performance.now() - op._secureLastSeenAt > 3500) {\n                        removeOtherPlayer(id);\n                        return;\n                    }\n                    op.mesh.position.lerp(op.targetPos, 0.15);"""
if old_loop not in s:
    raise SystemExit('ERROR: ไม่พบ remote player animation loop')
s=s.replace(old_loop,new_loop,1)

p.write_text(s)
print('OK: FREE 10K Phase 1 Client patch applied')
print('Edited:',p)
print('Backup:',backup)
print('Movement send: 5Hz | Remote stale cleanup: 3.5s')
