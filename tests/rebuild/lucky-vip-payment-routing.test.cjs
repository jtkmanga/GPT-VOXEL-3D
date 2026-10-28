'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {readFileSync}=require('node:fs');

const source=readFileSync('src/client/staging-runtime.js','utf8');
const start=source.indexOf('const stagingOriginalOpenPaymentModal =');
const end=source.indexOf('function stagingSandboxPaymentReturnRequested()',start);
assert.ok(start>=0&&end>start,'Staging purchase override boundaries must remain discoverable');
const wrapper=source.slice(start,end);

for(const [enabled,owner] of [[false,'payments-disabled'],[true,'slip2go-owner']]){
  test('Lucky VIP purchase with Slip2Go UI '+String(enabled)+' never invokes 2C2P',()=>{
    const calls=[];
    const context={
      LUCKY_SLIP2GO_UI_ENABLED:enabled,
      STAGING_CLIENT_ENABLED:true,
      auth:{currentUser:{uid:'synthetic-owner'}},
      openPaymentModal(type){calls.push([owner,type]);return owner},
      alert(){calls.push('alert')},
      fetch(){calls.push('2c2p-network');throw Error('Legacy provider must not be called')},
      stagingGetIdToken(){throw Error('2C2P must never run')},
      stagingGetAppCheckToken(){throw Error('2C2P must never run')},
      stagingSetStatus(x){calls.push(x)},
      crypto:{randomUUID:()=> 'abc'},
      Date, Math, URL, JSON
    };
    vm.createContext(context);
    vm.runInContext(wrapper,context,{timeout:1000});
    context.openPaymentModal('vip1',50,'VIP');
    assert.deepEqual(calls,[[owner,'vip1']]);
    assert.doesNotMatch(String(context.openPaymentModal),/stagingStartVipSandboxCheckout/);
  });
}

test('Lucky return query is never interpreted as a 2C2P sandbox callback',()=>{
  const start=source.indexOf('function stagingSandboxPaymentReturnRequested()');
  const end=source.indexOf('async function stagingReconcileSandboxPaymentReturn()',start);
  assert.ok(start>=0&&end>start);
  const code=source.slice(start,end);
  for(const enabled of [false,true]){
    const context={LUCKY_SLIP2GO_UI_ENABLED:enabled,STAGING_CLIENT_ENABLED:true,window:{location:{search:'?payment=sandbox-return'}},URLSearchParams};
    vm.createContext(context);
    vm.runInContext(code,context,{timeout:1000});
    assert.equal(context.stagingSandboxPaymentReturnRequested(),false);
  }
});

test('original Staging keeps its legacy test-only handler, while Lucky uses a defined flag',()=>{
  assert.match(source,/typeof LUCKY_SLIP2GO_UI_ENABLED === 'undefined'\) \{/);
  const build=readFileSync('scripts/rebuild/build-lucky-from-staging.cjs','utf8');
  assert.match(build,/const LUCKY_SLIP2GO_UI_ENABLED = /);
  assert.match(build,/process\.env\.LUCKY_SLIP2GO_UI_ENABLED === '1'/);
  const html=readFileSync('index.html','utf8');
  assert.match(html,/const LUCKY_SLIP2GO_UI_ENABLED = false/);
  assert.match(html,/STAGING GAMEPLAY · REAL PAYMENTS DISABLED/);
});
