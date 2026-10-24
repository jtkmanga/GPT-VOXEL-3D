'use strict';
// Offline public-field validation only; no Google/Cloudflare calls or deployment.
const fs = require('node:fs');
const { assertIgnoredOutput, exactKeys, stagingModule } = require('./staging-options.cjs');

async function checkStagingFirebase(configFile) {
  configFile = assertIgnoredOutput(configFile);
  const stat = fs.lstatSync(configFile);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192) {
    throw Error('Public Firebase configuration must be a bounded regular file');
  }
  const value = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  exactKeys(value, ['apiKey', 'authDomain', 'projectId', 'appId'], 'four-field public Firebase');
  const { validateStagingFirebasePublicConfig } = await stagingModule();
  // No allowTest: actual public fields must meet the existing strict rules.
  return validateStagingFirebasePublicConfig(value);
}

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') {
    throw Error('Usage: check-staging-firebase.cjs --config work/staging/firebase-public.json');
  }
  await checkStagingFirebase(process.argv[3]);
  console.log('PASS four-field public Firebase syntax/isolation; full Worker configuration and live sign-in remain unverified');
}
if (require.main === module) main().catch(() => {
  console.error('FAIL public staging Firebase configuration (values deliberately withheld)');
  process.exitCode = 1;
});
module.exports = { checkStagingFirebase };
