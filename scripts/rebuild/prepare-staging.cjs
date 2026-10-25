'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, STAGING_ROOT, scaffoldConfig, assertIgnoredOutput, stagingModule, varsForManifest,
  validateStagingWrangler, assertStagingAssetInventory, validateStagingHtml } = require('./staging-options.cjs');

async function prepareStaging({ configFile, unconfigured = false,
  output = path.join(STAGING_ROOT, 'prepared'), allowTest = false } = {}) {
  if (!!configFile === !!unconfigured) throw Error('Choose one public manifest or an explicit unconfigured scaffold');
  output = assertIgnoredOutput(output, { directory: true });
  const { validateStagingPublicConfig, STAGING_UNCONFIGURED } = await stagingModule();
  const manifest = unconfigured ? STAGING_UNCONFIGURED : validateStagingPublicConfig(
    JSON.parse(fs.readFileSync(path.resolve(configFile), 'utf8')), { allowTest });
  const { buildStagingClient } = require('./build-staging-client.cjs');
  const html = await buildStagingClient(manifest, { allowTest });
  validateStagingHtml(html, { manifest: unconfigured ? undefined : manifest });
  const wrangler = scaffoldConfig();
  const destination = path.join(output, 'wrangler.jsonc');
  wrangler.main = path.relative(output, path.join(ROOT, 'worker.js'));
  wrangler.assets.directory = './assets';
  if (!unconfigured) { wrangler.name = manifest.workerName; wrangler.vars = varsForManifest(manifest); }
  await validateStagingWrangler(wrangler, destination, { allowUnconfigured: unconfigured, allowTest });
  // Check all output paths before any write; never create a deployable file in
  // source, another tree, or an existing symlink's target.
  const assets = assertIgnoredOutput(path.join(output, 'assets'), { directory: true });
  assertIgnoredOutput(destination);
  assertIgnoredOutput(path.join(assets, 'index.html'));
  assertStagingAssetInventory(assets, { allowEmpty: true });
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'index.html'), html);
  fs.writeFileSync(destination, JSON.stringify(wrangler, null, 2) + '\n');
  return Object.freeze({ configFile: destination, assets, configured: !unconfigured });
}
async function main() {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const option = process.argv[index];
    if (option === '--config' && process.argv[index + 1]) options.configFile = path.resolve(process.argv[++index]);
    else if (option === '--out' && process.argv[index + 1]) options.output = path.resolve(process.argv[++index]);
    else if (option === '--unconfigured') options.unconfigured = true;
    else throw Error('Usage: prepare-staging.cjs (--config public-manifest.json | --unconfigured) [--out work/staging/prepared]');
  }
  const result = await prepareStaging(options);
  console.log(`PASS prepared ${result.configured ? 'configured' : 'disabled'} staging artifacts under ignored work/staging; no external operation performed`);
}
if (require.main === module) main().catch((error) => {
  // Validator errors are deliberately value-free. Expose only a bounded
  // reason so CI can diagnose staging configuration without printing the
  // manifest, Firebase public key, or any privileged secret.
  const reason = String(error?.message || 'unknown validation failure')
    .replace(/[\r\n]+/g, ' ').slice(0, 180);
  console.error(`FAIL staging preparation: ${reason} (configuration values withheld)`);
  process.exitCode = 1;
});
module.exports = { prepareStaging };
