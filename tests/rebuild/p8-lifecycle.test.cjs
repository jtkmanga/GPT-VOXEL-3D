'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./harness.cjs');
const last = (c, type) => c.messages(type).at(-1);
const position = p => Object.fromEntries(['x','y','z','r'].map(key => [key,p[key]]));
function fixture(t) { const h=createHarness(); t.after(()=>h.close()); return h; }

function holdCall(instance, action) {
  let release, seen;
  const blocked=new Promise(resolve=>{ release=resolve; }), entered=new Promise(resolve=>{ seen=resolve; });
  const call=instance.sessionCall.bind(instance);
  let hold=true;
  instance.sessionCall=async (operation,payload)=>{
    const result=await call(operation,payload);
    if (hold && operation===action) { hold=false; seen(); await blocked; }
    return result;
  };
  return { release, entered };
}

for (const zone of [undefined,'5,5']) for (const expiry of ['token','lease']) {
  test(`P8 delayed valid ${zone?'zone':'room'} authority response cannot authorize movement after ${expiry} expiry`, async t=>{
    const h=fixture(t), uid=`p8-held-${zone?'zone':'room'}-${expiry}`;
    const token=h.token(uid,expiry==='token'?{exp:Math.floor(h.now()/1000)+1}:{});
    const c=await h.connect({uid,token,...(zone?{zone}:{})});
    assert.ok(last(c,'welcome')); await h.advance(200); c.clear();
    const before=c.attachment(), row=h.room().sessions.row(uid), hold=holdCall(c.instance,'validate');
    const pending=c.send({type:'move',seq:0,input:{x:1,z:0,jump:false}});
    await hold.entered; await h.advance(expiry==='token'?1000:120000); hold.release(); await pending;
    assert.equal(c.client.closed,true);
    assert.equal(c.messages('move').length,0,'no expired movement acknowledgement');
    assert.deepEqual(position(c.attachment()),position(before));
    assert.deepEqual(position(h.room().sessions.row(uid)),position(row));
    assert.equal(h.room().sessions.row(uid).save_revision,row.save_revision);
  });
}

test('P8 delayed new-zone authentication cannot welcome an expired verified token', async t=>{
  const h=fixture(t), uid='p8-held-new-auth', c=await h.open('/play?zone=5,5');
  const hold=holdCall(c.instance,'validate');
  const pending=c.send({type:'auth',token:h.token(uid,{exp:Math.floor(h.now()/1000)+1}),protocol:6});
  await hold.entered; await h.advance(1500); hold.release(); await pending;
  assert.equal(c.client.closed,true); assert.equal(c.messages('welcome').length,0);
  assert.equal(c.instance.count(),0);
  assert.equal(h.room().sessions.validate({uid,sessionId:h.room().sessions.row(uid).session_id,owner:'zone:5,5'}),false);
});

for (const zone of [undefined,'4,4']) {
  test(`P8 delayed ${zone?'zone':'room'} auth refresh never restores an attachment closed during checkpoint`, async t=>{
    const h=fixture(t), uid=`p8-refresh-close-${zone?'zone':'room'}`, c=await h.connect({uid,...(zone?{zone}:{})});
    assert.ok(last(c,'welcome')); c.clear();
    const sessionId=c.attachment().sessionId, hold=holdCall(c.instance,'checkpoint');
    const pending=c.send({type:'auth',token:h.token(uid),protocol:zone?6:4});
    await hold.entered; await c.close(); hold.release(); await pending;
    assert.equal(c.client.closed,true); assert.equal(c.attachment().sessionClosed,true);
    assert.equal(c.messages('auth_refreshed').length,0);
    assert.equal(h.room().sessions.validate({uid,sessionId,owner:zone?'zone:4,4':'room'}),false);
  });
}

test('P8 expired Free names receive no fan-out and are excluded from successor welcome', async t=>{
  const h=fixture(t), uid='p8-expired-free-name';
  const old=await h.connect({uid,name:'ExpiredName',token:h.token(uid,{exp:Math.floor(h.now()/1000)+1})});
  old.clear(); await h.advance(1000);
  assert.equal(h.room().count(),0);
  h.room().broadcast({type:'box_state',box:h.room().boxSnapshot(),serverNow:h.now()});
  assert.equal(old.messages().length,0);
  const next=await h.connect({uid:'p8-fresh-free-name'});
  assert.ok(last(next,'welcome')); assert.equal(last(next,'welcome').players.length,0);
  assert.equal(old.client.closed,true); assert.equal(h.room().count(),1);
});

for (const [zone,capacity] of [[undefined,160],['4,4',120]]) {
  test(`P8 ${zone?'zone':'legacy Free'} expired transport cohort releases ${capacity} admission slots`, async t=>{
    const h=fixture(t), connections=[];
    for (let i=0;i<capacity;i++) {
      const uid=`p8-expired-cap-${zone?'zone':'room'}-${i}`;
      const c=await h.connect({uid,...(zone?{zone}:{}),token:h.token(uid,{exp:Math.floor(h.now()/1000)+1})});
      assert.ok(last(c,'welcome')); connections.push(c);
    }
    assert.equal(connections[0].instance.count(),capacity);
    await h.advance(1000); assert.equal(connections[0].instance.count(),0);
    const next=await h.connect({uid:`p8-next-cohort-${capacity}`,...(zone?{zone}:{})});
    assert.ok(last(next,'welcome')); assert.equal(next.instance.count(),1);
    assert.ok(connections.every(c=>c.client.closed));
    assert.equal(next.instance.sockets().length,1);
  });
}

test('P8 failed generation eviction is durably retried after coordinator restart without revoking successor', async t=>{
  const h=fixture(t), uid='p8-durable-eviction', source=await h.connect({uid,zone:'4,4'});
  const oldId=source.attachment().sessionId, get=h.env.ZONE.getByName;
  let fail=true;
  h.env.ZONE.getByName=name=>{
    const stub=get(name);
    return {async fetch(request) {
      if(fail && new URL(request.url).pathname==='/_internal/session-revoke') return new Response('{}',{status:503});
      return stub.fetch(request);
    }};
  };
  const failed=await h.connect({uid,zone:'5,4'});
  assert.equal(failed.client.closed,true); assert.equal(failed.messages('welcome').length,0);
  assert.equal(h.room().sessions.validate({uid,sessionId:oldId,owner:'zone:4,4'}),false);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_session_revocations').toArray()[0].n,1);
  h.restartRoom({keepSockets:true}); await h.room().ready;
  fail=false;
  const successor=await h.connect({uid,zone:'5,4'}), successorId=successor.attachment().sessionId;
  assert.ok(last(successor,'welcome'));
  await h.advance(1000);
  assert.equal(source.client.closed,true,'the actual durable alarm retires the old transport');
  assert.equal(successor.client.closed,false);
  assert.equal(h.room().sessions.validate({uid,sessionId:successorId,owner:'zone:5,4'}),true);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_session_revocations').toArray()[0].n,0);
});

test('P8 explicit handoff-source eviction failure keeps an exact-owner retry across restart',async t=>{
  const h=fixture(t), uid='p8-explicit-retire', source=await h.connect({uid,zone:'4,4'});
  const sessionId=source.attachment().sessionId, get=h.env.ZONE.getByName;
  let fail=true;
  h.env.ZONE.getByName=name=>{
    const stub=get(name);
    return {async fetch(request){
      if(fail && new URL(request.url).pathname==='/_internal/session-revoke') return new Response('{}',{status:503});
      return stub.fetch(request);
    }};
  };
  await assert.rejects(h.room().sessionCall('revoke',{uid,sessionId,owner:'zone:4,4'}),/revocation unavailable/);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_session_revocations').toArray()[0].n,1);
  h.restartRoom({keepSockets:true}); await h.room().ready; fail=false;
  await h.advance(1000);
  assert.equal(source.client.closed,true);
  assert.equal(h.room().sql.exec('SELECT COUNT(*) AS n FROM voxel_session_revocations').toArray()[0].n,0);
});

test('P8 a delayed final handoff validation cannot acknowledge a target whose authenticated token expired',async t=>{
  const h=fixture(t), uid='p8-held-handoff-expiry', source=await h.connect({uid,zone:'4,4'});
  h.place(source,{x:-.1,y:0,z:-75,r:0}); await h.advance(200);
  await source.send({type:'move',seq:0,input:{x:1,z:0,jump:false}});
  const ticket=last(source,'zone_change'); assert.ok(ticket?.handoffToken);
  const target=await h.open('/play?zone=5,4');
  await target.send({type:'auth',protocol:6,token:h.token(uid,{exp:Math.floor(h.now()/1000)+1}),handoffToken:ticket.handoffToken});
  assert.ok(last(target,'welcome')?.handoff); target.clear();
  const hold=holdCall(target.instance,'validate'), pending=target.send({type:'handoff_resume'});
  await hold.entered; await h.advance(1000); hold.release(); await pending;
  assert.equal(target.messages('handoff_resumed').length,0);
  assert.equal(target.client.closed,true);
  assert.equal(target.instance.count(),0);
  assert.equal(h.room().sessions.validate({uid,sessionId:target.attachment().sessionId,owner:'zone:5,4'}),false);
});
