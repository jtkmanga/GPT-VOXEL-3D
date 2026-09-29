#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const BASE = process.env.WS_BASE || 'wss://voxel-run-v2-demo.hjinffv5426.workers.dev/play';
const BOT_COUNT = Math.max(1, Number(process.env.BOT_COUNT || 500));
const DURATION_SEC = Math.max(5, Number(process.env.DURATION_SEC || 30));
const CONNECT_STAGGER_MS = Math.max(0, Number(process.env.CONNECT_STAGGER_MS || 20));
const MOVE_INTERVAL_MS = Math.max(200, Number(process.env.MOVE_INTERVAL_MS || 210));
const FIREBASE_API_KEY = String(process.env.FIREBASE_API_KEY || '').trim();
let TOKEN = String(process.env.FIREBASE_ID_TOKEN || '').trim();

const sockets = new Set();
const moveTimers = new Map();
let temporaryAnonymous = false;
const stats = {started:0,opened:0,welcomed:0,authErrors:0,errors:0,rejected:0,closed:0,movesSent:0,serverMoves:0,messages:0,zoneChanges:0};
const statusCounts = new Map();
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function createAnonymousToken() {
  if (!FIREBASE_API_KEY) throw new Error('Set FIREBASE_API_KEY or FIREBASE_ID_TOKEN');
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_API_KEY)}`, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({returnSecureToken:true})
  });
  const b = await r.json().catch(()=>({}));
  if (!r.ok || !b.idToken) throw new Error(`Anonymous Firebase sign-in failed: ${b?.error?.message || r.status}`);
  temporaryAnonymous = true;
  return b.idToken;
}

async function deleteAnonymous() {
  if (!temporaryAnonymous || !TOKEN || !FIREBASE_API_KEY) return;
  try {
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${encodeURIComponent(FIREBASE_API_KEY)}`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({idToken:TOKEN})
    });
  } catch (_) {}
}

function zoneForBot(i) {
  const n = i % 100;
  return `${n % 10},${Math.floor(n / 10)}`;
}

function snapshot(label='STAT') {
  const active=[...sockets].filter(ws=>ws.readyState===WebSocket.OPEN).length;
  const statuses=[...statusCounts.entries()].map(([k,v])=>`${k}:${v}`).join(',');
  console.log(`[${label}] started=${stats.started}/${BOT_COUNT} open=${stats.opened} active=${active} welcome=${stats.welcomed} authErr=${stats.authErrors} errors=${stats.errors} rejected=${stats.rejected}${statuses?`(${statuses})`:''} closed=${stats.closed} movesSent=${stats.movesSent} serverMoves=${stats.serverMoves} zoneChanges=${stats.zoneChanges}`);
}

function stopMove(ws) {
  const t=moveTimers.get(ws);
  if (t) clearInterval(t);
  moveTimers.delete(ws);
}

function beginMove(ws, spawn) {
  let x=Number(spawn?.x)||0, y=Number(spawn?.y)||0, z=Number(spawn?.z)||0, r=0;
  const ox=x, oz=z;
  let vx=2.8, vz=2.3;
  const radius=5;
  const t=setInterval(()=>{
    if (ws.readyState!==WebSocket.OPEN) return;
    const dt=MOVE_INTERVAL_MS/1000;
    let nx=x+vx*dt, nz=z+vz*dt;
    if (Math.abs(nx-ox)>radius) { vx*=-1; nx=x+vx*dt; }
    if (Math.abs(nz-oz)>radius) { vz*=-1; nz=z+vz*dt; }
    x=nx; z=nz; r+=0.02;
    try { ws.send(JSON.stringify({type:'move',x,y,z,r})); stats.movesSent++; } catch (_) {}
  },MOVE_INTERVAL_MS);
  moveTimers.set(ws,t);
}

function startBot(i) {
  return new Promise(resolve=>{
    stats.started++;
    let settled=false;
    const zone=zoneForBot(i);
    const ws=new WebSocket(`${BASE}?zone=${zone}`,{handshakeTimeout:15000,perMessageDeflate:false});
    sockets.add(ws);
    const settle=()=>{if(!settled){settled=true;resolve();}};
    ws.on('open',()=>{stats.opened++; try{ws.send(JSON.stringify({type:'auth',token:TOKEN}));}catch(_){}});
    ws.on('unexpected-response',(_req,res)=>{stats.rejected++; const code=Number(res.statusCode)||0; statusCounts.set(code,(statusCounts.get(code)||0)+1); res.resume(); settle();});
    ws.on('message',raw=>{
      stats.messages++;
      let m; try{m=JSON.parse(String(raw));}catch(_){return;}
      if(m?.type==='welcome'){stats.welcomed++; beginMove(ws,m.spawn||{}); settle();}
      else if(m?.type==='auth_error'){stats.authErrors++; settle();}
      else if(m?.type==='move'){stats.serverMoves++;}
      else if(m?.type==='zone_change'){stats.zoneChanges++;}
    });
    ws.on('error',()=>{stats.errors++; settle();});
    ws.on('close',()=>{stopMove(ws); stats.closed++; settle();});
    setTimeout(settle,16000);
  });
}

async function main(){
  if(!TOKEN) TOKEN=await createAnonymousToken();
  console.log('=== VOXEL RUN Phase 2A Zone Load Test ===');
  console.log(`Bots: ${BOT_COUNT}`);
  console.log('Distribution: round-robin across 100 zones');
  console.log(`Duration: ${DURATION_SEC}s | Movement: about ${(1000/MOVE_INTERVAL_MS).toFixed(2)} Hz`);
  const starts=[];
  for(let i=0;i<BOT_COUNT;i++){starts.push(startBot(i)); if(CONNECT_STAGGER_MS) await sleep(CONNECT_STAGGER_MS);}
  const statTimer=setInterval(()=>snapshot(),5000);
  await Promise.allSettled(starts);
  snapshot('CONNECTED');
  await sleep(DURATION_SEC*1000);
  clearInterval(statTimer);
  snapshot('BEFORE-CLOSE');
  for(const ws of sockets){stopMove(ws); try{ws.close(1000,'done');}catch(_){}}
  await sleep(2500);
  snapshot('FINAL');
  await deleteAnonymous();
  if(stats.welcomed===BOT_COUNT && stats.authErrors===0 && stats.errors===0 && stats.rejected===0) console.log('RESULT: Phase 2A distributed zone movement test passed.');
  else console.log('RESULT: investigate errors before increasing bot count.');
}

main().catch(async e=>{console.error(e?.stack||e); await deleteAnonymous(); process.exit(1);});
