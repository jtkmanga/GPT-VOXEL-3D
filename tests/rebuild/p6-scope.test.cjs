'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const P5='0200876db8a6d26c6ce372264c37bfbdca29262c';
test('P6 retains canonical physics, economy, catalog, Firebase verifier and wire schemas from verified P5', () => {
  for (const file of ['src/shared/config.mjs','src/shared/catalog.mjs','src/shared/movement.mjs',
    'src/shared/protocol.mjs','src/worker/movement.mjs','src/worker/world.mjs','src/worker/economy.mjs',
    'src/worker/firebase-auth.mjs','src/worker/security.mjs','src/worker/router.mjs','src/worker/http.mjs',
    'wrangler.jsonc','worker.js']) {
    assert.equal(fs.readFileSync(file,'utf8'),execFileSync('git',['show',`${P5}:${file}`],{encoding:'utf8'}),file);
  }
});

