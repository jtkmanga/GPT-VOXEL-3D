// VOXEL RUN v4 — Firebase Google identity + server-owned coins + persistent leaderboard.
// Scores live in the game's Durable Object, separate from Firebase Realtime Database.
// WORLD_LUCKYBOX_V2_PATCH
const SERVER_MAP_SIZE = 1500;
const SERVER_WORLD_SEED = 'free1';
const SERVER_COIN_COUNT = 200;
const LUCKY_BOX_RESPAWN_MS = 4 * 60 * 60 * 1000;
const LUCKY_BOX_CLAIM_MS = 90 * 1000;
// FREE_10K_PHASE1
// Phase 1: reduce movement traffic and only fan out nearby player movement.
// This is the safe foundation before spatial zone sharding in Phase 2.
const MOVE_TICK_MS = 200;              // 5 movement updates/sec
const PLAYER_VISIBILITY_RADIUS = 120;   // only nearby avatars are streamed
const ROOM_SOFT_CAP = 160;              // temporary per-room test cap before sharding
// FREE_10K_PHASE2A
// Phase 2A: additive movement-zone sharding.
// Existing /play without ?zone= stays on the already-tested Phase 1 room.
const ZONE_GRID_SIZE = 10;              // 10 x 10 = 100 movement zones
const ZONE_SIZE = SERVER_MAP_SIZE / ZONE_GRID_SIZE;
const ZONE_SOFT_CAP = 120;              // temporary per-zone soft cap
// FREE_10K_PHASE2B1
// B1: secure zone handoff tickets + global coin/Lucky Box actions.
// FREE_10K_PHASE2B2
// B2: cross-zone border visibility via throttled zone snapshots.
// FREE_10K_PHASE2C1_1_SMOOTH_HANDOFF
// Smooth handoff: client may keep moving locally while target Zone connects;
// target validates one authoritative handoff_resume before normal movement resumes.
const BORDER_SNAPSHOT_INTERVAL_MS = 500; // max 2 snapshot flushes/sec/active zone

function normalizeZoneId(value) {
  const m = /^(\d{1,2}),(\d{1,2})$/.exec(String(value || ''));
  if (!m) return null;

  const zx = Number(m[1]);
  const zz = Number(m[2]);

  if (
    !Number.isInteger(zx) ||
    !Number.isInteger(zz) ||
    zx < 0 ||
    zz < 0 ||
    zx >= ZONE_GRID_SIZE ||
    zz >= ZONE_GRID_SIZE
  ) return null;

  return `${zx},${zz}`;
}

function zoneCenter(zoneId) {
  const normalized = normalizeZoneId(zoneId);
  if (!normalized) return null;
  const [zx,zz] = normalized.split(',').map(Number);
  const min = -SERVER_MAP_SIZE / 2;
  return {
    x: min + zx * ZONE_SIZE + ZONE_SIZE / 2,
    z: min + zz * ZONE_SIZE + ZONE_SIZE / 2
  };
}

function zoneFromPosition(x,z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const half = SERVER_MAP_SIZE / 2;
  if (x < -half || x >= half || z < -half || z >= half) return null;
  const zx = Math.min(ZONE_GRID_SIZE - 1, Math.max(0, Math.floor((x + half) / ZONE_SIZE)));
  const zz = Math.min(ZONE_GRID_SIZE - 1, Math.max(0, Math.floor((z + half) / ZONE_SIZE)));
  return `${zx},${zz}`;
}


function zoneIdsNearPosition(x,z,radius=PLAYER_VISIBILITY_RADIUS) {
  if (![x,z,radius].every(Number.isFinite)) return [];
  const half=SERVER_MAP_SIZE/2;
  const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
  const minX=clamp(x-radius,-half,half-0.0001);
  const maxX=clamp(x+radius,-half,half-0.0001);
  const minZ=clamp(z-radius,-half,half-0.0001);
  const maxZ=clamp(z+radius,-half,half-0.0001);
  const toIndex=v=>Math.min(ZONE_GRID_SIZE-1,Math.max(0,Math.floor((v+half)/ZONE_SIZE)));
  const x0=toIndex(minX), x1=toIndex(maxX), z0=toIndex(minZ), z1=toIndex(maxZ);
  const out=[];
  for(let zz=z0;zz<=z1;zz++) for(let xx=x0;xx<=x1;xx++) out.push(`${xx},${zz}`);
  return out;
}

function allZoneIds() {
  const out=[];
  for(let zz=0;zz<ZONE_GRID_SIZE;zz++) for(let xx=0;xx<ZONE_GRID_SIZE;xx++) out.push(`${xx},${zz}`);
  return out;
}

function zonesAreAdjacent(a,b) {
  const aa=normalizeZoneId(a), bb=normalizeZoneId(b);
  if(!aa || !bb || aa===bb) return false;
  const [ax,az]=aa.split(',').map(Number);
  const [bx,bz]=bb.split(',').map(Number);
  return Math.abs(ax-bx)<=1 && Math.abs(az-bz)<=1;
}


function adjacentZoneIds(zoneId) {
  const normalized=normalizeZoneId(zoneId);
  if(!normalized) return [];
  const [zx,zz]=normalized.split(',').map(Number);
  const out=[];
  for(let dz=-1;dz<=1;dz++) {
    for(let dx=-1;dx<=1;dx++) {
      if(dx===0 && dz===0) continue;
      const nx=zx+dx, nz=zz+dz;
      if(nx<0 || nz<0 || nx>=ZONE_GRID_SIZE || nz>=ZONE_GRID_SIZE) continue;
      out.push(`${nx},${nz}`);
    }
  }
  return out;
}


function serverSeededRandom(seedText) {
  let seed = 2166136261;
  const str = String(seedText || 'default-map');
  for (let i = 0; i < str.length; i++) {
    seed ^= str.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return function() {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildServerCollisionWorld(seedText) {
  const rng = serverSeededRandom(seedText);
  const buildings = [];
  const trees = [];

  for (let bx = -600; bx <= 600; bx += 200) {
    for (let bz = -600; bz <= 600; bz += 200) {
      if (Math.abs(bx) < 100 && Math.abs(bz) < 100) continue;
      const width = 18 + Math.floor(rng() * 20);
      const depth = 18 + Math.floor(rng() * 20);
      28 + Math.floor(rng() * 65); // advance height RNG
      Math.floor(rng() * 3);       // advance material RNG
      const posX = bx + (rng() - 0.5) * 60;
      const posZ = bz + (rng() - 0.5) * 60;
      buildings.push({
        minX: posX - width / 2 - 2,
        maxX: posX + width / 2 + 2,
        minZ: posZ - depth / 2 - 2,
        maxZ: posZ + depth / 2 + 2
      });
    }
  }

  for (let i = 0; i < 250; i++) {
    const tx = (rng() - 0.5) * (SERVER_MAP_SIZE - 50);
    const tz = (rng() - 0.5) * (SERVER_MAP_SIZE - 50);
    const insideBuilding = buildings.some(b => tx >= b.minX && tx <= b.maxX && tz >= b.minZ && tz <= b.maxZ);
    if (insideBuilding || (Math.abs(tx) < 25 && Math.abs(tz) < 25)) continue;
    6 + rng() * 4; // advance trunkHeight RNG
    6 + rng() * 3; // advance leafSize RNG
    trees.push({
      minX: tx - 1.8,
      maxX: tx + 1.8,
      minZ: tz - 1.8,
      maxZ: tz + 1.8
    });
  }

  return { buildings, trees };
}

const SERVER_WORLD = buildServerCollisionWorld(SERVER_WORLD_SEED);

function safeWorldPosition(seedText, minDistanceFromSpawn = 0, margin = 12) {
  const rng = serverSeededRandom(seedText);
  let rx = 0, rz = 0;
  for (let attempt = 0; attempt < 2000; attempt++) {
    rx = (rng() - 0.5) * (SERVER_MAP_SIZE - margin);
    rz = (rng() - 0.5) * (SERVER_MAP_SIZE - margin);
    if (minDistanceFromSpawn > 0 && Math.hypot(rx, rz) < minDistanceFromSpawn) continue;
    const collision =
      SERVER_WORLD.buildings.some(b => rx >= b.minX && rx <= b.maxX && rz >= b.minZ && rz <= b.maxZ) ||
      SERVER_WORLD.trees.some(t => rx >= t.minX && rx <= t.maxX && rz >= t.minZ && rz <= t.maxZ);
    if (!collision) return { x: rx, z: rz };
  }
  return { x: minDistanceFromSpawn + 50, z: 0 };
}

function coinPosition(id, cycle = 0) {
  return safeWorldPosition(`${SERVER_WORLD_SEED}:coin:${Number(id) || 0}:cycle:${Number(cycle) || 0}`, 0, 12);
}

const COINS = Array.from({length:SERVER_COIN_COUNT}, (_,id) => {
  const pos = coinPosition(id, 0);
  return [pos.x, pos.z];
});

function luckyBoxPosition(cycle = 0) {
  return safeWorldPosition(`${SERVER_WORLD_SEED}:position:lucky-box-${Number(cycle) || 0}`, 120, 20);
}

function secureLuckyReward() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  const roll = (a[0] / 4294967296) * 100;
  if (roll < 50) return 100;      // 50.0%
  if (roll < 80) return 500;      // 30.0%
  if (roll < 99) return 1000;     // 19.0%
  if (roll < 99.9) return 5000;   // 0.9%
  return 9999;                    // 0.1%
}

const RESPAWN_MS = 60_000;
const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let cachedCerts = null, certsExpireAt = 0;

function decodeBase64(value) {
  const normalized = value.replace(/-/g,'+').replace(/_/g,'/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,'='));
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
function readTlv(data,start) {
  if (start>=data.length) throw Error('Invalid certificate');
  const tag=data[start], lengthByte=data[start+1];
  if (lengthByte===undefined) throw Error('Invalid certificate');
  let length=lengthByte, header=2;
  if (lengthByte&0x80) {
    const count=lengthByte&0x7f;
    if (!count || count>3 || start+2+count>data.length) throw Error('Invalid certificate');
    length=0;
    for(let i=0;i<count;i++) length=length*256+data[start+2+i];
    header+=count;
  }
  const end=start+header+length;
  if (end>data.length) throw Error('Invalid certificate');
  return {tag,start,value:start+header,end};
}
function extractSpki(pem) {
  const raw=pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!raw) throw Error('Invalid certificate');
  const data=decodeBase64(raw[1].replace(/\s/g,''));
  const cert=readTlv(data,0), tbs=readTlv(data,cert.value);
  if (cert.tag!==0x30 || tbs.tag!==0x30 || cert.end!==data.length) throw Error('Invalid certificate');
  let offset=tbs.value;
  if (data[offset]===0xa0) offset=readTlv(data,offset).end; // optional version
  for(let i=0;i<5;i++) offset=readTlv(data,offset).end; // serial, sig, issuer, validity, subject
  const spki=readTlv(data,offset);
  if (spki.tag!==0x30 || spki.end>tbs.end) throw Error('Invalid certificate');
  return data.slice(spki.start,spki.end);
}
async function getCert(kid) {
  const now=Date.now();
  if (!cachedCerts || now>=certsExpireAt || !cachedCerts[kid]) {
    const response=await fetch(CERTS_URL);
    if (!response.ok) throw Error('Firebase certificates unavailable');
    const certs=await response.json();
    if (!certs || typeof certs!=='object') throw Error('Firebase certificates unavailable');
    const match=response.headers.get('cache-control')?.match(/max-age=(\d+)/i);
    cachedCerts=certs;
    certsExpireAt=now+Math.min(Number(match?.[1])||300,3600)*1000;
  }
  if (typeof cachedCerts[kid]!=='string') throw Error('Unknown Firebase signing key');
  return cachedCerts[kid];
}
export async function verifyFirebaseIdToken(token,projectId) {
  if (typeof token!=='string' || token.length>8192 || token.length<100 || !projectId) throw Error('Invalid token');
  const parts=token.split('.');
  if (parts.length!==3) throw Error('Invalid token');
  const header=JSON.parse(new TextDecoder().decode(decodeBase64(parts[0])));
  const claims=JSON.parse(new TextDecoder().decode(decodeBase64(parts[1])));
  const now=Math.floor(Date.now()/1000);
  if (header?.alg!=='RS256' || typeof header.kid!=='string' || header.kid.length>200 ||
      claims?.aud!==projectId || claims.iss!==`https://securetoken.google.com/${projectId}` ||
      typeof claims.sub!=='string' || !claims.sub || claims.sub.length>128 ||
      !Number.isInteger(claims.exp) || claims.exp<=now ||
      !Number.isInteger(claims.iat) || claims.iat>now ||
      !Number.isInteger(claims.auth_time) || claims.auth_time>now) throw Error('Invalid token claims');
  const publicKey=await crypto.subtle.importKey('spki',extractSpki(await getCert(header.kid)),
    {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',publicKey,
    decodeBase64(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
  if (!valid) throw Error('Invalid token signature');
  return {uid:claims.sub,exp:claims.exp};
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || origin;

  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Vary': 'Origin'
  };
}

function jsonResponse(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, env),
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

async function handleVerifySlip(request, env) {
  if (
    env.ALLOWED_ORIGIN &&
    request.headers.get('Origin') !== env.ALLOWED_ORIGIN
  ) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Origin not allowed'
    }, 403);
  }

  const authHeader = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);

  if (!match) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Sign in required'
    }, 401);
  }

  let verified;

  try {
    verified = await verifyFirebaseIdToken(
      match[1],
      env.FIREBASE_PROJECT_ID
    );
  } catch {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Invalid Firebase token'
    }, 401);
  }

  let input;

  try {
    input = await request.formData();
  } catch {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Invalid form data'
    }, 400);
  }

  const file = input.get('file');
  const item = String(input.get('item') || '');

  const prices = {
    speed: 10,
    coin: 20,
    vip1: 50
  };

  const price = prices[item];

  if (!price) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Invalid item'
    }, 400);
  }

  if (!(file instanceof File) || file.size <= 0) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Slip image required'
    }, 400);
  }

  if (file.size > 8 * 1024 * 1024) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Slip image too large'
    }, 413);
  }

  if (!String(file.type || '').startsWith('image/')) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Image file required'
    }, 400);
  }

  if (!env.SLIP2GO_API_SECRET || !env.PAYMENT_RECEIVER_ACCOUNT) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Payment server is not configured'
    }, 500);
  }

  const payload = {
    checkDuplicate: true,
    checkReceiver: [{
      accountType: '02001',
      accountNumber: env.PAYMENT_RECEIVER_ACCOUNT
    }],
    checkAmount: {
      type: 'eq',
      amount: String(price)
    }
  };

  const slipForm = new FormData();
  slipForm.append('file', file, file.name || 'slip.jpg');
  slipForm.append('payload', JSON.stringify(payload));

  let slipResponse;

  try {
    slipResponse = await fetch(
      'https://connect.slip2go.com/api/verify-slip/qr-image/info',
      {
        method: 'POST',
        headers: {
          'Authorization': env.SLIP2GO_API_SECRET
        },
        body: slipForm
      }
    );
  } catch {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Slip verification service unavailable'
    }, 502);
  }

  let result;

  try {
    result = await slipResponse.json();
  } catch {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Invalid response from slip service'
    }, 502);
  }

  if (!slipResponse.ok || result?.code !== '200000') {
    return jsonResponse(request, env, {
      ok: false,
      error: result?.message || 'Slip verification failed',
      code: result?.code || null
    }, 400);
  }

  const slipData = result?.data || {};
  const actualAmount = Number(slipData.amount);

  // ตรวจยอดจากผลตอบกลับอีกครั้ง แม้เราจะส่ง checkAmount ให้ Slip2Go แล้ว
  if (!Number.isFinite(actualAmount) || actualAmount !== price) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Slip amount does not match item price'
    }, 400);
  }

  const transRef = String(slipData.transRef || '').trim();
  const referenceId = String(slipData.referenceId || '').trim();
  const senderBankId = String(
    slipData?.sender?.bank?.id || ''
  ).trim();

  let transactionId = '';

  if (transRef) {
    transactionId = `${senderBankId || 'bank'}:${transRef}`;
  } else if (referenceId) {
    transactionId = `ref:${referenceId}`;
  }

  if (!transactionId) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Slip transaction reference missing'
    }, 502);
  }

  // ให้ Durable Object เป็นคนมอบสิทธิ์จริง
  let grantResponse;

  try {
    grantResponse = await env.ROOM
      .getByName('free-v2-demo')
      .fetch(
        new Request(
          'https://internal/_internal/grant-payment',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              uid: verified.uid,
              item,
              amount: price,
              transactionId
            })
          }
        )
      );
  } catch {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Could not grant purchased item'
    }, 500);
  }

  let grantResult;

  try {
    grantResult = await grantResponse.json();
  } catch {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Invalid payment storage response'
    }, 500);
  }

  if (!grantResponse.ok || !grantResult?.ok) {
    return jsonResponse(request, env, {
      ok: false,
      error: grantResult?.error || 'Could not grant purchased item',
      duplicate: grantResult?.duplicate === true
    }, grantResult?.duplicate ? 409 : 400);
  }

  return jsonResponse(request, env, {
    ok: true,
    verified: true,
    item,
    price,
    expiresAt: grantResult.expiresAt,
    entitlements: grantResult.entitlements
  });
}


async function handleGetEntitlements(request, env) {
  if (
    env.ALLOWED_ORIGIN &&
    request.headers.get('Origin') !== env.ALLOWED_ORIGIN
  ) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Origin not allowed'
    }, 403);
  }

  const authHeader = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);

  if (!match) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Sign in required'
    }, 401);
  }

  let verified;

  try {
    verified = await verifyFirebaseIdToken(
      match[1],
      env.FIREBASE_PROJECT_ID
    );
  } catch {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Invalid Firebase token'
    }, 401);
  }

  let roomResponse;

  try {
    roomResponse = await env.ROOM
      .getByName('free-v2-demo')
      .fetch(
        new Request(
          'https://internal/_internal/get-entitlements',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              uid: verified.uid
            })
          }
        )
      );
  } catch {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Could not read entitlements'
    }, 500);
  }

  let result;

  try {
    result = await roomResponse.json();
  } catch {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Invalid entitlement response'
    }, 500);
  }

  if (!roomResponse.ok || !result?.ok) {
    return jsonResponse(request, env, {
      ok: false,
      error: result?.error || 'Could not read entitlements'
    }, 400);
  }

  return jsonResponse(request, env, result);
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);

    if (url.pathname==='/health')
      return new Response('VOXEL RUN v4 online',
        {headers:{'content-type':'text/plain; charset=utf-8'}});

    if (url.pathname==='/entitlements') {
      if (request.method==='OPTIONS')
        return new Response(null,{
          status:204,
          headers:corsHeaders(request,env)
        });

      if (request.method!=='GET')
        return jsonResponse(request,env,{
          ok:false,
          error:'Method not allowed'
        },405);

      return handleGetEntitlements(request,env);
    }

    if (url.pathname==='/verify-slip') {
      if (request.method==='OPTIONS')
        return new Response(null,{
          status:204,
          headers:corsHeaders(request,env)
        });

      if (request.method!=='POST')
        return jsonResponse(request,env,{
          ok:false,
          error:'Method not allowed'
        },405);

      return handleVerifySlip(request,env);
    }

    if (
      url.pathname!='/play' ||
      request.headers.get('Upgrade')?.toLowerCase()!=='websocket'
    )
      return new Response('WebSocket endpoint: /play',{status:404});

    if (
      env.ALLOWED_ORIGIN &&
      request.headers.get('Origin')!==env.ALLOWED_ORIGIN
    )
      return new Response('Origin not allowed',{status:403});

    const requestedZone = url.searchParams.get('zone');
    if (requestedZone !== null) {
      const zoneId = normalizeZoneId(requestedZone);
      if (!zoneId) return new Response('Invalid zone',{status:400});
      const [zoneX, zoneZ] = zoneId.split(',');
      const zoneRequest = new Request(
        `https://zone.internal/play-zone/${zoneX}/${zoneZ}`,
        request
      );
      return env.ZONE.getByName(`free-zone-${zoneId}`).fetch(zoneRequest);
    }

    // Backward-compatible path: current game remains on the tested Phase 1 room.
    return env.ROOM.getByName('free-v2-demo').fetch(request);
  }
};

export class GameRoom {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.projectId=env.FIREBASE_PROJECT_ID;
    this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS voxel_scores (uid TEXT PRIMARY KEY, nickname TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS voxel_coins (id INTEGER PRIMARY KEY, respawn_at INTEGER NOT NULL)');
    try { this.sql.exec('ALTER TABLE voxel_coins ADD COLUMN cycle INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_lucky_box (
      id INTEGER PRIMARY KEY,
      next_spawn_at INTEGER NOT NULL DEFAULT 0,
      cycle INTEGER NOT NULL DEFAULT 0,
      claimed_uid TEXT,
      claim_expires_at INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`INSERT OR IGNORE INTO voxel_lucky_box
      (id, next_spawn_at, cycle, claimed_uid, claim_expires_at)
      VALUES (1, 0, 0, NULL, 0)`);

    // Server-authoritative paid entitlements
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_entitlements (
      uid TEXT PRIMARY KEY,
      speed_expires INTEGER NOT NULL DEFAULT 0,
      coin_expires INTEGER NOT NULL DEFAULT 0,
      vip1_expires INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`);

    // One payment transaction can only be granted once
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_payments (
      transaction_id TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      item TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_zone_handoffs (
      token TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      player_id TEXT NOT NULL,
      from_zone TEXT NOT NULL,
      to_zone TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      r REAL NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS voxel_zone_handoffs_exp_idx ON voxel_zone_handoffs(expires_at)');

    this.ready=ctx.blockConcurrencyWhile(async()=>{
      // Preserve the existing v3 coin cooldowns when the room upgrades.
      const old=await ctx.storage.get('coinRespawns');
      if (old && typeof old==='object') {
        ctx.storage.transactionSync(()=>{
          for(const [id,value] of Object.entries(old)) if (Number.isInteger(Number(id)) &&
              Number(id)>=0 && Number(id)<COINS.length && Number.isFinite(Number(value)))
            this.sql.exec('INSERT INTO voxel_coins(id,respawn_at) VALUES (?,?) ON CONFLICT(id) DO NOTHING',Number(id),Number(value));
        });
        await ctx.storage.delete('coinRespawns');
      }
    });
  }
  player(ws) { return ws.deserializeAttachment(); }
  sockets() { return this.ctx.getWebSockets(); }
  count() { return this.sockets().filter(ws=>this.player(ws)?.uid).length; }
  send(ws,value) { try { ws.send(JSON.stringify(value)); } catch (_) {} }
  broadcast(value,except) {
    const data=JSON.stringify(value);
    for(const ws of this.sockets()) if(ws!==except && this.player(ws)?.uid) {
      try { ws.send(data); } catch (_) {}
    }
  }
  nearbySockets(sourcePlayer, except) {
    if (!sourcePlayer?.uid) return [];
    const out=[];
    const maxD2=PLAYER_VISIBILITY_RADIUS*PLAYER_VISIBILITY_RADIUS;
    for (const ws of this.sockets()) {
      if (ws===except) continue;
      const other=this.player(ws);
      if (!other?.uid) continue;
      const dx=(Number(other.x)||0)-(Number(sourcePlayer.x)||0);
      const dz=(Number(other.z)||0)-(Number(sourcePlayer.z)||0);
      if (dx*dx+dz*dz<=maxD2) out.push(ws);
    }
    return out;
  }
  broadcastNearby(value,sourcePlayer,except) {
    const data=JSON.stringify(value);
    for (const ws of this.nearbySockets(sourcePlayer,except)) {
      try { ws.send(data); } catch (_) {}
    }
  }
  publicPlayer(p) { return p?.uid && {id:p.id,x:p.x,y:p.y,z:p.z,r:p.r}; }
  coinSnapshot() {
    const rows = new Map(
      this.sql.exec('SELECT id, respawn_at, cycle FROM voxel_coins').toArray()
        .map(row => [Number(row.id), {respawnAt:Number(row.respawn_at)||0, cycle:Number(row.cycle)||0}])
    );
    return COINS.map((_,id) => {
      const row = rows.get(id) || {respawnAt:0, cycle:0};
      const pos = coinPosition(id, row.cycle);
      return {id,x:pos.x,z:pos.z,respawnAt:row.respawnAt,cycle:row.cycle};
    });
  }
  top() {
    return this.sql.exec('SELECT nickname, score FROM voxel_scores ORDER BY score DESC, updated_at ASC LIMIT 10').toArray();
  }

  async sendZoneEvent(zoneIds,event) {
    const ids=[...new Set((zoneIds||[]).map(normalizeZoneId).filter(Boolean))];
    if (!ids.length) return;
    const body=JSON.stringify(event);
    await Promise.allSettled(ids.map(zoneId=>
      this.env.ZONE.getByName(`free-zone-${zoneId}`).fetch(
        new Request('https://zone.internal/_internal/world-event',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body
        })
      )
    ));
  }

  async sendAllZones(event) {
    return this.sendZoneEvent(allZoneIds(),event);
  }

  grantPayment(uid, item, amount, transactionId) {
    if (
      typeof uid !== 'string' || !uid ||
      typeof transactionId !== 'string' || !transactionId
    ) {
      return { ok:false, error:'Invalid payment data' };
    }

    const config = {
      speed: {
        price: 10,
        column: 'speed_expires',
        duration: 24 * 60 * 60 * 1000
      },
      coin: {
        price: 20,
        column: 'coin_expires',
        duration: 24 * 60 * 60 * 1000
      },
      vip1: {
        price: 50,
        column: 'vip1_expires',
        duration: 30 * 24 * 60 * 60 * 1000
      }
    };

    const cfg = config[item];

    if (!cfg || Number(amount) !== cfg.price) {
      return { ok:false, error:'Invalid item or amount' };
    }

    const now = Date.now();

    return this.ctx.storage.transactionSync(() => {
      const oldPayment = this.sql.exec(
        'SELECT transaction_id FROM voxel_payments WHERE transaction_id=?',
        transactionId
      ).toArray()[0];

      if (oldPayment) {
        return { ok:false, duplicate:true, error:'Payment already granted' };
      }

      const current = this.sql.exec(
        'SELECT speed_expires, coin_expires, vip1_expires FROM voxel_entitlements WHERE uid=?',
        uid
      ).toArray()[0] || {
        speed_expires: 0,
        coin_expires: 0,
        vip1_expires: 0
      };

      const currentExpiry = Number(current[cfg.column]) || 0;

      // VIP จำกัดสูงสุด 100 บัญชีที่ยังมีสิทธิ์ใช้งาน
      // ผู้ที่มี VIP อยู่แล้วสามารถต่ออายุได้แม้ครบ 100 คน
      if (item === 'vip1' && currentExpiry <= now) {
        const activeVipCount = Number(
          this.sql.exec(
            'SELECT COUNT(*) AS count FROM voxel_entitlements WHERE vip1_expires>?',
            now
          ).toArray()[0]?.count || 0
        );

        if (activeVipCount >= 100) {
          return {
            ok:false,
            error:'VIP server is full'
          };
        }
      }

      const base = currentExpiry > now ? currentExpiry : now;
      const newExpiry = base + cfg.duration;

      this.sql.exec(
        `INSERT INTO voxel_entitlements
          (uid, speed_expires, coin_expires, vip1_expires, updated_at)
         VALUES (?, 0, 0, 0, ?)
         ON CONFLICT(uid) DO NOTHING`,
        uid, now
      );

      this.sql.exec(
        `UPDATE voxel_entitlements
         SET ${cfg.column}=?, updated_at=?
         WHERE uid=?`,
        newExpiry, now, uid
      );

      this.sql.exec(
        `INSERT INTO voxel_payments
          (transaction_id, uid, item, amount, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        transactionId, uid, item, cfg.price, now
      );

      const entitlements = this.sql.exec(
        `SELECT speed_expires, coin_expires, vip1_expires
         FROM voxel_entitlements WHERE uid=?`,
        uid
      ).toArray()[0];

      return {
        ok:true,
        item,
        expiresAt:newExpiry,
        entitlements
      };
    });
  }

  async fetch(request) {
    await this.ready;

    const url = new URL(request.url);

    if (
      url.pathname === '/_internal/get-entitlements' &&
      request.method === 'POST'
    ) {
      let body;

      try {
        body = await request.json();
      } catch {
        return Response.json(
          { ok:false, error:'Invalid JSON' },
          { status:400 }
        );
      }

      const uid = String(body.uid || '');

      if (!uid || uid.length > 128) {
        return Response.json(
          { ok:false, error:'Invalid UID' },
          { status:400 }
        );
      }

      const now = Date.now();

      const row = this.sql.exec(
        `SELECT speed_expires, coin_expires, vip1_expires
         FROM voxel_entitlements
         WHERE uid=?`,
        uid
      ).toArray()[0] || {
        speed_expires: 0,
        coin_expires: 0,
        vip1_expires: 0
      };

      const speedExpires = Number(row.speed_expires) || 0;
      const coinExpires = Number(row.coin_expires) || 0;
      const vip1Expires = Number(row.vip1_expires) || 0;

      const vip1Count = Number(
        this.sql.exec(
          'SELECT COUNT(*) AS count FROM voxel_entitlements WHERE vip1_expires>?',
          now
        ).toArray()[0]?.count || 0
      );

      return Response.json({
        ok:true,
        serverNow:now,
        entitlements:{
          speedExpires,
          coinExpires,
          vip1Expires
        },
        servers:{
          vip1:{
            count:vip1Count,
            max:100
          }
        },
        active:{
          speed:speedExpires > now,
          coin:coinExpires > now,
          vip1:vip1Expires > now
        }
      });
    }



    // FREE_10K_PHASE2B1 — secure one-time handoff tickets.
    if (
      url.pathname === '/_internal/create-zone-handoff' &&
      request.method === 'POST'
    ) {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid=String(body?.uid||'');
      const playerId=String(body?.playerId||'');
      const fromZone=normalizeZoneId(body?.fromZone);
      const toZone=normalizeZoneId(body?.toZone);
      const x=Number(body?.x), y=Number(body?.y), z=Number(body?.z), r=Number(body?.r);

      if (!uid || uid.length>128 || !playerId || playerId.length>128 ||
          !fromZone || !toZone || !zonesAreAdjacent(fromZone,toZone) ||
          ![x,y,z,r].every(Number.isFinite) ||
          Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 ||
          zoneFromPosition(x,z)!==toZone) {
        return Response.json({ok:false,error:'Invalid handoff'},{status:400});
      }

      const now=Date.now();
      const expiresAt=now+12000;
      const token=crypto.randomUUID();
      this.sql.exec('DELETE FROM voxel_zone_handoffs WHERE expires_at<=?',now);
      this.sql.exec(
        `INSERT INTO voxel_zone_handoffs
         (token,uid,player_id,from_zone,to_zone,x,y,z,r,expires_at,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        token,uid,playerId,fromZone,toZone,x,y,z,r,expiresAt,now
      );

      return Response.json({ok:true,token,expiresAt,toZone});
    }

    if (
      url.pathname === '/_internal/consume-zone-handoff' &&
      request.method === 'POST'
    ) {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid=String(body?.uid||'');
      const token=String(body?.token||'');
      const toZone=normalizeZoneId(body?.toZone);
      const now=Date.now();

      if (!uid || uid.length>128 || !token || token.length>128 || !toZone) {
        return Response.json({ok:false,error:'Invalid handoff'},{status:400});
      }

      const result=this.ctx.storage.transactionSync(()=>{
        const row=this.sql.exec(
          `SELECT token,uid,player_id,from_zone,to_zone,x,y,z,r,expires_at,created_at
           FROM voxel_zone_handoffs WHERE token=?`,
          token
        ).toArray()[0];

        if (!row || row.uid!==uid || row.to_zone!==toZone || Number(row.expires_at||0)<=now) {
          return null;
        }

        this.sql.exec('DELETE FROM voxel_zone_handoffs WHERE token=?',token);
        return {
          playerId:String(row.player_id),
          fromZone:String(row.from_zone),
          toZone:String(row.to_zone),
          x:Number(row.x),y:Number(row.y),z:Number(row.z),r:Number(row.r),
          createdAt:Number(row.created_at)||now
        };
      });

      if (!result) return Response.json({ok:false,error:'Handoff expired or invalid'},{status:409});
      return Response.json({ok:true,...result,serverNow:now});
    }

    // Global coin collection for zoned players.
    if (
      url.pathname === '/_internal/zone-collect' &&
      request.method === 'POST'
    ) {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid=String(body?.uid||'');
      const id=Number(body?.id);
      const px=Number(body?.x), py=Number(body?.y), pz=Number(body?.z);
      const now=Date.now();

      if (!uid || uid.length>128 || !Number.isInteger(id) || id<0 || id>=COINS.length ||
          ![px,py,pz].every(Number.isFinite)) {
        return Response.json({ok:false,error:'Invalid collect request'},{status:400});
      }

      const visibleRow=this.sql.exec(
        'SELECT respawn_at,cycle FROM voxel_coins WHERE id=?',id
      ).toArray()[0] || {respawn_at:0,cycle:0};
      const visibleCycle=Number(visibleRow.cycle||0);
      const oldPos=coinPosition(id,visibleCycle);

      if (Math.hypot(px-oldPos.x,pz-oldPos.z)>2.35 || py>2.6) {
        return Response.json({ok:false,error:'Too far from coin'},{status:403});
      }

      let result;
      try {
        result=this.ctx.storage.transactionSync(()=>{
          const row=this.sql.exec(
            'SELECT respawn_at,cycle FROM voxel_coins WHERE id=?',id
          ).toArray()[0] || {respawn_at:0,cycle:0};
          const activeAfter=Number(row.respawn_at)||0;
          const oldCycle=Number(row.cycle)||0;
          if (activeAfter>now) return {collected:false,activeAfter,oldCycle};

          const nextCycle=oldCycle+1;
          const respawnAt=now+RESPAWN_MS;
          this.sql.exec(
            `INSERT INTO voxel_coins(id,respawn_at,cycle) VALUES (?,?,?)
             ON CONFLICT(id) DO UPDATE SET respawn_at=excluded.respawn_at,cycle=excluded.cycle`,
            id,respawnAt,nextCycle
          );

          const ent=this.sql.exec(
            'SELECT coin_expires FROM voxel_entitlements WHERE uid=?',uid
          ).toArray()[0];
          const reward=Number(ent?.coin_expires||0)>now ? 2 : 1;

          this.sql.exec(
            'UPDATE voxel_scores SET score=score+?,updated_at=? WHERE uid=?',
            reward,now,uid
          );
          const score=Number(
            this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score||0
          );
          return {collected:true,respawnAt,nextCycle,oldCycle,reward,score};
        });
      } catch (_) {
        return Response.json({ok:false,error:'Score storage unavailable'},{status:500});
      }

      if (!result.collected) {
        return Response.json({
          ok:true,collected:false,id,activeAfter:result.activeAfter,serverNow:now
        });
      }

      const nextPos=coinPosition(id,result.nextCycle);
      const event={
        type:'coin_collected',id,x:nextPos.x,z:nextPos.z,cycle:result.nextCycle,
        respawnAt:result.respawnAt,serverNow:now
      };
      const affected=[
        ...zoneIdsNearPosition(oldPos.x,oldPos.z),
        ...zoneIdsNearPosition(nextPos.x,nextPos.z)
      ];
      await this.sendZoneEvent(affected,event);

      return Response.json({
        ok:true,collected:true,event,score:result.score,reward:result.reward,
        leaderboard:this.top(),serverNow:now
      });
    }

    if (
      url.pathname === '/_internal/zone-collect-box' &&
      request.method === 'POST'
    ) {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid=String(body?.uid||'');
      const px=Number(body?.x), py=Number(body?.y), pz=Number(body?.z);
      const now=Date.now();
      if (!uid || uid.length>128 || ![px,py,pz].every(Number.isFinite)) {
        return Response.json({ok:false,error:'Invalid Lucky Box request'},{status:400});
      }

      const snap=this.boxSnapshot(now);
      if (!snap.active) {
        return Response.json({ok:true,claimed:false,box:snap,serverNow:now});
      }
      if (Math.hypot(px-snap.x,pz-snap.z)>2.8 || py>3.2) {
        return Response.json({ok:false,error:'Too far from Lucky Box'},{status:403});
      }

      let claimed=false;
      try {
        claimed=this.ctx.storage.transactionSync(()=>{
          const row=this.sql.exec(
            'SELECT next_spawn_at,claimed_uid,claim_expires_at FROM voxel_lucky_box WHERE id=1'
          ).toArray()[0];
          if (!row || Number(row.next_spawn_at||0)>now) return false;
          if (row.claimed_uid && Number(row.claim_expires_at||0)>now && row.claimed_uid!==uid) return false;
          this.sql.exec(
            'UPDATE voxel_lucky_box SET claimed_uid=?,claim_expires_at=? WHERE id=1',
            uid,now+LUCKY_BOX_CLAIM_MS
          );
          return true;
        });
      } catch (_) {
        return Response.json({ok:false,error:'Lucky Box storage unavailable'},{status:500});
      }

      const state=this.boxSnapshot(now);
      await this.sendAllZones({type:'box_state',box:state,serverNow:now});
      return Response.json({ok:true,claimed,box:state,serverNow:now});
    }

    if (
      url.pathname === '/_internal/zone-spin-box' &&
      request.method === 'POST'
    ) {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid=String(body?.uid||'');
      const now=Date.now();
      if (!uid || uid.length>128) {
        return Response.json({ok:false,error:'Invalid Lucky Box request'},{status:400});
      }

      const reward=secureLuckyReward();
      let result;
      try {
        result=this.ctx.storage.transactionSync(()=>{
          const row=this.sql.exec(
            'SELECT next_spawn_at,cycle,claimed_uid,claim_expires_at FROM voxel_lucky_box WHERE id=1'
          ).toArray()[0];
          if (!row) return {ok:false,error:'Lucky Box state missing'};
          if (Number(row.next_spawn_at||0)>now) return {ok:false,error:'Lucky Box is cooling down'};
          if (row.claimed_uid!==uid || Number(row.claim_expires_at||0)<=now) {
            return {ok:false,error:'Lucky Box claim expired'};
          }

          this.sql.exec(
            'UPDATE voxel_scores SET score=score+?,updated_at=? WHERE uid=?',
            reward,now,uid
          );
          const score=Number(
            this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score||0
          );
          const nextSpawnAt=now+LUCKY_BOX_RESPAWN_MS;
          const nextCycle=Number(row.cycle||0)+1;
          this.sql.exec(
            `UPDATE voxel_lucky_box
             SET next_spawn_at=?,cycle=?,claimed_uid=NULL,claim_expires_at=0
             WHERE id=1`,
            nextSpawnAt,nextCycle
          );
          return {ok:true,reward,score,nextSpawnAt,nextCycle};
        });
      } catch (_) {
        return Response.json({ok:false,error:'Lucky Box storage unavailable'},{status:500});
      }

      if (!result?.ok) return Response.json(result,{status:409});

      const box=this.boxSnapshot(now);
      const leaderboard=this.top();
      await this.sendAllZones({type:'box_state',box,serverNow:now});
      await this.sendAllZones({type:'leaderboard',top:leaderboard});

      return Response.json({
        ok:true,reward:result.reward,score:result.score,box,leaderboard,serverNow:now
      });
    }

    if (
      url.pathname === '/_internal/zone-bootstrap' &&
      request.method === 'POST'
    ) {
      let body;
      try { body = await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }

      const uid = String(body?.uid || '');
      if (!uid || uid.length > 128) {
        return Response.json({ok:false,error:'Invalid UID'},{status:400});
      }

      const now = Date.now();
      const nickname = 'Player-' + uid.slice(-6);

      this.sql.exec(
        'INSERT INTO voxel_scores(uid,nickname,score,updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(uid) DO NOTHING',
        uid, nickname, now
      );

      const score = Number(
        this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score || 0
      );

      const ent = this.sql.exec(
        `SELECT speed_expires, coin_expires, vip1_expires
         FROM voxel_entitlements WHERE uid=?`,
        uid
      ).toArray()[0] || {speed_expires:0,coin_expires:0,vip1_expires:0};

      return Response.json({
        ok:true,
        serverNow:now,
        score,
        leaderboard:this.top(),
        coins:this.coinSnapshot(),
        luckyBox:this.boxSnapshot(now),
        entitlements:{
          speedExpires:Number(ent.speed_expires)||0,
          coinExpires:Number(ent.coin_expires)||0,
          vip1Expires:Number(ent.vip1_expires)||0
        }
      });
    }

    if (
      url.pathname === '/_internal/grant-payment' &&
      request.method === 'POST'
    ) {
      let body;

      try {
        body = await request.json();
      } catch {
        return Response.json(
          { ok:false, error:'Invalid JSON' },
          { status:400 }
        );
      }

      try {
        const result = this.grantPayment(
          body.uid,
          body.item,
          body.amount,
          body.transactionId
        );

        return Response.json(
          result,
          { status:result.ok ? 200 : 400 }
        );
      } catch (err) {
        return Response.json(
          { ok:false, error:'Payment storage failed' },
          { status:500 }
        );
      }
    }
    if (this.sockets().length>=ROOM_SOFT_CAP) return new Response('Scale test room full',{status:503});
    const pair=new WebSocketPair();
    const [client,server]=Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({authAttempts:0,acceptedAt:Date.now()});
    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws,message) {
    await this.ready;
    if (typeof message!=='string' || message.length>8192) { ws.close(1009,'Invalid message'); return; }
    let m; try { m=JSON.parse(message); } catch (_) { return; }
    const p=this.player(ws);
    if (!p) return;
    if (m?.type==='auth') return this.handleAuth(ws,p,m);
    if (!p.uid || Math.floor(Date.now()/1000)>=p.exp) { ws.close(1008,'Sign in required'); return; }
    if (message.length>256) return;
    if (m?.type==='move') return this.handleMove(ws,p,m);
    if (m?.type==='collect') return this.handleCollect(ws,p,m);
      if (m?.type==='collect_box') return this.handleCollectBox(ws,p,m);
      if (m?.type==='spin_box') return this.handleSpinBox(ws,p,m);
  }

  async handleAuth(ws,p,m) {
    if (!p.uid) {
      if (++p.authAttempts>3) { ws.close(1008,'Too many attempts'); return; }
      ws.serializeAttachment(p);
    }
    let verified;
    try { verified=await verifyFirebaseIdToken(m.token,this.projectId); }
    catch (_) { this.send(ws,{type:'auth_error',message:'Firebase sign-in failed'}); ws.close(1008,'Invalid ID token'); return; }
    p=this.player(ws); // Another auth frame may have completed during certificate fetch.
    if (p.uid && p.uid!==verified.uid) { ws.close(1008,'Different account'); return; }
    if (p.uid) { p.exp=verified.exp; ws.serializeAttachment(p); this.send(ws,{type:'auth_refreshed'}); return; }
    const uid=verified.uid, now=Date.now(), id=crypto.randomUUID();
    const nickname='Player-'+uid.slice(-6);
    this.sql.exec('INSERT INTO voxel_scores(uid,nickname,score,updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(uid) DO NOTHING',uid,nickname,now);
    const score=this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',uid).toArray()[0]?.score||0;
    const n=this.count();
    Object.assign(p,{uid,exp:verified.exp,id,x:(n%5)*2-4,y:0,z:Math.floor(n/5)*2,r:0,at:now,last:0,lastCollect:0});
    ws.serializeAttachment(p);
    this.send(ws,{type:'welcome',protocol:4,id,spawn:{x:p.x,y:p.y,z:p.z},
      players:this.nearbySockets(p,ws).map(other=>this.publicPlayer(this.player(other))).filter(Boolean),
      coins:this.coinSnapshot(),luckyBox:this.boxSnapshot(now),score,leaderboard:this.top(),serverNow:now,count:this.count()});
    this.broadcastNearby({type:'join',player:this.publicPlayer(p),count:this.count()},p,ws);
    this.broadcast({type:'leaderboard',top:this.top()});
  }

  boxSnapshot(now = Date.now()) {
    let row = this.sql.exec(
      'SELECT next_spawn_at, cycle, claimed_uid, claim_expires_at FROM voxel_lucky_box WHERE id=1'
    ).toArray()[0] || { next_spawn_at:0, cycle:0, claimed_uid:null, claim_expires_at:0 };

    if (row.claimed_uid && Number(row.claim_expires_at || 0) <= now && Number(row.next_spawn_at || 0) <= now) {
      this.sql.exec('UPDATE voxel_lucky_box SET claimed_uid=NULL, claim_expires_at=0 WHERE id=1');
      row = { ...row, claimed_uid:null, claim_expires_at:0 };
    }

    const cycle = Number(row.cycle || 0);
    const pos = luckyBoxPosition(cycle);
    const nextSpawnAt = Number(row.next_spawn_at || 0);
    const claimExpiresAt = Number(row.claim_expires_at || 0);
    const claimed = Boolean(row.claimed_uid && claimExpiresAt > now);

    return {
      active: nextSpawnAt <= now && !claimed,
      x: pos.x,
      z: pos.z,
      nextSpawnAt,
      cycle,
      claimed,
      claimExpiresAt,
      serverNow: now
    };
  }

  handleCollectBox(ws,p) {
    const now = Date.now();
    const snap = this.boxSnapshot(now);
    if (!snap.active) {
      this.send(ws,{type:'box_state',box:snap,serverNow:now});
      return;
    }
    if (Math.hypot(p.x-snap.x,p.z-snap.z) > 2.8 || p.y > 3.2) return;

    let claimed = false;
    try {
      claimed = this.ctx.storage.transactionSync(() => {
        const row = this.sql.exec(
          'SELECT next_spawn_at, claimed_uid, claim_expires_at FROM voxel_lucky_box WHERE id=1'
        ).toArray()[0];
        if (!row) return false;
        if (Number(row.next_spawn_at || 0) > now) return false;
        if (row.claimed_uid && Number(row.claim_expires_at || 0) > now && row.claimed_uid !== p.uid) return false;
        this.sql.exec(
          'UPDATE voxel_lucky_box SET claimed_uid=?, claim_expires_at=? WHERE id=1',
          p.uid, now + LUCKY_BOX_CLAIM_MS
        );
        return true;
      });
    } catch (_) { return; }

    const state = this.boxSnapshot(now);
    this.broadcast({type:'box_state',box:state,serverNow:now});
    if (claimed) this.send(ws,{type:'box_spin_ready',box:state,serverNow:now});
  }

  handleSpinBox(ws,p) {
    const now = Date.now();
    const reward = secureLuckyReward();
    let result;

    try {
      result = this.ctx.storage.transactionSync(() => {
        const row = this.sql.exec(
          'SELECT next_spawn_at, cycle, claimed_uid, claim_expires_at FROM voxel_lucky_box WHERE id=1'
        ).toArray()[0];
        if (!row) return {ok:false,message:'Lucky Box state missing'};
        if (Number(row.next_spawn_at || 0) > now) return {ok:false,message:'Lucky Box is cooling down'};
        if (row.claimed_uid !== p.uid || Number(row.claim_expires_at || 0) <= now) {
          return {ok:false,message:'Lucky Box claim expired'};
        }

        this.sql.exec(
          'UPDATE voxel_scores SET score=score+?, updated_at=? WHERE uid=?',
          reward, now, p.uid
        );
        const score = Number(this.sql.exec(
          'SELECT score FROM voxel_scores WHERE uid=?', p.uid
        ).toArray()[0]?.score || 0);

        const nextSpawnAt = now + LUCKY_BOX_RESPAWN_MS;
        const nextCycle = Number(row.cycle || 0) + 1;
        this.sql.exec(
          'UPDATE voxel_lucky_box SET next_spawn_at=?, cycle=?, claimed_uid=NULL, claim_expires_at=0 WHERE id=1',
          nextSpawnAt, nextCycle
        );
        return {ok:true,reward,score,nextSpawnAt,nextCycle};
      });
    } catch (_) {
      this.send(ws,{type:'box_error',message:'Lucky Box storage unavailable'});
      return;
    }

    if (!result?.ok) {
      this.send(ws,{type:'box_error',message:result?.message || 'Lucky Box spin failed'});
      this.send(ws,{type:'box_state',box:this.boxSnapshot(now),serverNow:now});
      return;
    }

    this.send(ws,{type:'box_reward',reward:result.reward,score:result.score,serverNow:now});
    this.broadcast({type:'box_state',box:this.boxSnapshot(now),serverNow:now});
    this.broadcast({type:'leaderboard',top:this.top()});
  }


  handleMove(ws,p,m) {
    const now=Date.now();
    if (now-p.last<MOVE_TICK_MS) return;
    const {x,y,z,r}=m;
    if (![x,y,z,r].every(Number.isFinite)) return;
    if (Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 || Math.abs(r)>10000) return;
    const dt=Math.min(1.5,Math.max(0,(now-p.at)/1000));
    
    const speedEntitlement = this.sql.exec(
      'SELECT speed_expires FROM voxel_entitlements WHERE uid=?',
      p.uid
    ).toArray()[0];

    const speedActive =
      Number(speedEntitlement?.speed_expires || 0) > now;

    const maxHorizontalSpeed = speedActive ? 50 : 26;

    if (
      Math.hypot(x-p.x,z-p.z) > maxHorizontalSpeed*dt+.65 ||
      Math.abs(y-p.y) > 9*dt+.5
    ) return;
    Object.assign(p,{x,y,z,r,at:now,last:now});
    ws.serializeAttachment(p);
    this.broadcastNearby({type:'move',player:this.publicPlayer(p)},p,ws);
  }

  async handleCollect(ws,p,m) {
    const now=Date.now(), id=m.id;
    if (!Number.isInteger(id) || id<0 || id>=COINS.length || now-p.lastCollect<150) return;
    p.lastCollect=now; ws.serializeAttachment(p);
    const visibleRow = this.sql.exec(
      'SELECT cycle FROM voxel_coins WHERE id=?', id
    ).toArray()[0];
    const visibleCycle = Number(visibleRow?.cycle || 0);
    const {x,z} = coinPosition(id, visibleCycle);
    if (Math.hypot(p.x-x,p.z-z)>2.35 || p.y>2.6) return;
    let result;
    try {
      result=this.ctx.storage.transactionSync(()=>{
        const row=this.sql.exec(
          'SELECT respawn_at, cycle FROM voxel_coins WHERE id=?', id
        ).toArray()[0];
        const activeAfter=Number(row?.respawn_at)||0;
        if (activeAfter>now) return {activeAfter};
        const nextCycle=(Number(row?.cycle)||0)+1;
        const respawnAt=now+RESPAWN_MS;
        this.sql.exec(
          'INSERT INTO voxel_coins(id,respawn_at,cycle) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET respawn_at=excluded.respawn_at, cycle=excluded.cycle',
          id, respawnAt, nextCycle
        );
        const coinEntitlement = this.sql.exec(
          'SELECT coin_expires FROM voxel_entitlements WHERE uid=?',
          p.uid
        ).toArray()[0];

        const coinReward =
          Number(coinEntitlement?.coin_expires || 0) > now ? 2 : 1;

        this.sql.exec(
          'UPDATE voxel_scores SET score=score+?, updated_at=? WHERE uid=?',
          coinReward, now, p.uid
        );
        const score=this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?',p.uid).toArray()[0].score;
        return {respawnAt,score,cycle:nextCycle};
      });
    } catch (_) { this.send(ws,{type:'server_error',message:'Score storage unavailable'}); return; }
    if (result.activeAfter) {
      this.send(ws,{type:'coin_state',id,respawnAt:result.activeAfter,serverNow:now}); return;
    }
    const nextPos=coinPosition(id,Number(result.cycle)||0);
    this.broadcast({type:'coin_collected',id,x:nextPos.x,z:nextPos.z,cycle:result.cycle,respawnAt:result.respawnAt,serverNow:now});
    this.send(ws,{type:'score',score:result.score});
    this.broadcast({type:'leaderboard',top:this.top()});
  }

  async webSocketClose(ws) {
    const p=this.player(ws);
    if (p?.uid) this.broadcast({type:'leave',id:p.id,count:Math.max(0,this.count()-1)},ws);
    try { ws.close(1000,'Bye'); } catch (_) {}
  }
  async webSocketError(ws) {
    const p=this.player(ws);
    if (p?.uid) this.broadcast({type:'leave',id:p.id,count:Math.max(0,this.count()-1)},ws);
    try { ws.close(1011,'Connection error'); } catch (_) {}
  }
}


// Phase 2A movement-zone Durable Object.
// World state, scores, payments, coins and Lucky Box remain authoritative in GameRoom.
export class ZoneRoom {
  constructor(ctx,env) {
    this.ctx=ctx;
    this.env=env;
    this.projectId=env.FIREBASE_PROJECT_ID;
    this.lastBorderFlushAt=0;
  }

  player(ws) { return ws.deserializeAttachment(); }
  sockets() { return this.ctx.getWebSockets(); }
  count() { return this.sockets().filter(ws=>this.player(ws)?.uid).length; }
  send(ws,value) { try { ws.send(JSON.stringify(value)); } catch (_) {} }
  broadcastAll(value,except) {
    const data=JSON.stringify(value);
    for(const ws of this.sockets()) {
      if(ws===except || !this.player(ws)?.uid) continue;
      try { ws.send(data); } catch (_) {}
    }
  }

  nearbySockets(sourcePlayer, except) {
    if (!sourcePlayer?.uid) return [];
    const out=[];
    const maxD2=PLAYER_VISIBILITY_RADIUS*PLAYER_VISIBILITY_RADIUS;
    for (const ws of this.sockets()) {
      if (ws===except) continue;
      const other=this.player(ws);
      if (!other?.uid) continue;
      const dx=(Number(other.x)||0)-(Number(sourcePlayer.x)||0);
      const dz=(Number(other.z)||0)-(Number(sourcePlayer.z)||0);
      if (dx*dx+dz*dz<=maxD2) out.push(ws);
    }
    return out;
  }

  broadcastNearby(value,sourcePlayer,except) {
    const data=JSON.stringify(value);
    for (const ws of this.nearbySockets(sourcePlayer,except)) {
      try { ws.send(data); } catch (_) {}
    }
  }

  publicPlayer(p) {
    return p?.uid && {id:p.id,x:p.x,y:p.y,z:p.z,r:p.r};
  }

  currentZoneId() {
    const objectName=String(this.ctx.id?.name||'');
    return normalizeZoneId(
      objectName.startsWith('free-zone-')
        ? objectName.slice('free-zone-'.length)
        : ''
    );
  }

  borderPlayers(exceptWs=null) {
    return this.sockets()
      .filter(ws=>ws!==exceptWs && this.player(ws)?.uid)
      .map(ws=>this.publicPlayer(this.player(ws)))
      .filter(Boolean);
  }

  async flushBorderSnapshot(force=false, exceptWs=null) {
    const now=Date.now();
    if (!force && now-this.lastBorderFlushAt<BORDER_SNAPSHOT_INTERVAL_MS) return;
    this.lastBorderFlushAt=now;

    const sourceZone=this.currentZoneId();
    if (!sourceZone) return;

    const players=this.borderPlayers(exceptWs);
    const payload=JSON.stringify({
      sourceZone,
      players,
      serverNow:now
    });

    await Promise.allSettled(
      adjacentZoneIds(sourceZone).map(zoneId=>
        this.env.ZONE.getByName(`free-zone-${zoneId}`).fetch(
          new Request('https://zone.internal/_internal/border-snapshot',{
            method:'POST',
            headers:{'content-type':'application/json'},
            body:payload
          })
        )
      )
    );
  }

  async sendInitialGhostSnapshots(ws,p) {
    const currentZone=this.currentZoneId();
    if (!currentZone || !p?.uid) return;

    await Promise.allSettled(
      adjacentZoneIds(currentZone).map(async zoneId=>{
        const response=await this.env.ZONE.getByName(`free-zone-${zoneId}`).fetch(
          new Request('https://zone.internal/_internal/border-state',{method:'GET'})
        );
        if (!response.ok) return;
        const state=await response.json();
        const players=Array.isArray(state?.players) ? state.players : [];
        const maxD2=PLAYER_VISIBILITY_RADIUS*PLAYER_VISIBILITY_RADIUS;
        const visible=players.filter(other=>{
          if (!other || typeof other.id!=='string' || other.id===p.id) return false;
          const x=Number(other.x), z=Number(other.z);
          if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
          const dx=x-Number(p.x||0), dz=z-Number(p.z||0);
          return dx*dx+dz*dz<=maxD2;
        });
        this.send(ws,{
          type:'ghost_snapshot',
          zone:zoneId,
          players:visible,
          serverNow:Number(state?.serverNow)||Date.now()
        });
      })
    );
  }

  async fetch(request) {
    const url=new URL(request.url);

    if (url.pathname==='/_internal/border-state' && request.method==='GET') {
      return Response.json({
        ok:true,
        zone:this.currentZoneId(),
        players:this.borderPlayers(),
        serverNow:Date.now()
      });
    }

    if (url.pathname==='/_internal/border-snapshot' && request.method==='POST') {
      let body;
      try { body=await request.json(); }
      catch (_) { return new Response('Bad JSON',{status:400}); }

      const currentZone=this.currentZoneId();
      const sourceZone=normalizeZoneId(body?.sourceZone);
      if (!currentZone || !sourceZone || !zonesAreAdjacent(currentZone,sourceZone)) {
        return new Response('Invalid source zone',{status:403});
      }

      const rawPlayers=Array.isArray(body?.players) ? body.players : [];
      if (rawPlayers.length>ZONE_SOFT_CAP+20) {
        return new Response('Snapshot too large',{status:413});
      }

      const players=[];
      for (const item of rawPlayers) {
        const id=String(item?.id||'');
        const x=Number(item?.x), y=Number(item?.y), z=Number(item?.z), r=Number(item?.r);
        if (!id || id.length>128 || ![x,y,z,r].every(Number.isFinite)) continue;
        if (Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 || Math.abs(r)>10000) continue;
        players.push({id,x,y,z,r});
      }

      const maxD2=PLAYER_VISIBILITY_RADIUS*PLAYER_VISIBILITY_RADIUS;
      const serverNow=Number(body?.serverNow)||Date.now();

      for (const ws of this.sockets()) {
        const p=this.player(ws);
        if (!p?.uid) continue;

        const visible=players.filter(other=>{
          if (other.id===p.id) return false;
          const dx=other.x-Number(p.x||0);
          const dz=other.z-Number(p.z||0);
          return dx*dx+dz*dz<=maxD2;
        });

        this.send(ws,{
          type:'ghost_snapshot',
          zone:sourceZone,
          players:visible,
          serverNow
        });
      }

      return new Response('OK');
    }

    if (url.pathname==='/_internal/world-event' && request.method==='POST') {
      let event;
      try { event=await request.json(); }
      catch (_) { return new Response('Bad JSON',{status:400}); }
      this.broadcastAll(event);
      return new Response('OK');
    }

    if (request.headers.get('Upgrade')?.toLowerCase()!=='websocket')
      return new Response('WebSocket required',{status:426});

    const zoneId=this.currentZoneId();
    if (!zoneId) return new Response('Invalid zone',{status:400});

    if (this.sockets().length>=ZONE_SOFT_CAP)
      return new Response('Zone full',{status:503});

    const pair=new WebSocketPair();
    const [client,server]=Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      authAttempts:0,
      acceptedAt:Date.now(),
      zoneId
    });
    return new Response(null,{status:101,webSocket:client});
  }

  async webSocketMessage(ws,message) {
    if (typeof message!=='string' || message.length>8192) {
      ws.close(1009,'Invalid message');
      return;
    }

    let m;
    try { m=JSON.parse(message); } catch (_) { return; }

    const p=this.player(ws);
    if (!p) return;

    if (m?.type==='auth') return this.handleAuth(ws,p,m);

    if (!p.uid || Math.floor(Date.now()/1000)>=p.exp) {
      ws.close(1008,'Sign in required');
      return;
    }

    if (message.length>256) return;

    if (m?.type==='handoff_resume') return this.handleHandoffResume(ws,p,m);
    if (m?.type==='move') return this.handleMove(ws,p,m);
    if (m?.type==='collect') return this.handleCollect(ws,p,m);
    if (m?.type==='collect_box') return this.handleCollectBox(ws,p,m);
    if (m?.type==='spin_box') return this.handleSpinBox(ws,p,m);
  }

  async handleAuth(ws,p,m) {
    if (!p.uid) {
      if (++p.authAttempts>3) {
        ws.close(1008,'Too many attempts');
        return;
      }
      ws.serializeAttachment(p);
    }

    let verified;
    try { verified=await verifyFirebaseIdToken(m.token,this.projectId); }
    catch (_) {
      this.send(ws,{type:'auth_error',message:'Firebase sign-in failed'});
      ws.close(1008,'Invalid ID token');
      return;
    }

    p=this.player(ws);

    if (p.uid && p.uid!==verified.uid) {
      ws.close(1008,'Different account');
      return;
    }

    if (p.uid) {
      p.exp=verified.exp;
      ws.serializeAttachment(p);
      this.send(ws,{type:'auth_refreshed'});
      return;
    }

    let bootstrap;
    try {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-bootstrap',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:verified.uid})
        })
      );
      bootstrap=await response.json();
      if (!response.ok || !bootstrap?.ok) throw Error('bootstrap failed');
    } catch (_) {
      this.send(ws,{type:'server_error',message:'World bootstrap unavailable'});
      ws.close(1011,'World bootstrap unavailable');
      return;
    }

    p=this.player(ws);
    const zoneId=normalizeZoneId(p.zoneId);
    const center=zoneCenter(zoneId);

    if (!center) {
      ws.close(1008,'Invalid zone');
      return;
    }

    let handoff=null;
    const handoffToken=String(m?.handoffToken||'');
    if (handoffToken) {
      try {
        const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
          new Request('https://internal/_internal/consume-zone-handoff',{
            method:'POST',
            headers:{'content-type':'application/json'},
            body:JSON.stringify({
              uid:verified.uid,
              token:handoffToken,
              toZone:zoneId
            })
          })
        );
        handoff=await response.json();
        if (!response.ok || !handoff?.ok) throw Error('handoff rejected');
      } catch (_) {
        this.send(ws,{type:'handoff_error',message:'Zone handoff expired or invalid'});
        ws.close(1008,'Invalid handoff');
        return;
      }
    }

    const now=Date.now();
    const n=this.count();
    const col=n%10;
    const row=Math.floor(n/10)%10;
    const spawnX=handoff ? Number(handoff.x) : center.x+(col-4.5)*4;
    const spawnY=handoff ? Number(handoff.y) : 0;
    const spawnZ=handoff ? Number(handoff.z) : center.z+(row-4.5)*4;
    const spawnR=handoff ? Number(handoff.r) : 0;
    const id=handoff ? String(handoff.playerId) : crypto.randomUUID();

    Object.assign(p,{
      uid:verified.uid,
      exp:verified.exp,
      id,
      zoneId,
      x:spawnX,
      y:spawnY,
      z:spawnZ,
      r:spawnR,
      at:now,
      last:0,
      lastCollect:0,
      handoffPending:null,
      handoffResume: handoff ? {
        anchorX:spawnX,
        anchorY:spawnY,
        anchorZ:spawnZ,
        createdAt:Number(handoff.createdAt)||now,
        deadline:now+4000
      } : null,
      speedExpires:Number(bootstrap.entitlements?.speedExpires)||0
    });

    ws.serializeAttachment(p);

    this.send(ws,{
      type:'welcome',
      protocol:6,
      phase:'2B1',
      handoff:Boolean(handoff),
      fromZone:handoff?.fromZone||null,
      zone:zoneId,
      id,
      spawn:{x:p.x,y:p.y,z:p.z,r:p.r},
      players:this.nearbySockets(p,ws)
        .map(other=>this.publicPlayer(this.player(other)))
        .filter(Boolean),
      coins:Array.isArray(bootstrap.coins)?bootstrap.coins:[],
      luckyBox:bootstrap.luckyBox||null,
      score:Number(bootstrap.score)||0,
      leaderboard:Array.isArray(bootstrap.leaderboard)?bootstrap.leaderboard:[],
      serverNow:Number(bootstrap.serverNow)||now,
      count:this.count()
    });

    this.broadcastNearby({
      type:'join',
      player:this.publicPlayer(p),
      count:this.count()
    },p,ws);

    this.ctx.waitUntil(this.sendInitialGhostSnapshots(ws,p));
    this.ctx.waitUntil(this.flushBorderSnapshot(true));
  }

  async handleHandoffResume(ws,p,m) {
    const now=Date.now();
    const resume=p?.handoffResume;
    if (!resume || now>Number(resume.deadline||0)) {
      if (p?.uid) {
        p.handoffResume=null;
        ws.serializeAttachment(p);
      }
      this.send(ws,{type:'handoff_resume_error',message:'Handoff resume window expired'});
      return;
    }

    const x=Number(m?.x), y=Number(m?.y), z=Number(m?.z), r=Number(m?.r);
    if (![x,y,z,r].every(Number.isFinite) ||
        Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 || Math.abs(r)>10000 ||
        zoneFromPosition(x,z)!==p.zoneId) {
      this.send(ws,{type:'handoff_resume_error',message:'Invalid handoff resume position'});
      return;
    }

    const elapsed=Math.min(4,Math.max(0,(now-Number(resume.createdAt||now))/1000));
    const speedActive=Number(p.speedExpires||0)>now;
    const maxHorizontalSpeed=speedActive ? 50 : 26;
    const maxHorizontalDistance=maxHorizontalSpeed*elapsed+1.75;
    const maxVerticalDistance=9*elapsed+1.0;

    if (
      Math.hypot(x-Number(resume.anchorX||0),z-Number(resume.anchorZ||0))>maxHorizontalDistance ||
      Math.abs(y-Number(resume.anchorY||0))>maxVerticalDistance
    ) {
      this.send(ws,{
        type:'handoff_resume_error',
        message:'Handoff resume movement exceeded server limit',
        retryable:true,
        serverNow:now
      });
      return;
    }

    Object.assign(p,{
      x,y,z,r,
      at:now,
      last:now,
      handoffPending:null,
      handoffResume:null
    });
    ws.serializeAttachment(p);

    this.broadcastNearby({
      type:'move',
      player:this.publicPlayer(p)
    },p,ws);
    this.ctx.waitUntil(this.flushBorderSnapshot(true));

    this.send(ws,{
      type:'handoff_resumed',
      x,y,z,r,
      zone:p.zoneId,
      serverNow:now
    });
  }

  async handleMove(ws,p,m) {
    const now=Date.now();
    if (now-p.last<MOVE_TICK_MS) return;

    const {x,y,z,r}=m;
    if (![x,y,z,r].every(Number.isFinite)) return;
    if (Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 || Math.abs(r)>10000) return;

    const dt=Math.min(1.5,Math.max(0,(now-p.at)/1000));
    const speedActive=Number(p.speedExpires||0)>now;
    const maxHorizontalSpeed=speedActive ? 50 : 26;

    if (
      Math.hypot(x-p.x,z-p.z)>maxHorizontalSpeed*dt+.65 ||
      Math.abs(y-p.y)>9*dt+.5
    ) return;

    const requestedZone=zoneFromPosition(x,z);
    if (!requestedZone) return;

    if (requestedZone!==p.zoneId) {
      if (!zonesAreAdjacent(p.zoneId,requestedZone)) return;

      const pending=p.handoffPending;
      if (pending?.zone===requestedZone && pending?.token && Number(pending.expiresAt||0)>now) {
        this.send(ws,{
          type:'zone_change',
          from:p.zoneId,
          zone:requestedZone,
          handoffToken:pending.token,
          expiresAt:pending.expiresAt,
          position:pending.position
        });
        return;
      }
      if (pending?.creating && pending?.zone===requestedZone) return;

      p.handoffPending={
        creating:true,
        zone:requestedZone,
        position:{x,y,z,r},
        expiresAt:now+2000
      };
      p.last=now;
      ws.serializeAttachment(p);

      try {
        const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
          new Request('https://internal/_internal/create-zone-handoff',{
            method:'POST',
            headers:{'content-type':'application/json'},
            body:JSON.stringify({
              uid:p.uid,
              playerId:p.id,
              fromZone:p.zoneId,
              toZone:requestedZone,
              x,y,z,r
            })
          })
        );
        const result=await response.json();
        if (!response.ok || !result?.ok) throw Error('handoff create failed');

        p=this.player(ws);
        if (!p?.uid) return;
        p.handoffPending={
          creating:false,
          zone:requestedZone,
          token:String(result.token),
          expiresAt:Number(result.expiresAt)||0,
          position:{x,y,z,r}
        };
        ws.serializeAttachment(p);

        this.send(ws,{
          type:'zone_change',
          from:p.zoneId,
          zone:requestedZone,
          handoffToken:p.handoffPending.token,
          expiresAt:p.handoffPending.expiresAt,
          position:p.handoffPending.position
        });
      } catch (_) {
        p=this.player(ws);
        if (p?.uid) {
          p.handoffPending=null;
          ws.serializeAttachment(p);
        }
        this.send(ws,{type:'handoff_error',message:'Could not prepare zone handoff'});
      }
      return;
    }

    Object.assign(p,{x,y,z,r,at:now,last:now,handoffPending:null,handoffResume:null});
    ws.serializeAttachment(p);

    this.broadcastNearby({
      type:'move',
      player:this.publicPlayer(p)
    },p,ws);

    this.ctx.waitUntil(this.flushBorderSnapshot(false));
  }

  async handleCollect(ws,p,m) {
    const now=Date.now();
    const id=Number(m?.id);
    if (!Number.isInteger(id) || id<0 || id>=COINS.length || now-Number(p.lastCollect||0)<150) return;
    p.lastCollect=now;
    ws.serializeAttachment(p);

    try {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-collect',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid,id,x:p.x,y:p.y,z:p.z})
        })
      );
      const result=await response.json();

      if (!response.ok || !result?.ok) {
        if (response.status>=500) this.send(ws,{type:'server_error',message:'Score storage unavailable'});
        return;
      }

      if (!result.collected) {
        this.send(ws,{
          type:'coin_state',
          id,
          respawnAt:Number(result.activeAfter)||0,
          serverNow:Number(result.serverNow)||now
        });
        return;
      }

      this.send(ws,{type:'score',score:Number(result.score)||0});
      if (Array.isArray(result.leaderboard)) {
        this.broadcastAll({type:'leaderboard',top:result.leaderboard});
      }
    } catch (_) {
      this.send(ws,{type:'server_error',message:'World action unavailable'});
    }
  }

  async handleCollectBox(ws,p) {
    try {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-collect-box',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid,x:p.x,y:p.y,z:p.z})
        })
      );
      const result=await response.json();
      if (!response.ok || !result?.ok) return;

      if (result.claimed) {
        this.send(ws,{
          type:'box_spin_ready',
          box:result.box,
          serverNow:Number(result.serverNow)||Date.now()
        });
      } else if (result.box) {
        this.send(ws,{
          type:'box_state',
          box:result.box,
          serverNow:Number(result.serverNow)||Date.now()
        });
      }
    } catch (_) {
      this.send(ws,{type:'server_error',message:'Lucky Box unavailable'});
    }
  }

  async handleSpinBox(ws,p) {
    try {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-spin-box',{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid})
        })
      );
      const result=await response.json();

      if (!response.ok || !result?.ok) {
        this.send(ws,{type:'box_error',message:result?.error||'Lucky Box spin failed'});
        return;
      }

      this.send(ws,{
        type:'box_reward',
        reward:Number(result.reward)||0,
        score:Number(result.score)||0,
        serverNow:Number(result.serverNow)||Date.now()
      });
      if (Array.isArray(result.leaderboard)) {
        this.broadcastAll({type:'leaderboard',top:result.leaderboard});
      }
    } catch (_) {
      this.send(ws,{type:'box_error',message:'Lucky Box storage unavailable'});
    }
  }

  async webSocketClose(ws) {
    const p=this.player(ws);
    if (p?.uid) {
      this.broadcastNearby({
        type:'leave',
        id:p.id,
        count:Math.max(0,this.count()-1)
      },p,ws);
      this.ctx.waitUntil(this.flushBorderSnapshot(true,ws));
    }
    try { ws.close(1000,'Bye'); } catch (_) {}
  }

  async webSocketError(ws) {
    const p=this.player(ws);
    if (p?.uid) {
      this.broadcastNearby({
        type:'leave',
        id:p.id,
        count:Math.max(0,this.count()-1)
      },p,ws);
      this.ctx.waitUntil(this.flushBorderSnapshot(true,ws));
    }
    try { ws.close(1011,'Connection error'); } catch (_) {}
  }
}
