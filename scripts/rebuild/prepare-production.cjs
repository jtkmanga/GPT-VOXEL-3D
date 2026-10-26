#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');

const fail=m=>{throw Error('Production preparation failed: '+m)};
const need=n=>{const v=String(process.env[n]||'').trim();if(!v)fail(n+' is not configured');return v};
function productionFirebasePublicConfig(){
  const source=fs.readFileSync(path.resolve('src/client/auth-state.js'),'utf8');
  const read=(key,pattern)=>{const m=pattern.exec(source);if(!m)fail('production client Firebase '+key+' is unavailable');return m[1]};
  return {
    apiKey:read('apiKey',/apiKey:\s*"([^"]+)"/),
    authDomain:read('authDomain',/authDomain:\s*"([^"]+)"/),
    projectId:read('projectId',/projectId:\s*"([^"]+)"/),
    appId:read('appId',/appId:\s*"([^"]+)"/),
    messagingSenderId:read('messagingSenderId',/messagingSenderId:\s*"([^"]+)"/)
  };
}

const basePath=path.resolve('wrangler.jsonc');
const outDir=path.resolve('work/production/prepared');
const outPath=path.join(outDir,'wrangler.jsonc');
const config=JSON.parse(fs.readFileSync(basePath,'utf8'));

if(config.name!=='voxel-run-v2-demo') fail('production worker identity changed');
if(config.vars?.FIREBASE_PROJECT_ID!=='lucky-game-6936b') fail('production Firebase project changed');
if(config.vars?.PAYMENT_MODE!=='disabled') fail('base production payment must remain disabled');
if(process.env.PRODUCTION_PAYMENT_MODE!=='disabled') fail('first production rollout requires PRODUCTION_PAYMENT_MODE=disabled');
if(!Array.isArray(config.triggers?.crons)||config.triggers.crons.length!==1||config.triggers.crons[0]!=='0 17 * * *')
  fail('production Bangkok-midnight cron is missing');
if(String(config.vars?.ADMIN_OWNER_EMAIL||'').trim().toLowerCase()!=='jtkmanga@gmail.com')
  fail('production admin owner is not configured');

const firebase=productionFirebasePublicConfig();
if(firebase.projectId!=='lucky-game-6936b'||firebase.authDomain!=='lucky-game-6936b.firebaseapp.com')
  fail('production Firebase public config mismatch');
if(!/^AIza[A-Za-z0-9_-]{35}$/.test(firebase.apiKey)) fail('Firebase public API key format invalid');
if(!/^1:\d+:web:[A-Za-z0-9]+$/.test(firebase.appId)) fail('Firebase appId format invalid');

const siteKey=need('PRODUCTION_APP_CHECK_SITE_KEY');
if(siteKey.length<10||siteKey.length>256||/[\s\u0000-\u001f\u007f]/.test(siteKey)) fail('Production App Check site key format invalid');
const allowedOrigin='https://jtkmanga.github.io';
const workerOrigin='https://voxel-run-v2-demo.hjinffv5426.workers.dev';

config.vars={
  ...config.vars,
  ALLOWED_ORIGIN:allowedOrigin,
  FIREBASE_PUBLIC_CONFIG:JSON.stringify(firebase),
  FIREBASE_APP_CHECK_SITE_KEY:siteKey
};
fs.mkdirSync(outDir,{recursive:true});
fs.writeFileSync(outPath,JSON.stringify(config,null,2)+'\n',{mode:0o600});
console.log('PASS production config prepared: values withheld; payment disabled; cron present');
