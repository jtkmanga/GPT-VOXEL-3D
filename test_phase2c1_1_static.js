#!/usr/bin/env node
'use strict';

const fs = require('fs');

const htmlPath = process.argv[2] || 'index_phase2c1_1_smooth.html';
const workerPath = process.argv[3] || 'worker_phase2c1_1_smooth.js';

const html = fs.readFileSync(htmlPath, 'utf8');
const worker = fs.readFileSync(workerPath, 'utf8');

let failed = false;

function check(name, ok) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
  if (!ok) failed = true;
}

check('client smooth marker', /FREE_10K_PHASE2C1_1_SMOOTH_HANDOFF/.test(html));
check('worker smooth marker', /FREE_10K_PHASE2C1_1_SMOOTH_HANDOFF/.test(worker));
check('client sends handoff_resume', /type:\s*['"]handoff_resume['"]/.test(html));
check('client waits for handoff_resumed', /case\s+['"]handoff_resumed['"]/.test(html));
check('client handles resume error', /case\s+['"]handoff_resume_error['"]/.test(html));
check('client target resume helper', /secureResumeHandoffOnTarget/.test(html));
check('worker dispatches handoff_resume', /m\?\.type===['"]handoff_resume['"]/.test(worker));
check('worker validates handoff resume', /async handleHandoffResume/.test(worker));
check('worker preserves createdAt', /createdAt:Number\(row\.created_at\)/.test(worker));
check('worker zone-validates resume', /zoneFromPosition\(x,z\)!==p\.zoneId/.test(worker));

const handoffStart = html.indexOf('async function secureBeginZoneHandoff(message)');
const handoffEnd = html.indexOf('async function secureConnectGameSocket()', handoffStart);
const handoff = handoffStart >= 0 && handoffEnd > handoffStart
  ? html.slice(handoffStart, handoffEnd)
  : '';

check('handoff function found', Boolean(handoff));
check('success path does not pause whole game',
  !/const wasPaused/.test(handoff) &&
  !/secureHandoffInProgress\s*=\s*true;\s*state\.isPaused\s*=\s*true/.test(handoff)
);
check('old socket closes after target resume',
  /await secureResumeHandoffOnTarget\(targetSocket\)[\s\S]*secureCloseSocket\(oldSocket/.test(handoff)
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
  console.error('RESULT: Phase 2C1.1 static validation FAILED');
  process.exit(1);
}

console.log('RESULT: Phase 2C1.1 static validation PASSED');
