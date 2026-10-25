'use strict';
// P8 measurements belong to their genuine P8 source, never a newer runtime.
// Verify the original source fingerprint/checker against a fresh Git archive.
// All active P0-P8 behavioral suites still run on P9 in the full regression gate.
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const P8 = '04327fd32047068ba194c5132a32da34cadf5b58';
function requireSuccess(result) {
  if (result.error || result.status !== 0) throw Error('Preserved P8 load/source evidence failed');
}
const parent = path.join(ROOT, 'work/checkpoints/p8-evidence');
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(path.join(parent, 'run-'));
try {
  const archive = spawnSync('git', ['archive', '--format=tar', P8], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  requireSuccess(archive);
  requireSuccess(spawnSync('tar', ['-xf', '-', '-C', directory], { input: archive.stdout }));
  requireSuccess(spawnSync(process.execPath, ['scripts/rebuild/load-evidence.cjs'], { cwd: directory, stdio: 'inherit' }));
  console.log('PASS preserved P8 load evidence against verified P8; no P9 capacity claim');
} catch (_) { console.error('FAIL preserved P8 load/source evidence'); process.exitCode = 1; }
finally { rmSync(directory, { recursive: true, force: true }); }
