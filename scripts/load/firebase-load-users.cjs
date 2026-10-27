#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { initializeApp, cert, deleteApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const ROOT = path.resolve(__dirname, '../..');
const mode = process.argv[2] || 'self-test';

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
}

function safeWorkPath(value) {
  const file = path.resolve(ROOT, value || 'work/load/firebase-load-users.json');
  const work = path.resolve(ROOT, 'work') + path.sep;
  if (!file.startsWith(work)) throw new Error('TOKEN_FILE must stay under work/');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function loadServiceAccount(expectedProjectId) {
  const raw = String(process.env.FIREBASE_LOADTEST_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) throw new Error('FIREBASE_LOADTEST_SERVICE_ACCOUNT_JSON is required');
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('FIREBASE_LOADTEST_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  if (!value?.project_id || value.project_id !== expectedProjectId)
    throw new Error('Firebase load-test service account project does not match PROJECT_ID');
  if (!value?.client_email || !value?.private_key)
    throw new Error('Firebase load-test service account is incomplete');
  return value;
}

function runTag() {
  const source = String(process.env.LOAD_RUN_TAG ||
    `gha-${process.env.GITHUB_RUN_ID || 'local'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`);
  const safe = source.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 48);
  if (!safe) throw new Error('LOAD_RUN_TAG is invalid');
  return safe;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function allowedReferer() {
  const origin = String(process.env.ORIGIN || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//.test(origin)) throw new Error('ORIGIN must be an https:// URL');
  return origin + '/';
}

async function exchangeAppCheckToken(apiKey) {
  const projectId = String(process.env.PROJECT_ID || '').trim();
  const appId = String(process.env.FIREBASE_APP_ID || '').trim();
  const debugToken = String(process.env.FIREBASE_APPCHECK_DEBUG_TOKEN || '').trim();
  if (!projectId || !appId || !debugToken)
    throw new Error('Firebase App Check CI configuration is incomplete');
  const url = 'https://firebaseappcheck.googleapis.com/v1/projects/' +
    encodeURIComponent(projectId) + '/apps/' + encodeURIComponent(appId) +
    ':exchangeDebugToken?key=' + encodeURIComponent(apiKey);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'referer': allowedReferer()
    },
    body: JSON.stringify({ debug_token: debugToken })
  });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || typeof body.token !== 'string' || body.token.length < 100)
    throw new Error('Firebase App Check debug exchange failed: ' +
      String(body?.error?.message || response.status).slice(0, 120));
  return body.token;
}

async function exchangeCustomToken(apiKey, token, appCheckToken) {
  const url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=' +
    encodeURIComponent(apiKey);
  for (let attempt = 0; attempt < 6; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'referer': allowedReferer(),
          'X-Firebase-AppCheck': appCheckToken
        },
        body: JSON.stringify({ token, returnSecureToken: true })
      });
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(250 * (2 ** attempt));
      continue;
    }
    let body = {};
    try { body = await response.json(); } catch {}
    if (response.ok && typeof body.idToken === 'string' && body.idToken.length > 100)
      return { idToken: body.idToken, localId: String(body.localId || '') };
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 5) {
      const code = String(body?.error?.message || response.status).slice(0, 120);
      throw new Error('Firebase custom-token exchange failed: ' + code);
    }
    await sleep(250 * (2 ** attempt));
  }
  throw new Error('Firebase custom-token exchange failed');
}

async function withAdmin(expectedProjectId, fn) {
  const serviceAccount = loadServiceAccount(expectedProjectId);
  const app = initializeApp({
    credential: cert(serviceAccount),
    projectId: expectedProjectId
  }, 'voxel-load-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  try { return await fn(getAuth(app)); }
  finally { await deleteApp(app); }
}

async function prepare() {
  const count = integer('BOT_COUNT', 100, 1, 10000);
  const projectId = String(process.env.PROJECT_ID || '').trim();
  const apiKey = String(process.env.FIREBASE_API_KEY || '').trim();
  if (!/^[a-z0-9-]{4,64}$/.test(projectId)) throw new Error('PROJECT_ID is invalid');
  if (!/^AIza[A-Za-z0-9_-]{35}$/.test(apiKey)) throw new Error('FIREBASE_API_KEY is invalid');
  const file = safeWorkPath(process.env.TOKEN_FILE);
  const appCheckToken = await exchangeAppCheckToken(apiKey);
  const tag = runTag();
  const prefix = ('voxel-load-' + tag + '-').slice(0, 90);
  const users = Array.from({ length: count }, (_, index) => {
    const uid = prefix + String(index).padStart(5, '0');
    if (uid.length > 128) throw new Error('Generated UID exceeds Firebase limit');
    return { uid };
  });

  const manifest = {
    formatVersion: 1,
    mode: 'firebase-admin-imported-load-identities',
    projectId,
    runTag: tag,
    createdAtUTC: new Date().toISOString(),
    requestedUsers: count,
    users
  };
  fs.writeFileSync(file, JSON.stringify(manifest));

  await withAdmin(projectId, async auth => {
    for (let offset = 0; offset < users.length; offset += 1000) {
      const batch = users.slice(offset, offset + 1000).map(({ uid }, localIndex) => ({
        uid,
        displayName: 'VOXEL Load ' + (offset + localIndex),
        customClaims: { voxelLoadTest: true, loadRun: tag }
      }));
      const result = await auth.importUsers(batch);
      if (result.failureCount) {
        const sample = result.errors.slice(0, 5).map(error => ({
          index: offset + error.index,
          code: error.error?.code || 'unknown'
        }));
        throw new Error('Firebase bulk import failed: ' + JSON.stringify(sample));
      }
      console.log(`Imported ${Math.min(offset + batch.length, users.length)}/${users.length} load identities`);
    }

    const authenticated = await mapLimit(users, 80, async ({ uid }) => {
      const customToken = await auth.createCustomToken(uid, { voxelLoadTest: true, loadRun: tag });
      const signedIn = await exchangeCustomToken(apiKey, customToken, appCheckToken);
      if (signedIn.localId && signedIn.localId !== uid)
        throw new Error('Firebase returned a different UID during token exchange');
      return { uid, idToken: signedIn.idToken };
    });
    manifest.users = authenticated;
    manifest.preparedAtUTC = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(manifest));
  });

  console.log(`Prepared ${count} unique Firebase load-test identities; token values withheld`);
}

async function cleanup() {
  const projectId = String(process.env.PROJECT_ID || '').trim();
  const file = safeWorkPath(process.env.TOKEN_FILE);
  if (!fs.existsSync(file)) {
    console.log('No token manifest exists; cleanup has nothing to delete');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.projectId !== projectId) throw new Error('Cleanup project mismatch');
  const uids = [...new Set((manifest.users || []).map(user => String(user.uid || '')).filter(Boolean))];
  if (!uids.length) {
    fs.rmSync(file, { force: true });
    console.log('Token manifest contained no UIDs');
    return;
  }

  await withAdmin(projectId, async auth => {
    for (let offset = 0; offset < uids.length; offset += 1000) {
      const batch = uids.slice(offset, offset + 1000);
      const result = await auth.deleteUsers(batch);
      if (result.failureCount) {
        const sample = result.errors.slice(0, 5).map(error => ({
          index: offset + error.index,
          code: error.error?.code || 'unknown'
        }));
        throw new Error('Firebase bulk cleanup failed: ' + JSON.stringify(sample));
      }
      console.log(`Deleted ${Math.min(offset + batch.length, uids.length)}/${uids.length} load identities`);
      if (offset + batch.length < uids.length) await sleep(1100);
    }
  });

  fs.rmSync(file, { force: true });
  console.log(`Cleanup complete for ${uids.length} Firebase load-test identities`);
}

function selfTest() {
  process.env.LOAD_RUN_TAG = 'self-test';
  const tag = runTag();
  const sample = ('voxel-load-' + tag + '-' + String(9999).padStart(5, '0')).slice(0, 128);
  if (!/^voxel-load-self-test-/.test(sample) || sample.length > 128)
    throw new Error('UID generator self-test failed');
  console.log('PASS Firebase load identity helper self-test');
}

(async () => {
  if (mode === 'prepare') await prepare();
  else if (mode === 'cleanup') await cleanup();
  else if (mode === 'self-test' || mode === '--self-test') selfTest();
  else throw new Error('Usage: firebase-load-users.cjs prepare|cleanup|self-test');
})().catch(error => {
  console.error('FATAL:', error?.message || error);
  process.exit(1);
});
