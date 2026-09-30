#!/usr/bin/env node
'use strict';

const fs = require('fs');
const htmlPath = process.argv[2] || 'index_phase2c2_multiplayer_fix.html';
const workerPath = process.argv[3] || 'worker_phase2c2_multiplayer_fix.js';

const html = fs.readFileSync(htmlPath, 'utf8');
const worker = fs.readFileSync(workerPath, 'utf8');
let failed = false;

function check(name, ok) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
  if (!ok) failed = true;
}

check('client Phase 2C2 marker', /FREE_10K_PHASE2C2_MULTIPLAYER_FIX/.test(html));
check('worker Phase 2C2 marker', /FREE_10K_PHASE2C2_MULTIPLAYER_FIX/.test(worker));

check('client sends selected player name during auth',
  /type:\s*['"]auth['"][\s\S]{0,160}name:\s*String\(state\.playerName/.test(html)
);
check('worker updates persistent nickname',
  /ON CONFLICT\(uid\) DO UPDATE SET nickname=excluded\.nickname/.test(worker)
);
check('worker returns nickname in bootstrap', /nickname,\s*\n\s*score,/.test(worker));
check('same-zone player packets contain name',
  /name:normalizePlayerName\(p\.nickname,'Player'\)/.test(worker)
);
check('cross-zone ghost snapshots preserve name',
  /players\.push\(\{id,x,y,z,r,name:normalizePlayerName/.test(worker)
);

check('client can cancel handoff after stepping back',
  /type:\s*['"]handoff_cancel['"]/.test(html)
);
check('worker handles handoff_cancel',
  /m\?\.type===['"]handoff_cancel['"]/.test(worker)
);
check('handoff resume window increased',
  /deadline:now\+9000/.test(worker) && /Math\.min\(9,Math\.max/.test(worker)
);

check('client hides coin immediately on contact',
  /coin\.active\s*=\s*false;[\s\S]{0,100}coin\.mesh\.visible\s*=\s*false;/.test(html)
);
check('collect packet includes fresh position',
  /type:\s*['"]collect['"][\s\S]{0,220}x:\s*Math\.round\(playerPos\.x/.test(html)
);
check('worker validates fresh collect position',
  /A collect can happen between 5Hz movement packets/.test(worker)
);
check('collector receives direct authoritative result',
  /type:\s*['"]coin_collect_result['"]/.test(worker) &&
  /case\s+['"]coin_collect_result['"]/.test(html)
);
check('coin fan-out no longer blocks collector response',
  /this\.ctx\.waitUntil\(this\.sendZoneEvent\(affected,event\)\)/.test(worker)
);

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) {
  check('inline game JavaScript found', false);
} else {
  try {
    new Function(scripts[scripts.length - 1][1]);
    check('inline game JavaScript syntax', true);
  } catch (err) {
    console.error(err.message);
    check('inline game JavaScript syntax', false);
  }
}

if (failed) {
  console.error('RESULT: Phase 2C2 static validation FAILED');
  process.exit(1);
}
console.log('RESULT: Phase 2C2 static validation PASSED');
