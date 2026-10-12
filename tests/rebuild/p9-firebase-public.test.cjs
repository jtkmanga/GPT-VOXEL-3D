'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, STAGING_ROOT, stagingModule } = require('../../scripts/rebuild/staging-options.cjs');
const { checkStagingFirebase } = require('../../scripts/rebuild/check-staging-firebase.cjs');

const fixture = () => ({ apiKey: 'AIza' + 'x'.repeat(35),
  authDomain: 'voxel-staging-public.firebaseapp.com', projectId: 'voxel-staging-public',
  appId: '1:123456:web:abc123def456' });
const cli = input => spawnSync(process.execPath,
  [path.join(ROOT, 'scripts/rebuild/check-staging-firebase.cjs'), '--config', input],
  { cwd: ROOT, encoding: 'utf8' });
async function temporary(run) {
  fs.mkdirSync(STAGING_ROOT, { recursive: true });
  const folder = fs.mkdtempSync(path.join(STAGING_ROOT, 'p9-firebase-public-test-'));
  try { return await run(folder); }
  finally { fs.rmSync(folder, { recursive: true, force: true }); }
}
function write(folder, value, name = 'public.json') {
  const file = path.join(folder, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test('P9 standalone Firebase validation accepts exactly four real-format public fields and freezes the result', async () => {
  const { validateStagingFirebasePublicConfig } = await stagingModule();
  const input = fixture();
  const result = validateStagingFirebasePublicConfig(input);
  assert.deepEqual(result, input);
  assert.deepEqual(Object.keys(result).sort(), ['apiKey', 'appId', 'authDomain', 'projectId']);
  assert.ok(Object.isFrozen(result));
  assert.notEqual(result, input);
  assert.throws(() => { result.projectId = 'modified-staging'; }, TypeError);
  assert.equal(input.projectId, 'voxel-staging-public');
});

test('P9 standalone Firebase validation rejects missing and malformed public fields', async () => {
  const { validateStagingFirebasePublicConfig: validate } = await stagingModule();
  for (const field of Object.keys(fixture())) {
    const input = fixture(); delete input[field];
    assert.throws(() => validate(input), /Invalid|match/);
  }
  for (const [field, value] of [['apiKey', 'AIza' + 'x'.repeat(34)], ['apiKey', 123],
    ['apiKey', 'synthetic-public-staging-key'], ['appId', '1:123456:android:abc123def456'],
    ['appId', '1:123456:web:NOTHEX12'], ['appId', '1:123456:web:abc'],
    ['projectId', 'STAGING-project'], ['projectId', 'a'.repeat(31)],
    ['authDomain', 'https://voxel-staging-public.firebaseapp.com']]) {
    assert.throws(() => validate({ ...fixture(), [field]: value }), /Invalid|match|staging/);
  }
});

test('P9 standalone Firebase validation rejects production project, public API key and app identifiers', async () => {
  const { validateStagingFirebasePublicConfig: validate } = await stagingModule();
  const productionProject = { ...fixture(), projectId: 'lucky-game-6936b',
    authDomain: 'lucky-game-6936b.firebaseapp.com' };
  assert.throws(() => validate(productionProject), /staging/);
  const productionKey = ['AI', 'za', 'SyCwn4rJ48I_bsVI2Ez59szQJubShvhO1SE'].join('');
  assert.throws(() => validate({ ...fixture(), apiKey: productionKey }), /production/);
  assert.throws(() => validate({ ...fixture(), appId: '1:541211602508:web:abc123def456' }), /production/);
});

test('P9 standalone Firebase validation requires the exact staging project auth domain', async () => {
  const { validateStagingFirebasePublicConfig: validate } = await stagingModule();
  for (const authDomain of ['other-staging-project.firebaseapp.com',
    'voxel-staging-public.firebaseapp.com.attacker.invalid',
    'voxel-staging-public.firebaseapp.com/', 'voxel-staging-public.web.app']) {
    assert.throws(() => validate({ ...fixture(), authDomain }), /match/);
  }
});

test('P9 standalone Firebase validation rejects unrelated and privileged properties and unusual object types', async () => {
  const { validateStagingFirebasePublicConfig: validate } = await stagingModule();
  for (const field of ['storageBucket', 'measurementId', 'adminCredential', 'private_key', 'client_secret']) {
    assert.throws(() => validate({ ...fixture(), [field]: 'not-a-public-field-marker' }), /fields/);
  }
  for (const input of [null, [], 'firebase', new (class FirebaseConfig {})()]) {
    assert.throws(() => validate(input), /fields/);
  }
  const nullPrototype = Object.assign(Object.create(null), fixture());
  assert.deepEqual(validate(nullPrototype), fixture());
});

test('P9 extracted Firebase validation preserves optional sender matching for existing complete manifests', async () => {
  const { validateStagingFirebasePublicConfig: validate } = await stagingModule();
  const input = { ...fixture(), messagingSenderId: '123456' };
  assert.deepEqual(validate(input), input);
  assert.throws(() => validate({ ...input, messagingSenderId: '234567' }), /same staging project/);
  assert.throws(() => validate({ ...input, messagingSenderId: 123456 }), /Invalid/);
  assert.throws(() => validate({ ...input, messagingSenderId: '541211602508' }), /production/);
});

test('P9 valid independent Firebase fields do not authorize an incomplete staging Worker manifest', async () => {
  const { validateStagingFirebasePublicConfig, validateStagingPublicConfig } = await stagingModule();
  const firebase = validateStagingFirebasePublicConfig(fixture());
  const input = { environment: 'staging', firebase, authMode: 'popup' };
  assert.throws(() => validateStagingPublicConfig(input), /Worker name/);
  assert.throws(() => validateStagingPublicConfig({ ...input,
    workerName: 'gpt-voxel-3d-staging-public-test' }), /HTTPS origin/);
});

test('P9 four-field file check accepts public-only input, freezes it and CLI reports no configuration values', async () => {
  await temporary(async folder => {
    const input = write(folder, fixture());
    const result = await checkStagingFirebase(input);
    assert.deepEqual(result, fixture());
    assert.ok(Object.isFrozen(result));
    const command = cli(input);
    assert.equal(command.status, 0, command.stderr);
    assert.match(command.stdout, /PASS four-field public Firebase syntax\/isolation/);
    assert.match(command.stdout, /full Worker configuration and live sign-in remain unverified/);
    for (const value of Object.values(fixture())) assert.ok(!`${command.stdout}${command.stderr}`.includes(value));
    assert.equal(command.stderr, '');
  });
});

test('P9 four-field file check rejects optional sender, storage, measurement and private fields even when otherwise valid', async () => {
  await temporary(async folder => {
    for (const [field, value] of [['messagingSenderId', '123456'],
      ['storageBucket', 'voxel-staging-public.firebasestorage.app'],
      ['measurementId', 'G-TEST'], ['adminCredential', 'sensitive-input-marker'],
      ['private_key', 'sensitive-input-marker']]) {
      const input = write(folder, { ...fixture(), [field]: value });
      await assert.rejects(checkStagingFirebase(input), /unexpected or missing/);
      const command = cli(input);
      assert.equal(command.status, 1);
      assert.match(command.stderr, /values deliberately withheld/);
      assert.ok(!`${command.stdout}${command.stderr}`.includes(value));
      assert.ok(!`${command.stdout}${command.stderr}`.includes(fixture().apiKey));
    }
  });
});

test('P9 four-field file check and CLI never accept synthetic test credentials or test bypass options', async () => {
  await temporary(async folder => {
    const input = write(folder, { ...fixture(), apiKey: 'synthetic-public-staging-key' });
    await assert.rejects(checkStagingFirebase(input), /Invalid public Firebase API key/);
    const command = cli(input);
    assert.equal(command.status, 1);
    assert.ok(!`${command.stdout}${command.stderr}`.includes('synthetic-public-staging-key'));
    const withFlag = spawnSync(process.execPath,
      [path.join(ROOT, 'scripts/rebuild/check-staging-firebase.cjs'), '--config', input, '--allow-test'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.equal(withFlag.status, 1);
  });
});

test('P9 four-field CLI suppresses malformed JSON payloads and refuses incomplete fields', async () => {
  await temporary(async folder => {
    const input = path.join(folder, 'malformed.json');
    fs.writeFileSync(input, '{ malformed-private-input-marker');
    await assert.rejects(checkStagingFirebase(input), SyntaxError);
    const malformed = cli(input);
    assert.equal(malformed.status, 1);
    assert.ok(!`${malformed.stdout}${malformed.stderr}`.includes('malformed-private-input-marker'));
    const missing = fixture(); delete missing.appId;
    write(folder, missing, 'malformed.json');
    await assert.rejects(checkStagingFirebase(input), /unexpected or missing/);
  });
});

test('P9 four-field file check rejects oversized files, symbolic links, hard links and repository paths', async () => {
  await temporary(async folder => {
    const oversized = write(folder, fixture());
    fs.appendFileSync(oversized, ' '.repeat(8192));
    await assert.rejects(checkStagingFirebase(oversized), /bounded regular/);
    const actual = write(folder, fixture(), 'actual.json');
    const symbolic = path.join(folder, 'symbolic.json');
    fs.symlinkSync(actual, symbolic);
    await assert.rejects(checkStagingFirebase(symbolic), /symbolic link/);
    const hard = path.join(folder, 'hard.json');
    fs.linkSync(actual, hard);
    await assert.rejects(checkStagingFirebase(hard), /hard links/);
    await assert.rejects(checkStagingFirebase(path.join(ROOT, 'package.json')), /ignored/);
  });
});
