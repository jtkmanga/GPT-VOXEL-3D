'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const P6='33ace23c05875734eda909973b446a376bf307ae';
test('P7 preserves verified P6 Firebase, packet/session fencing, authored physics and economic transactions',()=>{
  for(const file of ['src/shared/config.mjs','src/shared/catalog.mjs','src/shared/protocol.mjs',
    'src/shared/movement.mjs','src/worker/firebase-auth.mjs','src/worker/security.mjs',
    'src/worker/sessions.mjs','src/worker/room-security.mjs','src/worker/movement.mjs',
    'src/worker/world.mjs','src/worker/economy.mjs','src/worker/spatial.mjs',
    'src/worker/zone-room.mjs','src/worker/zone-routing.mjs','src/worker/zone-visibility.mjs',
    'wrangler.jsonc','worker.js'])
    assert.equal(fs.readFileSync(file,'utf8'),execFileSync('git',['show',`${P6}:${file}`],{encoding:'utf8'}),file);
});
