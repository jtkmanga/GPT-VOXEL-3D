'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { ROOT, STAGING_ROOT, PRODUCTION_MAIN, scaffoldConfig, varsForManifest,
  validateStagingWrangler, assertIgnoredOutput, assertStagingAssetInventory,
  validateStagingHtml } = require('../../scripts/rebuild/staging-options.cjs');
const { checkStaging } = require('../../scripts/rebuild/check-staging.cjs');
const { prepareStaging } = require('../../scripts/rebuild/prepare-staging.cjs');
const scaffoldFile = path.join(ROOT, 'wrangler.staging.jsonc');
const fresh = () => scaffoldConfig();
const fixture = () => ({ environment: 'staging', workerName: 'gpt-voxel-3d-staging-config-test',
  workerOrigin: 'https://gpt-voxel-3d-staging-config-test.invalid', authMode: 'popup',
  firebase: { apiKey: 'synthetic-public-staging-key', projectId: 'voxel-staging-test',
    authDomain: 'voxel-staging-test.firebaseapp.com', appId: '1:123456:web:abc123de', messagingSenderId: '123456' } });
function configured() {
  const value = fresh(), manifest = fixture();
  value.name = manifest.workerName; value.vars = varsForManifest(manifest);
  return value;
}
const validate = value => validateStagingWrangler(value, scaffoldFile, { allowTest: true });

test('P9 staging scaffold is explicitly disabled, isolated and leaves production config unchanged', async () => {
  const result = await checkStaging(scaffoldFile, { allowUnconfigured: true });
  assert.equal(result.configured, false);
  assert.equal(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8'),
    execFileSync('git', ['show', `${PRODUCTION_MAIN}:wrangler.jsonc`], { cwd: ROOT, encoding: 'utf8' }));
  await assert.rejects(checkStaging(scaffoldFile), /missing/);
});
test('P9 prepared configuration coherently binds server, client origin, Firebase and both new DO classes', async () => {
  const result = await validate(configured());
  assert.equal(result.configured, true);
  assert.deepEqual(result.manifest.firebase, fixture().firebase);
  assert.equal(result.manifest.workerOrigin, fixture().workerOrigin);
  assert.equal(result.assets, path.join(STAGING_ROOT, 'assets'));
});
test('P9 fictional test endpoint cannot be validated as actual external staging configuration', async () => {
  await assert.rejects(validateStagingWrangler(configured(), scaffoldFile), /origin|Worker|staging|URL/i);
});
test('P9 staging config rejects routes, account IDs and production resource bindings', async () => {
  for (const [key, value] of Object.entries({ routes: [{ pattern: 'production.example/*' }],
    account_id: 'existing-account', kv_namespaces: [{ binding: 'CACHE', id: 'existing' }],
    d1_databases: [{ binding: 'DB', database_id: 'existing' }], r2_buckets: [{ binding: 'BUCKET', bucket_name: 'existing' }],
    services: [{ binding: 'PRODUCTION', service: 'voxel-run-v2-demo' }], env: { production: {} } })) {
    const next = configured(); next[key] = value;
    await assert.rejects(validate(next), /unexpected/);
  }
});
test('P9 staging config rejects foreign Worker DO namespaces, IDs and modified migrations', async () => {
  for (const field of ['script_name', 'environment', 'namespace_id']) {
    const next = configured(); next.durable_objects.bindings[0][field] = 'production';
    await assert.rejects(validate(next), /Durable Objects/);
  }
  const next = configured(); next.migrations[0].renamed_classes = [{ from: 'Old', to: 'GameRoom' }];
  await assert.rejects(validate(next), /Durable Objects/);
});
test('P9 staging config rejects production Worker name and mismatched app environment', async () => {
  const next = configured(); next.name = next.vars.STAGING_WORKER_NAME = 'voxel-run-v2-demo';
  await assert.rejects(validate(next), /Worker|worker|staging/i);
  next.name = next.vars.STAGING_WORKER_NAME = fixture().workerName;
  next.vars.APP_ENV = 'production';
  await assert.rejects(validate(next), /identity/);
});
test('P9 staging config rejects production Firebase project and browser/server project mismatch', async () => {
  const next = configured(); const fb = fixture().firebase;
  fb.projectId = 'lucky-game-6936b'; fb.authDomain = 'lucky-game-6936b.firebaseapp.com';
  next.vars.FIREBASE_PUBLIC_CONFIG = JSON.stringify(fb); next.vars.FIREBASE_PROJECT_ID = fb.projectId;
  await assert.rejects(validate(next), /project|Firebase|staging/i);
  const mismatch = configured(); mismatch.vars.FIREBASE_PROJECT_ID = 'another-staging-project';
  await assert.rejects(validate(mismatch), /crossover/);
});
test('P9 staging config rejects mixed origins, credentials and unknown Firebase public properties', async () => {
  const next = configured(); next.vars.ALLOWED_ORIGIN = 'https://other.invalid';
  await assert.rejects(validate(next), /crossover/);
  const credential = configured(); credential.vars.UNEXPECTED_SERVER_CREDENTIAL = 'should-not-be-a-public-variable';
  await assert.rejects(validate(credential), /unexpected/);
  const fb = configured(); const publicConfig = JSON.parse(fb.vars.FIREBASE_PUBLIC_CONFIG);
  publicConfig.adminCredential = 'not-public'; fb.vars.FIREBASE_PUBLIC_CONFIG = JSON.stringify(publicConfig);
  await assert.rejects(validate(fb), /field|public|configuration/i);
});
test('P9 staging config cannot enable legacy or real payment mode', async () => {
  for (const mode of ['live', 'sandbox-provider-not-selected', 'legacy-slip']) {
    const next = configured(); next.vars.PAYMENT_MODE = mode;
    await assert.rejects(validate(next), /payment/);
  }
});
test('P9 staging config cannot bypass Worker guard or serve authored production client assets', async () => {
  const next = configured(); next.assets.run_worker_first = false;
  await assert.rejects(validate(next), /guard/);
  next.assets.run_worker_first = true; next.assets.directory = '.';
  await assert.rejects(validate(next), /ignored/);
  next.assets.directory = 'work/staging/assets'; next.main = 'work/other-worker.js';
  await assert.rejects(validate(next), /entrypoint/);
});
test('P9 staging config rejects partial or malformed public configuration', async () => {
  const partial = fresh(); partial.vars.FIREBASE_PROJECT_ID = 'voxel-staging-test';
  await assert.rejects(validateStagingWrangler(partial, scaffoldFile, { allowUnconfigured: true }), /invalid/);
  const malformed = configured(); malformed.vars.FIREBASE_PUBLIC_CONFIG = '{';
  await assert.rejects(validate(malformed), /invalid/);
});
test('P9 artifact outputs reject repository paths and symbolic-link escapes including dangling links', () => {
  assert.throws(() => assertIgnoredOutput(path.join(ROOT, 'index.html')), /ignored/);
  assert.throws(() => assertIgnoredOutput(path.join(STAGING_ROOT, '../escape')), /ignored/);
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const folder = fs.mkdtempSync(path.join(STAGING_ROOT, 'p9-path-test-'));
  try {
    fs.symlinkSync(ROOT, path.join(folder, 'link'));
    fs.symlinkSync(path.join(folder, 'absent-target'), path.join(folder, 'dangling'));
    assert.throws(() => assertIgnoredOutput(path.join(folder, 'link/index.html')), /symbolic/);
    assert.throws(() => assertIgnoredOutput(path.join(folder, 'dangling/index.html')), /symbolic/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
test('P9 preparation writes only ignored offline artifacts and preserves original client and production config', async () => {
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const folder = fs.mkdtempSync(path.join(STAGING_ROOT, 'p9-prepare-test-'));
  const production = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'));
  const client = fs.readFileSync(path.join(ROOT, 'index.html'));
  const manifestPath = path.join(folder, 'public.json');
  fs.writeFileSync(manifestPath, JSON.stringify(fixture()));
  try {
    const result = await prepareStaging({ configFile: manifestPath, output: path.join(folder, 'result'), allowTest: true });
    assert.equal(result.configured, true);
    const config = JSON.parse(fs.readFileSync(result.configFile, 'utf8'));
    assert.equal((await validateStagingWrangler(config, result.configFile, { allowTest: true })).configured, true);
    const html = fs.readFileSync(path.join(result.assets, 'index.html'), 'utf8');
    assert.ok(html.includes('voxel-staging-test'));
    assert.ok(html.includes(fixture().workerOrigin));
    assert.ok(!html.includes('lucky-game-6936b'));
    assert.deepEqual(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc')), production);
    assert.deepEqual(fs.readFileSync(path.join(ROOT, 'index.html')), client);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
test('P9 preparation supports an explicitly disabled artifact without inventing external public configuration', async () => {
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const folder = fs.mkdtempSync(path.join(STAGING_ROOT, 'p9-disabled-test-'));
  try {
    const result = await prepareStaging({ unconfigured: true, output: path.join(folder, 'result') });
    assert.equal(result.configured, false);
    assert.equal((await checkStaging(result.configFile, { allowUnconfigured: true })).configured, false);
    const html = fs.readFileSync(path.join(result.assets, 'index.html'), 'utf8');
    assert.ok(!html.includes('lucky-game-6936b'));
    assert.ok(!html.includes('voxel-run-v2-demo'));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
test('P9 invalid preparation fails before creating output and CLI suppresses supplied values', async () => {
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const folder = fs.mkdtempSync(path.join(STAGING_ROOT, 'p9-invalid-test-'));
  try {
    const input = path.join(folder, 'public.json');
    const output = path.join(folder, 'result');
    fs.writeFileSync(input, JSON.stringify({ shouldNeverAppearInLogs: 'arbitrary-user-input-marker' }));
    await assert.rejects(prepareStaging({ configFile: input, output }));
    assert.ok(!fs.existsSync(output));
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/rebuild/prepare-staging.cjs'), '--config', input,
      '--out', output], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('arbitrary-user-input-marker'));
    assert.ok(!fs.existsSync(output));
    await assert.rejects(prepareStaging({ unconfigured: true, output: ROOT }), /ignored/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
test('P9 staging inventory permits only the generated index and rejects stray secrets, directories and links', () => {
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const folder = fs.mkdtempSync(path.join(STAGING_ROOT, 'p9-inventory-test-'));
  const assets = path.join(folder, 'assets');
  try {
    assert.equal(assertStagingAssetInventory(assets), null);
    assert.throws(() => assertStagingAssetInventory(assets, { requireAssets: true }), /missing/);
    fs.mkdirSync(assets); fs.writeFileSync(path.join(assets, 'index.html'), '<!doctype html>');
    assert.equal(assertStagingAssetInventory(assets), path.join(assets, 'index.html'));
    for (const name of ['.env', 'server-credentials.json', 'old-worker.js']) {
      fs.writeFileSync(path.join(assets, name), 'synthetic marker');
      assert.throws(() => assertStagingAssetInventory(assets), /only/);
      fs.rmSync(path.join(assets, name));
    }
    fs.mkdirSync(path.join(assets, 'nested'));
    assert.throws(() => assertStagingAssetInventory(assets), /only/);
    fs.rmSync(path.join(assets, 'nested'), { recursive: true });
    fs.rmSync(path.join(assets, 'index.html'));
    fs.symlinkSync(path.join(ROOT, 'index.html'), path.join(assets, 'index.html'));
    assert.throws(() => assertStagingAssetInventory(assets), /symbolic/);
    fs.rmSync(path.join(assets, 'index.html'));
    fs.linkSync(path.join(ROOT, 'index.html'), path.join(assets, 'index.html'));
    assert.throws(() => assertStagingAssetInventory(assets), /hard links/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
test('P9 staging HTML scans forbid privileged credentials and production/local references while allowing only its public API key', () => {
  const publicKey = ['AI', 'za', 'Z'.repeat(35)].join('');
  const approved = { firebase: { apiKey: publicKey } };
  assert.equal(validateStagingHtml(`<script>const firebase={apiKey:'${publicKey}'}</script>`, { manifest: approved }), true);
  assert.throws(() => validateStagingHtml(`<script>${publicKey}</script>`), /unapproved/);
  const otherKey = ['AI', 'za', 'Y'.repeat(35)].join('');
  assert.throws(() => validateStagingHtml(`${publicKey} ${otherKey}`, { manifest: approved }), /unapproved/);
  const privilegedName = ['PAYMENT', 'WEBHOOK', 'SECRET'].join('_');
  const privateHeader = ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join('');
  const liveKey = ['sk_', 'live_', 'Z'.repeat(24)].join('');
  for (const marker of [privilegedName, privateHeader, liveKey]) {
    assert.throws(() => validateStagingHtml(`<script>${marker}</script>`), /privileged/);
  }
  for (const marker of ['voxel-run-v2-demo', 'lucky-game-6936b', 'http://localhost:8787', '127.0.0.1', '[::1]']) {
    assert.throws(() => validateStagingHtml(`<script>${marker}</script>`), /production or local/);
  }
});
test('P9 preparation refuses contaminated assets or linked config without deleting or modifying existing files', async () => {
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const folder = fs.mkdtempSync(path.join(STAGING_ROOT, 'p9-contaminated-test-'));
  const assets = path.join(folder, 'assets');
  const production = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'));
  const sentinel = 'existing user artifact';
  try {
    fs.mkdirSync(assets); fs.writeFileSync(path.join(assets, 'index.html'), sentinel);
    fs.writeFileSync(path.join(assets, '.env'), sentinel);
    await assert.rejects(prepareStaging({ unconfigured: true, output: folder }), /only/);
    assert.equal(fs.readFileSync(path.join(assets, '.env'), 'utf8'), sentinel);
    assert.equal(fs.readFileSync(path.join(assets, 'index.html'), 'utf8'), sentinel);
    fs.rmSync(path.join(assets, '.env'));
    fs.linkSync(path.join(ROOT, 'wrangler.jsonc'), path.join(folder, 'wrangler.jsonc'));
    await assert.rejects(prepareStaging({ unconfigured: true, output: folder }), /hard links/);
    assert.deepEqual(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc')), production);
    assert.equal(fs.readFileSync(path.join(assets, 'index.html'), 'utf8'), sentinel);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
test('P9 prepared asset checker requires inventory, rejects tampering and binds exact generated source to config', async () => {
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const folder = fs.mkdtempSync(path.join(STAGING_ROOT, 'p9-artifact-check-test-'));
  try {
    const prepared = await prepareStaging({ unconfigured: true, output: folder });
    const options = { allowUnconfigured: true, requireAssets: true };
    assert.equal((await checkStaging(prepared.configFile, options)).configured, false);
    const index = path.join(prepared.assets, 'index.html');
    const original = fs.readFileSync(index, 'utf8');
    fs.writeFileSync(index, original + '\n<!-- injected change -->');
    await assert.rejects(checkStaging(prepared.configFile, options), /differs/);
    fs.writeFileSync(index, original + `<script>${['SLIP2GO', 'API', 'SECRET'].join('_')}</script>`);
    await assert.rejects(checkStaging(prepared.configFile, options), /privileged/);
    fs.writeFileSync(index, original);
    fs.writeFileSync(path.join(prepared.assets, 'unexpected.txt'), 'marker');
    await assert.rejects(checkStaging(prepared.configFile, options), /only/);
    fs.rmSync(path.join(prepared.assets, 'unexpected.txt'));
    fs.rmSync(prepared.assets, { recursive: true });
    await assert.rejects(checkStaging(prepared.configFile, options), /missing/);
    assert.equal((await checkStaging(prepared.configFile, { allowUnconfigured: true })).configured, false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
