'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const client=fs.readFileSync('src/client/secure-entitlements-payment.js','utf8');
const builder=fs.readFileSync('scripts/rebuild/build-lucky-from-staging.cjs','utf8');
const first=client.indexOf('function secureSlip2GoPurchaseAllowed(user)');
const last=client.indexOf('async function secureOpenSlip2GoPayment',first);
assert.ok(first>=0&&last>first,'payment gate must precede QR handler');
const predicate=client.slice(first,last);

test('public rollout permits signed-in Admin and non-Admin; canary restricts to owner',()=>{
  const cases=[
    {rollout:'public', enabled:true,email:'jtkmanga@gmail.com',allow:true},
    {rollout:'public', enabled:true,email:'player@example.invalid',allow:true},
    {rollout:'public', enabled:true,email:'',allow:true},
    {rollout:'canary', enabled:true,email:'jtkmanga@gmail.com',allow:true},
    {rollout:'canary', enabled:true,email:'player@example.invalid',allow:false},
    {rollout:'disabled',enabled:true,email:'jtkmanga@gmail.com',allow:false},
    {rollout:'public',enabled:false,email:'player@example.invalid',allow:false}
  ];
  for(const s of cases){
    const ctx={
      LUCKY_SLIP2GO_UI_ENABLED:s.enabled,
      LUCKY_SLIP2GO_ROLLOUT:s.rollout,
      LUCKY_SLIP2GO_CANARY_OWNER_EMAIL:'jtkmanga@gmail.com'
    };
    vm.createContext(ctx);
    vm.runInContext(predicate,ctx,{timeout:1000});
    assert.equal(Boolean(ctx.secureSlip2GoPurchaseAllowed({uid:'signed-in-player',email:s.email})),s.allow,s.rollout+' '+s.email);
    assert.equal(Boolean(ctx.secureSlip2GoPurchaseAllowed(null)),false,'signed out users never allowed');
  }
});

test('QR and slip upload both check payment eligibility before any network request',()=>{
  const start=client.indexOf('async function secureOpenSlip2GoPayment(');
  const upload=client.indexOf('verifyAndBuySlip = async function()',start);
  assert.ok(start>=0&&upload>start);
  const qr=client.slice(start,upload),slip=client.slice(upload);
  const guard='if (!secureSlip2GoPurchaseAllowed(user))';
  assert.ok(qr.indexOf(guard)>=0&&qr.indexOf(guard)<qr.indexOf("'/payment-qr'"));
  assert.ok(slip.indexOf(guard)>=0&&slip.indexOf(guard)<slip.indexOf("'/verify-slip'"));
  assert.match(builder,/LUCKY_SLIP2GO_ROLLOUT/);
  assert.match(builder,/process\.env\.LUCKY_SLIP2GO_UI_ENABLED !== '0'/);
});

test('Worker independently requires authenticated identity and protects Canary or Public checkout',()=>{
  const worker=fs.readFileSync('src/worker/http.mjs','utf8');
  assert.match(worker,/function paymentRolloutAllowed\(env, identity\)/);
  assert.match(worker,/if\(rollout==='public'\) return true/);
  assert.match(worker,/if\(rollout!=='canary'\) return false/);
  assert.equal(worker.match(/if\s*\(\s*!paymentRolloutAllowed\s*\(\s*env\s*,\s*verified\s*\)\s*\)/g)?.length,2);
  assert.match(worker,/env\.ADMIN_OWNER_EMAIL/);
});

test('production generated HTML has no temporary Staging purple banner or payment test labels',()=>{
  const html=fs.readFileSync('index.html','utf8');
  assert.match(html,/const LUCKY_SLIP2GO_ROLLOUT = "public"/);
  assert.match(html,/const LUCKY_SLIP2GO_UI_ENABLED = true/);
  assert.doesNotMatch(html,/id="staging-status"/);
  assert.doesNotMatch(html,/STAGING GAMEPLAY · SLIP2GO CANARY \(OWNER ONLY\)/);
  assert.doesNotMatch(html,/<div[^>]*background:#5b21b6/);
});
