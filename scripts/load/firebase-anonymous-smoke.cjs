#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '../..');
const mode = process.argv[2] || 'self-test';

function workPath(value) {
  const file = path.resolve(ROOT, value || 'work/load/firebase-load-users.json');
  const work = path.resolve(ROOT, 'work') + path.sep;
  if (!file.startsWith(work)) throw new Error('TOKEN_FILE must stay under work/');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

function count() {
  const value = Number(process.env.BOT_COUNT || 100);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100)
    throw new Error('Anonymous smoke BOT_COUNT must be 1..100');
  return value;
}

function apiKey() {
  const value = String(process.env.FIREBASE_API_KEY || '').trim();
  if (!/^AIza[A-Za-z0-9_-]{35}$/.test(value)) throw new Error('FIREBASE_API_KEY is invalid');
  return value;
}

function allowedReferer() {
  const origin = String(process.env.ORIGIN || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//.test(origin)) throw new Error('ORIGIN must be an https:// URL');
  return origin + '/';
}

async function exchangeAppCheckToken(key) {
  const projectId = String(process.env.PROJECT_ID || '').trim();
  const appId = String(process.env.FIREBASE_APP_ID || '').trim();
  const debugToken = String(process.env.FIREBASE_APPCHECK_DEBUG_TOKEN || '').trim();
  if (!projectId || !appId || !debugToken)
    throw new Error('Firebase App Check CI configuration is incomplete');
  const url = 'https://firebaseappcheck.googleapis.com/v1/projects/' +
    encodeURIComponent(projectId) + '/apps/' + encodeURIComponent(appId) +
    ':exchangeDebugToken?key=' + encodeURIComponent(key);
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

async function createAnonymous(key, appCheckToken) {
  const response = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(key),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'referer': allowedReferer(),
        'X-Firebase-AppCheck': appCheckToken
      },
      body: JSON.stringify({ returnSecureToken: true })
    }
  );
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok || typeof body.idToken !== 'string' || typeof body.localId !== 'string') {
    const code = String(body?.error?.message || response.status).slice(0, 120);
    throw new Error('Anonymous Firebase signup failed: ' + code);
  }
  return { uid: body.localId, idToken: body.idToken };
}

async function deleteAnonymous(key, idToken, appCheckToken) {
  const response = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:delete?key=' + encodeURIComponent(key),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'referer': allowedReferer()
      },
      body: JSON.stringify({ idToken })
    }
  );
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch {}
    const code = String(body?.error?.message || response.status).slice(0, 120);
    throw new Error('Anonymous Firebase cleanup failed: ' + code);
  }
}

async function prepare() {
  const target = count();
  const key = apiKey();
  const file = workPath(process.env.TOKEN_FILE);
  const appCheckToken = await exchangeAppCheckToken(key);
  const manifest = {
    formatVersion: 1,
    mode: 'firebase-anonymous-staging-smoke',
    projectId: String(process.env.PROJECT_ID || ''),
    createdAtUTC: new Date().toISOString(),
    requestedUsers: target,
    users: []
  };
  fs.writeFileSync(file, JSON.stringify(manifest));

  for (let index = 0; index < target; index++) {
    const user = await createAnonymous(key, appCheckToken);
    manifest.users.push(user);
    fs.writeFileSync(file, JSON.stringify(manifest));
    if ((index + 1) % 10 === 0 || index + 1 === target)
      console.log(`Prepared ${index + 1}/${target} anonymous staging identities; token values withheld`);
    // Avoid burst-style abuse detection while staying comfortably within a CI job.
    if (index + 1 < target) await sleep(60);
  }
}

async function cleanup() {
  const file = workPath(process.env.TOKEN_FILE);
  if (!fs.existsSync(file)) {
    console.log('No anonymous token manifest exists');
    return;
  }
  const key = apiKey();
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const users = manifest.users || [];
  const appCheckToken = await exchangeAppCheckToken(key);
  let failures = 0;
  for (let index = 0; index < users.length; index++) {
    try { await deleteAnonymous(key, users[index].idToken, appCheckToken); }
    catch (error) {
      failures++;
      if (failures <= 5) console.error(error.message);
    }
    // Firebase documents a 10 deletions/second limit; stay below it.
    if (index + 1 < users.length) await sleep(125);
  }
  fs.rmSync(file, { force: true });
  if (failures) throw new Error(`Failed to delete ${failures} anonymous staging identities`);
  console.log(`Cleanup complete for ${users.length} anonymous staging identities`);
}

function selfTest() {
  process.env.BOT_COUNT = '100';
  if (count() !== 100) throw new Error('BOT_COUNT self-test failed');
  console.log('PASS anonymous staging smoke helper self-test (hard cap 100)');
}

(async () => {
  if (mode === 'prepare') await prepare();
  else if (mode === 'cleanup') await cleanup();
  else if (mode === 'self-test' || mode === '--self-test') selfTest();
  else throw new Error('Usage: firebase-anonymous-smoke.cjs prepare|cleanup|self-test');
})().catch(error => {
  console.error('FATAL:', error?.message || error);
  process.exit(1);
});
