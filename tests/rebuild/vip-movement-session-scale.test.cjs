'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createHarness } = require('./harness.cjs');

const SECRET='synthetic-p7-only-provider-signing-fixture';
const idle={x:0,z:0,jump:false};
const packet=seq=>({type:'move',seq,input:idle,frames:[{input:idle,delta:.1}]});

async function admitVip(h,uid){
  const now=h.now();
  const event={eventId:'vip-scale:'+uid,subscriptionId:'vip-scale-sub:'+uid,uid,
    version:1,status:'active',product:'vip1',amount:50,currency:'THB',
    periodStart:now-1000,periodEnd:now-1000+30*86400_000};
  const body=JSON.stringify(event),timestamp=String(Math.floor(now/1000));
  const signature=createHmac('sha256',SECRET).update(timestamp+'.'+body).digest('hex');
  const result=await h.request('/payments/webhook',{method:'POST',body,headers:{
    'content-type':'application/json','x-provider-timestamp':timestamp,'x-provider-signature':signature
  }});
  assert.equal(result.status,200,'test entitlement must be granted only by verified synthetic webhook');
  const ws=await h.connect({server:'vip1',uid});
  assert.ok(ws.messages('welcome').at(-1),'VIP admits verified seat');
  return ws;
}

test('VIP movement ACKs 50 ordered packets without per-frame coordinator RPC; renews within six seconds',async t=>{
  const h=createHarness();
  t.after(()=>h.close());
  const ws=await admitVip(h,'synthetic-vip-smooth');
  const room=ws.instance;
  const calls=[],upstream=[];
  const original=room.sessionCall.bind(room),originalVip=room.vipCall.bind(room);
  room.sessionCall=async(action,payload)=>{calls.push(action);return original(action,payload)};
  room.vipCall=async(action,payload)=>{upstream.push(action);return originalVip(action,payload)};
  ws.clear();
  for(let seq=0;seq<50;seq++){
    await h.advance(200);
    await ws.send(packet(seq));
  }
  assert.equal(ws.client.closed,false);
  assert.equal(ws.messages('move').filter(x=>x.applied).length,50,'all VIP movement ACKs arrive');
  assert.equal(calls.filter(x=>x==='validate').length,0,'no global validation on each movement');
  assert.ok(calls.filter(x=>x==='checkpoint').length<=2,'only bounded seat heartbeats');
  assert.ok(upstream.filter(x=>x==='renew').length<=2,'no per-packet seat renewals');
  assert.equal(upstream.filter(x=>x==='validate').length,0);
  const before=upstream.filter(x=>x==='renew').length;
  await h.advance(6200);
  await ws.send(packet(50));
  assert.equal(ws.client.closed,false,'VIP remains admitted after short heartbeat');
  assert.ok(upstream.filter(x=>x==='renew').length>=before+1,
    'central VIP seat is refreshed on a bounded heartbeat');
  calls.length=0;
  await ws.send({type:'collect_box',seq:51,requestId:'vip-economy-strict'});
  assert.equal(calls.filter(x=>x==='validate').length,1,
    'VIP economy still uses strict central seat validation');
});

test('VIP fast-path rejects forged local generation and never grants unpaid access',async t=>{
  const h=createHarness();
  t.after(()=>h.close());
  const denied=await h.connect({server:'vip1',uid:'synthetic-vip-unpaid'});
  assert.equal(denied.messages('welcome').length,0);
  assert.equal(denied.client.closed,true);
  const ws=await admitVip(h,'synthetic-vip-generation');
  const wrong=ws.attachment();
  wrong.sessionId='forged-session-generation';
  ws.server.serializeAttachment(wrong);
  await h.advance(200);
  await ws.send(packet(0));
  assert.equal(ws.client.closed,true,'forged local session generation must close');
  assert.equal(ws.client.closeInfo.code,1008);
});
