'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const client=fs.readFileSync('src/client/secure-entitlements-payment.js','utf8');
const script=fs.readFileSync('scripts/rebuild/build-lucky-from-staging.cjs','utf8');
const first=client.indexOf('function secureSlip2GoCanaryOwner(user)');
const last=client.indexOf('async function secureOpenSlip2GoPayment',first);
assert.ok(first>=0&&last>first,'owner gate must precede QR handler');
const predicate=client.slice(first,last);

test('only exact Admin identity may view live Slip2Go canary flow',()=>{
  const scenarios=[
    {enabled:true,email:'jtkmanga@gmail.com',allow:true},
    {enabled:true,email:'JTKMANGA@GMAIL.COM',allow:true},
    {enabled:true,email:'other@gmail.com',allow:false},
    {enabled:true,email:'',allow:false},
    {enabled:false,email:'jtkmanga@gmail.com',allow:false}
  ];
  for(const scenario of scenarios){
    const ctx={
      LUCKY_SLIP2GO_UI_ENABLED:scenario.enabled,
      LUCKY_SLIP2GO_CANARY_OWNER_EMAIL:'jtkmanga@gmail.com'
    };
    vm.createContext(ctx);
    vm.runInContext(predicate,ctx,{timeout:1000});
    assert.equal(Boolean(ctx.secureSlip2GoCanaryOwner({email:scenario.email})),scenario.allow,scenario.email);
  }
});

test('QR and slip upload both guard admin access before making any network request',()=>{
  const start=client.indexOf('async function secureOpenSlip2GoPayment(');
  const upload=client.indexOf('verifyAndBuySlip = async function()',start);
  assert.ok(start>=0&&upload>start);
  const qr=client.slice(start,upload);
  const slip=client.slice(upload);
  assert.ok(qr.indexOf('if (!secureSlip2GoCanaryOwner(user))')>=0);
  assert.ok(qr.indexOf('if (!secureSlip2GoCanaryOwner(user))')<qr.indexOf("'/payment-qr'"));
  assert.ok(slip.indexOf('if (!secureSlip2GoCanaryOwner(user))')>=0);
  assert.ok(slip.indexOf('if (!secureSlip2GoCanaryOwner(user))')<slip.indexOf("'/verify-slip'"));
  assert.match(script,/LUCKY_SLIP2GO_CANARY_OWNER_EMAIL/);
  assert.match(script,/process\.env\.LUCKY_SLIP2GO_UI_ENABLED === '1'/);
});

test('Worker canary independently validates authenticated owner on both purchase routes',()=>{
  const worker=fs.readFileSync('src/worker/http.mjs','utf8');
  assert.match(worker,/function paymentRolloutAllowed\(env, identity\)/);
  assert.match(worker,/if\(rollout==='public'\) return true/);
  assert.match(worker,/if\(rollout!=='canary'\) return false/);
  assert.equal(worker.match(/if\s*\(\s*!paymentRolloutAllowed\s*\(\s*env\s*,\s*verified\s*\)\s*\)/g)?.length,2);
  assert.match(worker,/env\.ADMIN_OWNER_EMAIL/);
});
