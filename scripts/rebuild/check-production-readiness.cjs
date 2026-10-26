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
if(ref&&!['refs/heads/main','refs/heads/development/voxel-continuous','refs/heads/release/production-prep',
  'refs/heads/feature/promptpay-dynamic-qr'].includes(ref)) fail('unexpected branch');
const mode=String(process.env.PRODUCTION_PAYMENT_MODE||'').trim();
if(!['disabled','slip2go-production'].includes(mode)) fail('invalid production payment mode');

const authSource=fs.readFileSync('src/client/auth-state.js','utf8');
for(const required of [
  'projectId: "lucky-game-6936b"',
  'authDomain: "lucky-game-6936b.firebaseapp.com"'
]) if(!authSource.includes(required)) fail('production Firebase client configuration drifted');
const paymentSource=fs.readFileSync('src/client/secure-entitlements-payment.js','utf8');
if(!paymentSource.includes("const SECURE_WORKER_HTTP_BASE = 'https://voxel-run-v2-demo.hjinffv5426.workers.dev'"))
  fail('production Worker client origin drifted');
const appCheckMatch=/PRODUCTION_APP_CHECK_SITE_KEY\s*=\s*"([^"]+)"/.exec(authSource);
if(!appCheckMatch) fail('production App Check key declaration is missing');
else if(appCheckMatch[1]==='__VOXEL_PRODUCTION_APP_CHECK_SITE_KEY__') fail('production App Check site key is still a placeholder');
else if(appCheckMatch[1].length<10||appCheckMatch[1].length>256||/[\s\u0000-\u001f\u007f]/.test(appCheckMatch[1]))
  fail('production App Check site key format is invalid');

if(mode==='slip2go-production'){
  if(process.env.PRODUCTION_SLIP2GO_CONFIG_VERIFIED!=='true')
    fail('PRODUCTION_SLIP2GO_CONFIG_VERIFIED must be true');
  const httpSource=fs.readFileSync('src/worker/http.mjs','utf8');
  if(!httpSource.includes('https://connect.slip2go.com/api/qr-payment/generate-qr-image-link') ||
      !httpSource.includes('https://connect.slip2go.com/api/verify-slip/qr-image/info'))
    fail('Slip2Go production adapter is missing or drifted');
  if(!paymentSource.includes("SECURE_WORKER_HTTP_BASE + '/payment-qr'") ||
      !paymentSource.includes("SECURE_WORKER_HTTP_BASE + '/verify-slip'"))
    fail('Slip2Go production client path is missing or drifted');
}
if(process.exitCode) process.exit(process.exitCode);
console.log('PASS production readiness preflight: secrets withheld');
