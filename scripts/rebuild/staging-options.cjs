'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '../..');
const STAGING_ROOT = path.join(ROOT, 'work/staging');
const PRODUCTION_MAIN = 'ea9da135ce408663f8905f649034281882295c05';
const SCAFFOLD_NAME = 'gpt-voxel-3d-staging-01';
const VAR_KEYS = ['APP_ENV', 'STAGING_WORKER_NAME', 'STAGING_WORKER_ORIGIN', 'ALLOWED_ORIGIN',
  'FIREBASE_PROJECT_ID', 'FIREBASE_PUBLIC_CONFIG', 'FIREBASE_APP_CHECK_SITE_KEY',
  'FIREBASE_ONLINE_USER_CHECK', 'STAGING_AUTH_MODE', 'PAYMENT_MODE',
  'TWOC2P_SANDBOX_ENABLED', 'TWOC2P_SANDBOX_CHECKOUT_ENABLED', 'TWOC2P_SANDBOX_BACKEND_ENABLED',
  'TWOC2P_SANDBOX_MERCHANT_CAPABILITIES_VERIFIED', 'TWOC2P_SANDBOX_E2E_VERIFIED',
  'TWOC2P_SANDBOX_E2E_TEST_MODE', 'TWOC2P_SANDBOX_MONTHLY_POLICY_VERIFIED',
  'TWOC2P_SANDBOX_BILLING_TIMEZONE', 'TWOC2P_SANDBOX_INITIAL_SEQUENCE_NO',
  'TWOC2P_SANDBOX_MERCHANT_ID'];

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) {
    throw Error(`${label}: unexpected or missing configuration fields`);
  }
}
function below(directory, target) {
  const relative = path.relative(directory, target);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function assertIgnoredOutput(target, { directory = false } = {}) {
  target = path.resolve(target);
  if (!below(STAGING_ROOT, target) || (!directory && target.endsWith(path.sep))) {
    throw Error('Staging output must stay below ignored work/staging/');
  }
  // An ignored symlink must not redirect a local build into the repository or
  // any unrelated external directory. Inspect every already-existing parent.
  let current = target;
  while (current !== ROOT && current !== path.dirname(current)) {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw Error('Staging output cannot traverse a symbolic link');
    if (current === target && stat) {
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw Error('Staging output has an unexpected file type');
      if (stat.isFile() && stat.nlink !== 1) throw Error('Staging output cannot overwrite a file with external hard links');
    }
    current = path.dirname(current);
  }
  return target;
}
function assertStagingAssetInventory(directory, { requireAssets = false, allowEmpty = false } = {}) {
  directory = assertIgnoredOutput(directory, { directory: true });
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if (error.code === 'ENOENT' && !requireAssets) return null;
    throw Error('Staging assets are missing or unreadable');
  }
  if (!stat.isDirectory()) throw Error('Staging assets must be a directory');
  const entries = fs.readdirSync(directory);
  if (entries.length === 0 && allowEmpty) return null;
  if (entries.length !== 1 || entries[0] !== 'index.html') {
    throw Error('Staging assets must contain only the generated index.html');
  }
  const file = assertIgnoredOutput(path.join(directory, 'index.html'));
  const index = fs.lstatSync(file);
  if (!index.isFile() || index.nlink !== 1 || index.size > 4 * 1024 * 1024) {
    throw Error('Staging index must be a bounded regular file with no external hard links');
  }
  return file;
}
function validateStagingHtml(html, { manifest } = {}) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 4 * 1024 * 1024) {
    throw Error('Staging client must be a bounded generated HTML document');
  }
  if (/\b(?:PAYMENT_WEBHOOK_SECRET|SLIP2GO_API_SECRET|private_key|client_secret|payment_secret|api_secret|FIREBASE_ADMIN_PRIVATE_KEY)\b/i.test(html) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(html) ||
      /\b(?:ghp_|github_pat_|sk_live_|rk_live_)[A-Za-z0-9_]{20,}/.test(html)) {
    throw Error('Staging browser asset contains a privileged credential reference');
  }
  for (const key of html.match(/\bAIza[A-Za-z0-9_-]{30,}/g) || []) {
    if (!manifest?.firebase?.apiKey || key !== manifest.firebase.apiKey) {
      throw Error('Staging browser asset contains an unapproved Firebase public key');
    }
  }
  if (/(?:voxel-run-v2-demo|lucky-game-6936b|(?:https?:\/\/)?localhost(?:[:/\s"']|$)|127\.0\.0\.1|\[::1\])/.test(html)) {
    throw Error('Staging browser asset contains a production or local-only reference');
  }
  return true;
}
async function stagingModule() {
  return import(pathToFileURL(path.join(ROOT, 'src/shared/staging.mjs')).href);
}
function scaffoldConfig(configFile = path.join(ROOT, 'wrangler.staging.jsonc')) {
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
}
function varsForManifest(manifest) {
  return {
    APP_ENV: 'staging', STAGING_WORKER_NAME: manifest.workerName,
    STAGING_WORKER_ORIGIN: manifest.workerOrigin, ALLOWED_ORIGIN: manifest.workerOrigin,
    FIREBASE_PROJECT_ID: manifest.firebase.projectId,
    FIREBASE_PUBLIC_CONFIG: JSON.stringify(manifest.firebase),
    FIREBASE_APP_CHECK_SITE_KEY: manifest.appCheck.siteKey,
    FIREBASE_ONLINE_USER_CHECK: 'true',
    STAGING_AUTH_MODE: manifest.authMode, PAYMENT_MODE: 'provider-neutral-test',
    TWOC2P_SANDBOX_ENABLED: 'true', TWOC2P_SANDBOX_CHECKOUT_ENABLED: 'true',
    TWOC2P_SANDBOX_BACKEND_ENABLED: 'true',
    TWOC2P_SANDBOX_MERCHANT_CAPABILITIES_VERIFIED: 'true',
    TWOC2P_SANDBOX_E2E_VERIFIED: 'false', TWOC2P_SANDBOX_E2E_TEST_MODE: 'true',
    TWOC2P_SANDBOX_MONTHLY_POLICY_VERIFIED: 'true',
    TWOC2P_SANDBOX_BILLING_TIMEZONE: 'UTC',
    TWOC2P_SANDBOX_INITIAL_SEQUENCE_NO: '',
    TWOC2P_SANDBOX_MERCHANT_ID: 'JT04'
  };
}
async function validateStagingWrangler(value, configFile, { allowUnconfigured = false, allowTest = false } = {}) {
  configFile = path.resolve(configFile);
  exactKeys(value, ['name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'vars', 'assets',
    'durable_objects', 'migrations'], 'staging Worker');
  if (path.resolve(path.dirname(configFile), value.main || '') !== path.join(ROOT, 'worker.js')) {
    throw Error('Staging entrypoint must be the verified local worker.js');
  }
  if (value.compatibility_date !== '2026-09-27' || value.workers_dev !== true || value.preview_urls !== false) {
    throw Error('Staging runtime or public routing configuration differs from the isolated scaffold');
  }
  exactKeys(value.vars, VAR_KEYS, 'staging vars');
  if (Object.values(value.vars).some(item => typeof item !== 'string')) throw Error('Staging vars must be strings');
  if (value.vars.APP_ENV !== 'staging' || value.vars.PAYMENT_MODE !== 'provider-neutral-test' ||
      value.name !== value.vars.STAGING_WORKER_NAME) throw Error('Staging identity/payment configuration mismatch');
  if (value.vars.FIREBASE_ONLINE_USER_CHECK !== 'true' &&
      value.vars.STAGING_WORKER_ORIGIN !== '') throw Error('Staging online Firebase user check must remain enabled');
  const paymentTestEnabled = value.vars.TWOC2P_SANDBOX_ENABLED === 'true';
  if (paymentTestEnabled && (value.vars.TWOC2P_SANDBOX_CHECKOUT_ENABLED !== 'true' ||
      value.vars.TWOC2P_SANDBOX_BACKEND_ENABLED !== 'true' ||
      value.vars.TWOC2P_SANDBOX_MERCHANT_CAPABILITIES_VERIFIED !== 'true' ||
      value.vars.TWOC2P_SANDBOX_E2E_VERIFIED !== 'false' ||
      value.vars.TWOC2P_SANDBOX_E2E_TEST_MODE !== 'true' ||
      value.vars.TWOC2P_SANDBOX_MONTHLY_POLICY_VERIFIED !== 'true' ||
      value.vars.TWOC2P_SANDBOX_BILLING_TIMEZONE !== 'UTC' ||
      value.vars.TWOC2P_SANDBOX_INITIAL_SEQUENCE_NO !== '' ||
      value.vars.TWOC2P_SANDBOX_MERCHANT_ID !== 'JT04')) {
    throw Error('Staging sandbox payment test configuration mismatch');
  }
  exactKeys(value.assets, ['directory', 'binding', 'run_worker_first'], 'staging assets');
  if (value.assets.binding !== 'ASSETS' || value.assets.run_worker_first !== true ||
      typeof value.assets.directory !== 'string') throw Error('Staging assets must run through the Worker guard');
  const assets = assertIgnoredOutput(path.resolve(path.dirname(configFile), value.assets.directory), { directory: true });
  const expectedBindings = { bindings: [{ name: 'ROOM', class_name: 'GameRoom' }, { name: 'ZONE', class_name: 'ZoneRoom' }] };
  const expectedMigrations = [{ tag: 'v1', new_sqlite_classes: ['GameRoom'] }, { tag: 'v2-zone-room', new_sqlite_classes: ['ZoneRoom'] }];
  if (JSON.stringify(value.durable_objects) !== JSON.stringify(expectedBindings) ||
      JSON.stringify(value.migrations) !== JSON.stringify(expectedMigrations)) {
    throw Error('Staging Durable Objects must be new classes in this Worker namespace only');
  }
  const blank = ['STAGING_WORKER_ORIGIN', 'ALLOWED_ORIGIN', 'FIREBASE_PROJECT_ID',
    'FIREBASE_PUBLIC_CONFIG', 'FIREBASE_APP_CHECK_SITE_KEY'].every(key => value.vars[key] === '');
  if (blank) {
    if (!allowUnconfigured || value.name !== SCAFFOLD_NAME || value.vars.STAGING_AUTH_MODE !== 'popup') {
      throw Error('Staging public configuration is missing; scaffold requires explicit allow-unconfigured');
    }
    return Object.freeze({ configured: false, assets });
  }
  let firebase;
  try { firebase = JSON.parse(value.vars.FIREBASE_PUBLIC_CONFIG); }
  catch { throw Error('Staging Firebase public configuration is invalid'); }
  const { validateStagingPublicConfig } = await stagingModule();
  const manifest = validateStagingPublicConfig({ environment: 'staging', workerName: value.name,
    workerOrigin: value.vars.STAGING_WORKER_ORIGIN, firebase,
    appCheck: { provider: 'recaptcha-enterprise', siteKey: value.vars.FIREBASE_APP_CHECK_SITE_KEY },
    authMode: value.vars.STAGING_AUTH_MODE }, { allowTest });
  if (value.vars.ALLOWED_ORIGIN !== manifest.workerOrigin || value.vars.FIREBASE_PROJECT_ID !== manifest.firebase.projectId) {
    throw Error('Staging browser/server origin or Firebase project crossover');
  }
  return Object.freeze({ configured: true, manifest, assets });
}

module.exports = { ROOT, STAGING_ROOT, PRODUCTION_MAIN, SCAFFOLD_NAME, VAR_KEYS, exactKeys,
  assertIgnoredOutput, assertStagingAssetInventory, validateStagingHtml, stagingModule, scaffoldConfig,
  varsForManifest, validateStagingWrangler };
