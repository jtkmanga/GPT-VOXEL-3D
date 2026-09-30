#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const BASE = process.env.WS_BASE || 'wss://voxel-run-v2-demo.hjinffv5426.workers.dev/play';
const FIREBASE_API_KEY = String(process.env.FIREBASE_API_KEY || '').trim();
let TOKEN = String(process.env.FIREBASE_ID_TOKEN || '').trim();
let temporaryAnonymous = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createAnonymousToken() {
  if (!FIREBASE_API_KEY) throw new Error('Set FIREBASE_API_KEY or FIREBASE_ID_TOKEN');
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
    {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({returnSecureToken:true})
    }
  );
  const b = await r.json().catch(()=>({}));
  if (!r.ok || !b.idToken) throw new Error(`Anonymous Firebase sign-in failed: ${b?.error?.message || r.status}`);
  temporaryAnonymous = true;
  return b.idToken;
}

async function deleteAnonymous() {
  if (!temporaryAnonymous || !TOKEN || !FIREBASE_API_KEY) return;
  try {
    await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${encodeURIComponent(FIREBASE_API_KEY)}`,
      {
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({idToken:TOKEN})
      }
    );
  } catch (_) {}
}

function openSocket(zone) {
  return new Promise((resolve,reject) => {
    const ws = new WebSocket(`${BASE}?zone=${zone}`, {
      handshakeTimeout:15000,
      perMessageDeflate:false
    });
    const timer=setTimeout(()=>reject(new Error(`Timeout opening zone ${zone}`)),16000);
    ws.once('open',()=>{ clearTimeout(timer); resolve(ws); });
    ws.once('unexpected-response',(_req,res)=>{
      clearTimeout(timer);
      reject(new Error(`Zone ${zone} rejected with HTTP ${res.statusCode}`));
      res.resume();
    });
    ws.once('error',err=>{
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitFor(ws, predicate, timeoutMs=16000) {
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>{
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message'));
    },timeoutMs);

    const onMessage=raw=>{
      let m;
      try { m=JSON.parse(String(raw)); } catch (_) { return; }
      if (!predicate(m)) return;
      cleanup();
      resolve(m);
    };
    const onClose=(code,reason)=>{
      cleanup();
      reject(new Error(`Socket closed ${code}: ${String(reason||'')}`));
    };
    const cleanup=()=>{
      clearTimeout(timer);
      ws.off('message',onMessage);
      ws.off('close',onClose);
    };
    ws.on('message',onMessage);
    ws.on('close',onClose);
  });
}

async function main() {
  if (!TOKEN) TOKEN = await createAnonymousToken();

  console.log('=== VOXEL RUN Phase 2B1 handoff test ===');
  console.log('Start zone: 5,5');
  console.log('Goal: cross east border into 6,5 with one-time handoff token');

  const source=await openSocket('5,5');
  source.send(JSON.stringify({type:'auth',token:TOKEN}));
  const welcome=await waitFor(source,m=>m?.type==='welcome');

  console.log('SOURCE WELCOME:', {
    phase:welcome.phase,
    zone:welcome.zone,
    id:welcome.id,
    spawn:welcome.spawn
  });

  if (welcome.zone!=='5,5') throw new Error(`Expected source zone 5,5, got ${welcome.zone}`);

  let x=Number(welcome.spawn?.x)||0;
  let y=Number(welcome.spawn?.y)||0;
  let z=Number(welcome.spawn?.z)||0;
  let r=Number(welcome.spawn?.r)||0;

  const zoneMaxX = -750 + 6 * 150; // east edge of zone 5 = x 150
  const speed=18;                  // below normal anti-cheat cap 26
  const interval=220;
  const step=speed*(interval/1000);

  let handoffMessage=null;
  const handoffPromise=waitFor(source,m=>m?.type==='zone_change',20000).then(m=>{
    handoffMessage=m;
    return m;
  });

  for(let i=0;i<80 && !handoffMessage;i++){
    x += step;
    r += 0.02;
    source.send(JSON.stringify({type:'move',x,y,z,r}));
    await sleep(interval);
    if (x > zoneMaxX + 10) break;
  }

  const handoff=await handoffPromise;
  console.log('ZONE_CHANGE:', {
    from:handoff.from,
    zone:handoff.zone,
    hasToken:Boolean(handoff.handoffToken),
    position:handoff.position
  });

  if (handoff.zone!=='6,5') throw new Error(`Expected target zone 6,5, got ${handoff.zone}`);
  if (!handoff.handoffToken) throw new Error('Missing handoffToken');

  const target=await openSocket(handoff.zone);
  target.send(JSON.stringify({
    type:'auth',
    token:TOKEN,
    handoffToken:handoff.handoffToken
  }));

  const targetWelcome=await waitFor(target,m=>m?.type==='welcome');
  console.log('TARGET WELCOME:', {
    phase:targetWelcome.phase,
    handoff:targetWelcome.handoff,
    fromZone:targetWelcome.fromZone,
    zone:targetWelcome.zone,
    id:targetWelcome.id,
    spawn:targetWelcome.spawn
  });

  if (targetWelcome.phase!=='2B1') throw new Error(`Expected phase 2B1, got ${targetWelcome.phase}`);
  if (targetWelcome.handoff!==true) throw new Error('Target welcome did not confirm handoff');
  if (targetWelcome.zone!=='6,5') throw new Error(`Expected target zone 6,5, got ${targetWelcome.zone}`);
  if (targetWelcome.id!==welcome.id) throw new Error('Player id changed during handoff');

  const hx=Number(handoff.position?.x);
  const tx=Number(targetWelcome.spawn?.x);
  const hz=Number(handoff.position?.z);
  const tz=Number(targetWelcome.spawn?.z);
  if (![hx,tx,hz,tz].every(Number.isFinite) || Math.hypot(hx-tx,hz-tz)>0.01) {
    throw new Error('Target spawn does not match server-authoritative handoff position');
  }

  console.log('PASS: secure one-time zone handoff preserved player id and position.');

  try { target.close(1000,'test complete'); } catch (_) {}
  try { source.close(1000,'test complete'); } catch (_) {}
  await sleep(500);
  await deleteAnonymous();
}

main().catch(async err=>{
  console.error('FAIL:', err?.stack || err);
  await deleteAnonymous();
  process.exit(1);
});
