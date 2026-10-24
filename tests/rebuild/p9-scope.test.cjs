'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const P8 = '04327fd32047068ba194c5132a32da34cadf5b58';
const original = file => execFileSync('git', ['show', `${P8}:${file}`], { encoding: 'utf8' });

test('P9 preserves P8 production configuration/client and all authoritative core modules', () => {
  const files = ['wrangler.jsonc', 'worker.js', 'index.html', 'src/shared/config.mjs',
    'src/shared/catalog.mjs', 'src/shared/protocol.mjs', 'src/shared/movement.mjs',
    'src/worker/firebase-auth.mjs', 'src/worker/security.mjs', 'src/worker/sessions.mjs',
    'src/worker/room-security.mjs', 'src/worker/movement.mjs', 'src/worker/world.mjs',
    'src/worker/economy.mjs', 'src/worker/game-room.mjs', 'src/worker/zone-room.mjs',
    'src/worker/spatial.mjs', 'src/worker/zone-routing.mjs', 'src/worker/zone-visibility.mjs',
    'src/worker/payment-events.mjs', 'src/worker/vip-store.mjs', 'src/client/entry.mjs'];
  for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), original(file), file);
});

test('P9 retains every original P0-P8 behavioral/security test unchanged', () => {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', P8, 'tests/rebuild'],
    { encoding: 'utf8' }).trim().split('\n').filter(file => file.endsWith('.test.cjs') ||
      file.endsWith('p1-browser.py') || file.endsWith('run-legacy.cjs'));
  assert.ok(files.length > 20);
  for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), original(file), file);
});
