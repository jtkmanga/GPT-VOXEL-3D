#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const fail=m=>{console.error('FAIL production readiness:',m);process.exitCode=1;};
const need=n=>{const v=String(process.env[n]||'').trim();if(!v)fail(n+' is not configured');return v;};
const config=fs.readFileSync('wrangler.jsonc','utf8');
if(!/"name"\s*:\s*"voxel-run-v2-demo"/.test(config)) fail('production worker identity changed');
if(/gpt-voxel-3d-staging-01|provider-neutral-test|TWOC2P_SANDBOX_|APP_ENV"\s*:\s*"staging"/.test(config)) fail('staging/sandbox config leaked into production wrangler');
if(!/"FIREBASE_PROJECT_ID"\s*:\s*"lucky-game-6936b"/.test(config)) fail('production Firebase project baseline changed');
if(!/"PAYMENT_MODE"\s*:\s*"disabled"/.test(config)) fail('production PAYMENT_MODE must be explicitly disabled in wrangler');
const ref=process.env.GITHUB_REF||'';
if(ref&&!['refs/heads/main','refs/heads/development/voxel-continuous','refs/heads/release/production-prep'].includes(ref)) fail('unexpected branch');
const mode=String(process.env.PRODUCTION_PAYMENT_MODE||'').trim();
if(!['disabled','2c2p-production'].includes(mode)) fail('invalid production payment mode');

const firebaseRaw=need('PRODUCTION_FIREBASE_PUBLIC_CONFIG');
let firebase;try{firebase=JSON.parse(firebaseRaw)}catch(_){fail('PRODUCTION_FIREBASE_PUBLIC_CONFIG is not valid JSON')}
if(!firebase||typeof firebase!=='object'||Array.isArray(firebase)||
   firebase.projectId!=='lucky-game-6936b'||firebase.authDomain!=='lucky-game-6936b.firebaseapp.com'||
   typeof firebase.apiKey!=='string'||typeof firebase.appId!=='string')
  fail('production Firebase public config is incomplete or mismatched');
need('PRODUCTION_APP_CHECK_SITE_KEY');
const allowedOrigin=need('PRODUCTION_ALLOWED_ORIGIN');
const workerOrigin=need('PRODUCTION_WORKER_ORIGIN');
for(const [name,value] of [['PRODUCTION_ALLOWED_ORIGIN',allowedOrigin],['PRODUCTION_WORKER_ORIGIN',workerOrigin]]){
  let u;try{u=new URL(value)}catch(_){fail(name+' is not a valid URL');continue}
  if(u.protocol!=='https:'||u.pathname!=='/'||u.search||u.hash) fail(name+' must be an HTTPS origin');
}
if(workerOrigin!=='https://voxel-run-v2-demo.hjinffv5426.workers.dev') fail('production Worker origin mismatch');

if(mode==='2c2p-production'){
  need('PRODUCTION_TWOC2P_MERCHANT_ID');need('PRODUCTION_TWOC2P_SECRET_KEY');
}
if(process.exitCode) process.exit(process.exitCode);
console.log('PASS production readiness preflight: secrets withheld');
