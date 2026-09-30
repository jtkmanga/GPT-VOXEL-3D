#!/usr/bin/env node
'use strict';

const fs = require('fs');

const target = process.argv[2] || 'index_phase2c1.html';
const html = fs.readFileSync(target, 'utf8');

const checks = [
  ['Phase 2C1 marker', /FREE_10K_PHASE2C1_CLIENT/],
  ['zoned WebSocket base', /SECURE_WORKER_WS_BASE/],
  ['zone query connection', /\?zone=\$\{encodeURIComponent\(normalized\)\}/],
  ['zone_change handler', /case\s+['"]zone_change['"]/],
  ['secure handoff function', /async function secureBeginZoneHandoff/],
  ['handoff token auth', /authMessage\.handoffToken/],
  ['ghost_snapshot handler', /case\s+['"]ghost_snapshot['"]/],
  ['ghost snapshot reconciler', /function secureReplaceGhostSnapshot/],
  ['server-authoritative collect', /type:\s*['"]collect['"]/],
  ['server-authoritative lucky box collect', /type:\s*['"]collect_box['"]/],
  ['server-authoritative lucky box spin', /type:\s*['"]spin_box['"]/],
];

let failed = false;
for (const [name, rx] of checks) {
  const ok = rx.test(html);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
  if (!ok) failed = true;
}

if (/new WebSocket\(SECURE_WORKER_WS_URL\)/.test(html)) {
  console.log('FAIL old unzoned WebSocket connector still present');
  failed = true;
} else {
  console.log('OK   old unzoned WebSocket connector removed');
}

// Parse the large inline game script without executing browser APIs.
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].pop();
if (!inline) {
  console.log('FAIL inline game script not found');
  failed = true;
} else {
  try {
    new Function(inline[1]);
    console.log('OK   inline JavaScript syntax');
  } catch (err) {
    console.log('FAIL inline JavaScript syntax:', err.message);
    failed = true;
  }
}

if (failed) {
  console.error('RESULT: Phase 2C1 static validation FAILED');
  process.exit(1);
}
console.log('RESULT: Phase 2C1 static validation PASSED');
