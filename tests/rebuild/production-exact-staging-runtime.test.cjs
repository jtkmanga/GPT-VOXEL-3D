'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

function expectedGameplayRuntime(){
  const full=fs.readFileSync('src/client/staging-runtime.js','utf8');
  const start=full.indexOf('// Staging sends the exact ordered prediction intervals');
  const end=full.indexOf('async function stagingGetAppCheckToken',start);
  assert.ok(start>=0&&end>start,'staging gameplay block anchors must exist');
  let gameplay=full.slice(start,end)
    .replace("return STAGING_CLIENT_ENABLED && serverId === 'free1' && state.selectedServerId === 'free1';",
             "return serverId === 'free1' && state.selectedServerId === 'free1';")
    .replace(/!STAGING_CLIENT_ENABLED \|\| /g,'');
  return '// Production gameplay override intentionally mirrors the proven staging runtime.\n'
    +'// Auth, App Check, payment and staging-only diagnostics are excluded.\n'
    +gameplay;
}

test('production gameplay runtime is the exact staging gameplay block with only production gates removed',()=>{
  const actual=fs.readFileSync('src/client/production-staging-gameplay.js','utf8');
  assert.equal(actual,expectedGameplayRuntime());
  assert.doesNotMatch(actual,/STAGING_CLIENT_ENABLED|STAGING_PUBLIC_CONFIG|loginWithGoogle|verifyAndBuySlip|grantPurchasedItem|stagingGetAppCheckToken/);
});

test('canonical entry appends the exact staging gameplay runtime after all normal production fragments',()=>{
  const entry=fs.readFileSync('src/client/entry.mjs','utf8');
  assert.ok(entry.includes('"./secure-wheel-startup.js",\n  "./production-staging-gameplay.js"\n]'));
});

test('production keeps production auth and payment sources outside the staging gameplay override',()=>{
  const auth=fs.readFileSync('src/client/auth-state.js','utf8');
  const payment=fs.readFileSync('src/client/secure-entitlements-payment.js','utf8');
  const runtime=fs.readFileSync('src/client/production-staging-gameplay.js','utf8');
  assert.match(auth,/PRODUCTION_APP_CHECK_SITE_KEY/);
  assert.match(payment,/voxel-run-v2-demo\.hjinffv5426\.workers\.dev/);
  assert.doesNotMatch(runtime,/SLIP2GO|payment-qr|verify-slip|PRODUCTION_APP_CHECK_SITE_KEY/);
});
