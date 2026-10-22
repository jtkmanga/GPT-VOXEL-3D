const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let cachedCerts = null, certsExpireAt = 0, certsFetchPromise = null, certsFetchedAt = 0;

function decodeBase64(value) {
  const normalized = value.replace(/-/g,'+').replace(/_/g,'/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,'='));
  return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
function readTlv(data,start,limit=data.length) {
  if (start>=limit) throw Error('Invalid certificate');
  const tag=data[start], lengthByte=data[start+1];
  if (lengthByte===undefined) throw Error('Invalid certificate');
  let length=lengthByte, header=2;
  if (lengthByte&0x80) {
    const count=lengthByte&0x7f;
    if (!count || count>3 || start+2+count>limit) throw Error('Invalid certificate');
    length=0;
    for(let i=0;i<count;i++) length=length*256+data[start+2+i];
    header+=count;
  }
  const end=start+header+length;
  if (end>limit) throw Error('Invalid certificate');
  return {tag,start,value:start+header,end};
}
function extractSpki(pem) {
  const raw=pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!raw) throw Error('Invalid certificate');
  const data=decodeBase64(raw[1].replace(/\s/g,''));
  const cert=readTlv(data,0), tbs=readTlv(data,cert.value,cert.end);
  if (cert.tag!==0x30 || tbs.tag!==0x30 || cert.end!==data.length) throw Error('Invalid certificate');
  let offset=tbs.value;
  if (data[offset]===0xa0) offset=readTlv(data,offset,tbs.end).end; // optional version
  for(let i=0;i<5;i++) offset=readTlv(data,offset,tbs.end).end; // serial, sig, issuer, validity, subject
  const spki=readTlv(data,offset,tbs.end);
  if (spki.tag!==0x30 || spki.end>tbs.end) throw Error('Invalid certificate');
  return data.slice(spki.start,spki.end);
}
async function getCert(kid) {
  const now=Date.now();
  const missingKey = cachedCerts && !Object.hasOwn(cachedCerts,kid);
  if (!cachedCerts || now>=certsExpireAt || (missingKey && now-certsFetchedAt>=60_000)) {
    // Login bursts share a trusted request. A newly rotated key can refresh a
    // fresh cache, while arbitrary unknown kids are bounded to one fetch/minute.
    if (!certsFetchPromise) {
      certsFetchPromise=(async () => {
        const response=await fetch(CERTS_URL);
        if (!response.ok) throw Error('Firebase certificates unavailable');
        const certs=await response.json();
        if (!certs || typeof certs!=='object' || Array.isArray(certs)) throw Error('Firebase certificates unavailable');
        const entries=Object.entries(certs);
        if (!entries.length || entries.some(([key,value]) => !key || key.length>200 ||
            typeof value!=='string' || value.length>20_000 || !value.includes('-----BEGIN CERTIFICATE-----'))) {
          throw Error('Firebase certificates unavailable');
        }
        const match=response.headers.get('cache-control')?.match(/max-age=(\d+)/i);
        const maxAge=match ? Number(match[1]) : 300;
        cachedCerts=certs;
        certsFetchedAt=Date.now();
        certsExpireAt=Date.now()+Math.min(Number.isFinite(maxAge) ? Math.max(0,maxAge) : 300,3600)*1000;
      })();
    }
    const pending=certsFetchPromise;
    try { await pending; }
    finally { if (certsFetchPromise===pending) certsFetchPromise=null; }
  }
  if (!Object.hasOwn(cachedCerts,kid) || typeof cachedCerts[kid]!=='string') throw Error('Unknown Firebase signing key');
  return cachedCerts[kid];
}
export async function verifyFirebaseIdToken(token,projectId) {
  if (typeof token!=='string' || token.length>8192 || token.length<100 ||
      typeof projectId!=='string' || !projectId) throw Error('Invalid token');
  const parts=token.split('.');
  if (parts.length!==3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw Error('Invalid token');
  const header=JSON.parse(new TextDecoder().decode(decodeBase64(parts[0])));
  const claims=JSON.parse(new TextDecoder().decode(decodeBase64(parts[1])));
  const now=Math.floor(Date.now()/1000);
  if (!header || typeof header!=='object' || Array.isArray(header) ||
      !claims || typeof claims!=='object' || Array.isArray(claims) ||
      header.alg!=='RS256' || typeof header.kid!=='string' || !header.kid || header.kid.length>200 ||
      (header.typ!==undefined && header.typ!=='JWT') ||
      claims.aud!==projectId || claims.iss!==`https://securetoken.google.com/${projectId}` ||
      typeof claims.sub!=='string' || !claims.sub || claims.sub.length>128 ||
      !Number.isInteger(claims.exp) || claims.exp<=now ||
      !Number.isInteger(claims.iat) || claims.iat<0 || claims.iat>now || claims.exp<=claims.iat ||
      !Number.isInteger(claims.auth_time) || claims.auth_time<0 || claims.auth_time>claims.iat ||
      (claims.nbf!==undefined && (!Number.isInteger(claims.nbf) || claims.nbf>now)) ||
      (claims.user_id!==undefined && claims.user_id!==claims.sub)) throw Error('Invalid token claims');
  const publicKey=await crypto.subtle.importKey('spki',extractSpki(await getCert(header.kid)),
    {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',publicKey,
    decodeBase64(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
  if (!valid) throw Error('Invalid token signature');
  return {uid:claims.sub,exp:claims.exp,authTime:claims.auth_time};
}

function firebaseWebApiKey(env) {
  if (!env || typeof env.FIREBASE_PUBLIC_CONFIG !== 'string') throw Error('Firebase online user check unavailable');
  let config;
  try { config = JSON.parse(env.FIREBASE_PUBLIC_CONFIG); }
  catch (_) { throw Error('Firebase online user check unavailable'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      config.projectId !== env.FIREBASE_PROJECT_ID ||
      typeof config.apiKey !== 'string' || !/^AIza[A-Za-z0-9_-]{35}$/.test(config.apiKey))
    throw Error('Firebase online user check unavailable');
  return config.apiKey;
}

export async function verifyFirebaseActiveIdToken(token, env) {
  const identity = await verifyFirebaseIdToken(token, env?.FIREBASE_PROJECT_ID);
  if (env?.FIREBASE_ONLINE_USER_CHECK !== 'true') return identity;
  if (env.APP_ENV !== 'staging' || env.STAGING_WORKER_NAME !== 'gpt-voxel-3d-staging-01')
    throw Error('Firebase online user check unavailable');
  const apiKey = firebaseWebApiKey(env);
  const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' +
    encodeURIComponent(apiKey), {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(5_000)
    });
  if (!response.ok) throw Error('Firebase user is no longer active');
  const data = await response.json();
  const users = Array.isArray(data?.users) ? data.users : [];
  if (users.length !== 1 || users[0]?.localId !== identity.uid || users[0]?.disabled === true)
    throw Error('Firebase user is no longer active');
  const validSince = Number(users[0]?.validSince ?? 0);
  if (!Number.isFinite(validSince) || validSince < 0 ||
      (validSince > 0 && identity.authTime < validSince))
    throw Error('Firebase token is revoked');
  return identity;
}
