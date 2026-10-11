'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHarness}=require('./harness.cjs');
const last=(c,type)=>c.messages(type).at(-1);
const plain=value=>JSON.parse(JSON.stringify(value));

test('P8 admission delivers the current leaderboard without globally rebroadcasting an unchanged top ten',async t=>{
  const h=createHarness(); t.after(()=>h.close());
  const clients=[];
  for(let i=0;i<10;i++) {
    const c=await h.connect({uid:`p8-top-ten-${i}`,name:`Rank${i}`,zone:'4,4'});
    assert.ok(last(c,'welcome')); clients.push(c);
  }
  const top=plain(h.room().top()), observer=clients[0]; observer.clear();
  for(let i=0;i<20;i++) {
    await h.advance(1);
    const c=await h.connect({uid:`p8-unranked-${i}`,name:`Outside${i}`,zone:'5,5'});
    assert.deepEqual(last(c,'welcome').leaderboard,top);
    assert.deepEqual(plain(h.room().top()),top);
  }
  assert.equal(observer.messages('leaderboard').length,0,'unchanged admissions cannot create global amplification');
  await h.advance(1);
  const replacement=await h.connect({uid:'p8-top-ten-1',name:'NewRank',zone:'4,4'});
  assert.ok(last(replacement,'welcome'));
  assert.equal(last(observer,'leaderboard').top[1].nickname,'NewRank');
  assert.deepEqual(last(replacement,'welcome').leaderboard,plain(h.room().top()));
  observer.clear(); h.restartRoom({keepSockets:true}); await h.room().ready;
  const fresh=await h.connect({uid:'p8-post-restart-unranked',zone:'5,5'});
  assert.deepEqual(last(fresh,'welcome').leaderboard,plain(h.room().top()));
  assert.deepEqual(last(observer,'leaderboard').top,plain(h.room().top()),'restart cannot suppress initial synchronization');
});
