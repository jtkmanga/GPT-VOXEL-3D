'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ROOT, PRODUCTION_MAIN, validateStagingWrangler, assertStagingAssetInventory,
  validateStagingHtml, stagingModule } = require('./staging-options.cjs');

async function checkStaging(configFile = path.join(ROOT, 'wrangler.staging.jsonc'), options = {}) {
  const baseline = execFileSync('git', ['show', `${PRODUCTION_MAIN}:wrangler.jsonc`], { cwd: ROOT, encoding: 'utf8' });
  if (fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8') !== baseline) {
    throw Error('Production Wrangler configuration changed');
  }
  const result = await validateStagingWrangler(JSON.parse(fs.readFileSync(configFile, 'utf8')), configFile, options);
  const asset = assertStagingAssetInventory(result.assets, { requireAssets: options.requireAssets === true });
  if (asset) {
    const html = fs.readFileSync(asset, 'utf8');
    validateStagingHtml(html, { manifest: result.manifest });
    const { STAGING_UNCONFIGURED } = await stagingModule();
    const { buildStagingClient } = require('./build-staging-client.cjs');
    if (html !== await buildStagingClient(result.manifest || STAGING_UNCONFIGURED, { allowTest: options.allowTest === true })) {
      throw Error('Staging browser asset differs from its generated source/configuration');
    }
  }
  return result;
}
async function main() {
  let configFile = path.join(ROOT, 'wrangler.staging.jsonc');
  let allowUnconfigured = false;
  let requireAssets = false;
  for (let index = 2; index < process.argv.length; index++) {
    const option = process.argv[index];
    if (option === '--config' && process.argv[index + 1]) configFile = path.resolve(process.argv[++index]);
    else if (option === '--allow-unconfigured') allowUnconfigured = true;
    else if (option === '--require-assets') requireAssets = true;
    else throw Error('Usage: check-staging.cjs [--config path] [--allow-unconfigured] [--require-assets]');
  }
  const result = await checkStaging(configFile, { allowUnconfigured, requireAssets });
  console.log(`PASS staging structural isolation (${result.configured ? 'configured' : 'disabled scaffold'}); production config unchanged; external resource ownership remains unverified`);
}
if (require.main === module) main().catch(() => {
  console.error('FAIL staging configuration isolation; inspect configuration locally, without logging secret values');
  process.exitCode = 1;
});
module.exports = { checkStaging };
