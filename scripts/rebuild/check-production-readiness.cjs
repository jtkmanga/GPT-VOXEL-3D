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
if(ref&&!['refs/heads/main','refs/heads/development/voxel-continuous'].includes(ref)) fail('unexpected branch');
const mode=String(process.env.PRODUCTION_PAYMENT_MODE||'').trim();
if(mode&&!['disabled','2c2p-production'].includes(mode)) fail('invalid production payment mode');
if(mode==='2c2p-production'){
  need('PRODUCTION_TWOC2P_MERCHANT_ID');need('PRODUCTION_TWOC2P_SECRET_KEY');
  need('PRODUCTION_FIREBASE_PUBLIC_CONFIG');need('PRODUCTION_APP_CHECK_SITE_KEY');
  need('PRODUCTION_ALLOWED_ORIGIN');need('PRODUCTION_WORKER_ORIGIN');
  if(process.env.PRODUCTION_ALLOWED_ORIGIN!==process.env.PRODUCTION_WORKER_ORIGIN) fail('production origins must match');
}else if(mode!=='disabled') fail('PRODUCTION_PAYMENT_MODE is not explicitly configured');
if(process.exitCode) process.exit(process.exitCode);
console.log('PASS production readiness preflight: secrets withheld');
