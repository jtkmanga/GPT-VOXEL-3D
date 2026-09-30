#!/usr/bin/env node
'use strict';

const WebSocket=require('ws');

const BASE=process.env.WS_BASE || 'wss://voxel-run-v2-demo.hjinffv5426.workers.dev/play';
const FIREBASE_API_KEY=String(process.env.FIREBASE_API_KEY||'').trim();
let TOKEN=String(process.env.FIREBASE_ID_TOKEN||'').trim();
let tempAnon=false;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function createToken(){
  if(TOKEN) return TOKEN;
  if(!FIREBASE_API_KEY) throw Error('Set FIREBASE_API_KEY or FIREBASE_ID_TOKEN');
  const r=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_API_KEY)}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({returnSecureToken:true})
  });
  const b=await r.json().catch(()=>({}));
  if(!r.ok || !b.idToken) throw Error(`Anonymous sign-in failed: ${b?.error?.message||r.status}`);
  tempAnon=true;
  TOKEN=b.idToken;
  return TOKEN;
}

async function cleanup(){
  if(!tempAnon || !TOKEN || !FIREBASE_API_KEY) return;
  try{
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${encodeURIComponent(FIREBASE_API_KEY)}`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken:TOKEN})
    });
  }catch(_){}
}

function connect(zone,token){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(`${BASE}?zone=${zone}`,{handshakeTimeout:15000,perMessageDeflate:false});
    const timeout=setTimeout(()=>reject(Error(`welcome timeout ${zone}`)),18000);
    ws.on('open',()=>ws.send(JSON.stringify({type:'auth',token})));
    ws.on('message',raw=>{
      let m; try{m=JSON.parse(String(raw));}catch(_){return;}
      if(m?.type==='welcome'){
        clearTimeout(timeout);
        resolve({ws,welcome:m,messages:[]});
      }
    });
    ws.on('unexpected-response',(_req,res)=>{
      clearTimeout(timeout);
      reject(Error(`HTTP ${res.statusCode} for zone ${zone}`));
      res.resume();
    });
    ws.on('error',err=>{
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function collectMessages(client){
  client.ws.on('message',raw=>{
    let m; try{m=JSON.parse(String(raw));}catch(_){return;}
    if(m?.type!=='welcome') client.messages.push(m);
  });
}

async function moveTo(client,targetX,targetZ){
  let x=Number(client.welcome.spawn.x)||0;
  let y=Number(client.welcome.spawn.y)||0;
  let z=Number(client.welcome.spawn.z)||0;
  let r=Number(client.welcome.spawn.r)||0;
  const speed=12; // comfortably below normal anti-cheat limit
  const interval=220;
  const step=speed*(interval/1000);

  while(Math.hypot(targetX-x,targetZ-z)>0.7){
    const dx=targetX-x, dz=targetZ-z;
    const d=Math.hypot(dx,dz)||1;
    const use=Math.min(step,d);
    x+=dx/d*use;
    z+=dz/d*use;
    r+=0.01;
    client.ws.send(JSON.stringify({type:'move',x,y,z,r}));
    await sleep(interval);
  }
  return {x,y,z,r};
}

function waitForGhost(client,sourceZone,playerId,present=true,timeoutMs=6000){
  return new Promise((resolve,reject)=>{
    const started=Date.now();
    const check=()=>{
      for(const m of client.messages){
        if(m?.type!=='ghost_snapshot' || m.zone!==sourceZone) continue;
        const players=Array.isArray(m.players)?m.players:[];
        const has=players.some(p=>p?.id===playerId);
        if((present && has) || (!present && !has)) return resolve(m);
      }
      if(Date.now()-started>=timeoutMs) return reject(Error(`ghost ${present?'appearance':'removal'} timeout`));
      setTimeout(check,100);
    };
    check();
  });
}

async function main(){
  const token=await createToken();
  console.log('=== VOXEL RUN Phase 2B2 border visibility test ===');

  const a=await connect('5,5',token);
  const b=await connect('6,5',token);
  collectMessages(a);
  collectMessages(b);

  console.log('A:',{zone:a.welcome.zone,id:a.welcome.id,spawn:a.welcome.spawn});
  console.log('B:',{zone:b.welcome.zone,id:b.welcome.id,spawn:b.welcome.spawn});

  // Boundary between zone 5,5 and 6,5 is x=150.
  // Put A and B 20 units apart across the border.
  await Promise.all([
    moveTo(a,140,70),
    moveTo(b,160,70)
  ]);

  a.messages.length=0;
  b.messages.length=0;

  // Trigger a few more safe movement frames so throttled snapshots flush.
  for(let i=0;i<5;i++){
    a.ws.send(JSON.stringify({type:'move',x:140,y:0,z:70+i*0.15,r:0.2+i*0.01}));
    b.ws.send(JSON.stringify({type:'move',x:160,y:0,z:70-i*0.15,r:0.2-i*0.01}));
    await sleep(240);
  }

  const seenByB=await waitForGhost(b,'5,5',a.welcome.id,true,7000);
  const seenByA=await waitForGhost(a,'6,5',b.welcome.id,true,7000);

  console.log('B sees A ghost:',seenByB.players.find(p=>p.id===a.welcome.id));
  console.log('A sees B ghost:',seenByA.players.find(p=>p.id===b.welcome.id));

  // Close A and verify zone 5,5 sends an empty/reconciled snapshot to B.
  b.messages.length=0;
  a.ws.close(1000,'border test close');
  await sleep(700);
  const removed=await waitForGhost(b,'5,5',a.welcome.id,false,7000);
  console.log('B removal snapshot:',{zone:removed.zone,count:Array.isArray(removed.players)?removed.players.length:0});

  b.ws.close(1000,'done');
  await sleep(300);
  console.log('PASS: adjacent zones exchanged filtered ghost snapshots and removed a departed player.');
}

main()
  .catch(err=>{console.error('FAIL:',err?.stack||err);process.exitCode=1;})
  .finally(cleanup);
