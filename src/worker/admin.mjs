import { verifyFirebaseIdToken } from './firebase-auth.mjs';

const RANK = Object.freeze({ moderator:1, admin:2, owner:3 });
const json = (body,status=200) => Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const roomFor = (env,server) => server==='vip1' ? env.ROOM.getByName('vip1-v2-demo') :
  server==='free1' ? env.ROOM.getByName('free-v2-demo') : null;
const freeRoom = env => env.ROOM.getByName('free-v2-demo');

async function internalJson(stub,path,{method='GET',body}={}) {
  const response=await stub.fetch(new Request('https://internal'+path,{
    method,headers:body===undefined?undefined:{'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)
  }));
  let data; try { data=await response.json(); } catch (_) { data={ok:false,error:'Admin authority unavailable'}; }
  return {response,data};
}

async function adminIdentity(request,env) {
  const match=/^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization')||'');
  if(!match) return {ok:false,status:401,error:'Admin authentication required'};
  let identity;
  try { identity=await verifyFirebaseIdToken(match[1],env?.FIREBASE_PROJECT_ID); }
  catch(_) { return {ok:false,status:401,error:'Invalid admin authentication'}; }
  const email=String(identity.email||'').trim().toLowerCase();
  if(!email||identity.emailVerified!==true) return {ok:false,status:403,error:'Verified email required'};
  const owner=String(env?.ADMIN_OWNER_EMAIL||'').trim().toLowerCase();
  if(owner&&email===owner) return {ok:true,identity:{...identity,email},role:'owner'};
  const {data}=await internalJson(freeRoom(env),'/_internal/admin/role-check?email='+encodeURIComponent(email));
  let role=data?.role;
  if(!role && String(env?.ADMIN_EMAILS||'').split(',').map(v=>v.trim().toLowerCase()).includes(email)) role='admin';
  if(!RANK[role]) return {ok:false,status:403,error:'Admin access denied'};
  return {ok:true,identity:{...identity,email},role};
}
function requireRole(admin,minimum){
  return admin.ok && (RANK[admin.role]||0)>=(RANK[minimum]||99);
}

function adminHtml(){
return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VOXEL RUN Admin</title><style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;margin:0;background:#07101f;color:#eef2ff}main{max-width:1400px;margin:auto;padding:16px}
h1,h2{margin:.3em 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card{background:#101827;border:1px solid #273449;border-radius:14px;padding:14px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}button,input,select,textarea{font:inherit;padding:9px;border-radius:8px;border:1px solid #3a4a63;background:#0b1322;color:#eef2ff}button{cursor:pointer}button.danger{border-color:#7f1d1d;background:#3f1118}button.good{border-color:#166534;background:#102d1b}
table{width:100%;border-collapse:collapse;margin-top:10px;background:#0d1524;font-size:13px}th,td{padding:8px;border-bottom:1px solid #253248;text-align:left;vertical-align:top}.scroll{overflow:auto;max-height:520px}.muted{color:#94a3b8}.ok{color:#86efac}.err{color:#fca5a5}.pill{padding:3px 7px;border:1px solid #3a4a63;border-radius:999px;font-size:11px}textarea{width:100%;min-height:70px}
</style></head><body><main>
<div class="row"><h1 style="flex:1">VOXEL RUN Admin</h1><span id="role" class="pill">signed out</span><button id="login">Google Login</button><button id="logout">Logout</button></div>
<p id="status" class="muted">ยังไม่ได้เข้าสู่ระบบ</p>
<pre id="authDiag" class="muted" style="white-space:pre-wrap;font-size:11px;margin:6px 0 10px;max-height:120px;overflow:auto"></pre>
<div class="row"><select id="server"><option value="free1">Free Server</option><option value="vip1">VIP Server</option></select><button id="refresh">รีเฟรชทั้งหมด</button><button id="export">Export CSV</button><button id="backup">Backup JSON</button></div>

<h2>Dashboard</h2><div class="grid">
<div class="card"><b>Online</b><div id="online">-</div></div><div class="card"><b>Players</b><div id="playersCount">-</div></div>
<div class="card"><b>Banned</b><div id="bannedCount">-</div></div><div class="card"><b>Muted</b><div id="mutedCount">-</div></div>
</div>

<h2>Live Site / Server Controls</h2><div class="grid">
<div class="card"><b>ประกาศ</b><textarea id="announcement" maxlength="300"></textarea><button data-control="announcement">บันทึกประกาศ</button></div>
<div class="card"><b>ชื่อเซิร์ฟเวอร์</b><input id="free_name" maxlength="80"><input id="vip_name" maxlength="80"><div class="row"><button data-control="free_name">Free name</button><button data-control="vip_name">VIP name</button></div></div>
<div class="card"><b>Maintenance</b><div class="row"><button data-toggle="maintenance_free">Free</button><button data-toggle="maintenance_vip">VIP</button></div></div>
<div class="card"><b>Emergency</b><div class="row"><button class="danger" data-toggle="payment_emergency">Pause payment</button><button class="danger" data-toggle="vip_admission_emergency">Pause VIP admission</button></div></div>
</div>

<h2>Players</h2><div class="scroll"><table><thead><tr><th>Email / UID</th><th>Name</th><th>Score</th><th>Online/VIP</th><th>Moderation</th></tr></thead><tbody id="players"></tbody></table></div>

<h2>Roles</h2><div class="card row"><input id="roleEmail" placeholder="email"><select id="roleValue"><option value="moderator">Moderator</option><option value="admin">Admin</option><option value="none">Remove</option></select><button id="setRole">บันทึก Role</button></div>

<h2>Payments (safe fields)</h2><div class="scroll"><table><thead><tr><th>UID</th><th>Item</th><th>Amount</th><th>Time</th><th>Ref</th></tr></thead><tbody id="payments"></tbody></table></div>
<h2>Audit Log</h2><div class="scroll"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody id="audit"></tbody></table></div>

<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script><script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js"></script><script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check-compat.js"></script>
<script>
let auth=null,provider=null,appCheck=null,me=null,lastControls={}; const $=id=>document.getElementById(id);
function diag(msg){const el=$('authDiag');if(!el)return;const t=new Date().toLocaleTimeString('th-TH');el.textContent=(el.textContent+'['+t+'] '+String(msg)+'\\n').slice(-4000);el.scrollTop=el.scrollHeight}
window.addEventListener('error',e=>diag('JS error: '+(e?.message||'unknown')));
window.addEventListener('unhandledrejection',e=>diag('Promise error: '+(e?.reason?.code||'')+' '+(e?.reason?.message||e?.reason||'unknown')));
diag('Browser: '+navigator.userAgent);
diag('Cookies: '+(navigator.cookieEnabled?'enabled':'disabled'));
function authError(e){const code=String(e?.code||'');if(code==='auth/unauthorized-domain')return 'โดเมน staging ยังไม่ได้รับอนุญาตใน Firebase Authentication';if(code==='auth/popup-blocked'||code==='auth/popup-closed-by-user'||code==='auth/cancelled-popup-request')return 'เบราว์เซอร์ปิดหน้าต่างเข้าสู่ระบบ กรุณาลองใหม่';return e?.message||'เข้าสู่ระบบไม่สำเร็จ'}
async function ensureAuth(){if(auth)return auth;diag('Loading Firebase config...');const r=await fetch('/admin/api/public-config',{cache:'no-store'}),j=await r.json();if(!r.ok)throw Error(j.error||'Firebase config unavailable');diag('Firebase config OK · authDomain='+j.firebase.authDomain);firebase.initializeApp(j.firebase);if(!j.appCheck?.siteKey)throw Error('Firebase App Check config unavailable');appCheck=firebase.appCheck();appCheck.activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(j.appCheck.siteKey),true);diag('Firebase App Check initialized');try{const token=await appCheck.getToken(false);if(!token?.token)throw Error('App Check token missing');diag('Firebase App Check token ready')}catch(e){diag('App Check error: '+(e?.code||'')+' '+(e?.message||''));throw Error('Firebase App Check token unavailable')}auth=firebase.auth();provider=new firebase.auth.GoogleAuthProvider();diag('Firebase Auth initialized');try{await auth.getRedirectResult()}catch(e){diag('Redirect result error: '+(e?.code||'')+' '+(e?.message||''));$('status').className='err';$('status').textContent=authError(e)}auth.onAuthStateChanged(async u=>{diag('Auth state: '+(u?'SIGNED IN':'signed out'));if(u){await loadMe();await loadAll();}else{me=null;$('role').textContent='signed out';if(!$('status').classList.contains('err'))$('status').textContent='ยังไม่ได้เข้าสู่ระบบ';}});return auth}
async function headers(){const a=await ensureAuth(),u=a.currentUser;if(!u)throw Error('กรุณาเข้าสู่ระบบ');return {'Authorization':'Bearer '+await u.getIdToken(),'Content-Type':'application/json'}}
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{...(opt.headers||{}),...(await headers())}});const type=r.headers.get('content-type')||'';const j=type.includes('json')?await r.json():await r.text();if(!r.ok)throw Error(j?.error||j||'Request failed');return j}
async function loadMe(){me=await api('/admin/api/me');$('role').textContent=me.email+' · '+me.role}
function fmt(t){return t?new Date(Number(t)).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}):'-'}
async function loadAll(){try{const s=$('server').value;const [o,p,a,pm]=await Promise.all([api('/admin/api/overview?server='+s),api('/admin/api/players?server='+s),api('/admin/api/audit?server='+s),api('/admin/api/payments')]);$('online').textContent=o.online;$('playersCount').textContent=o.players;$('bannedCount').textContent=o.banned;$('mutedCount').textContent=o.muted;lastControls=o.controls||{};for(const k of ['announcement','free_name','vip_name'])$(k).value=lastControls[k]||'';renderPlayers(p.players||[]);renderAudit(a.rows||[]);renderPayments(pm.rows||[]);$('status').className='ok';$('status').textContent='ออนไลน์ · อัปเดต '+fmt(o.serverNow)}catch(e){$('status').className='err';$('status').textContent=e.message}}
function renderPlayers(rows){const b=$('players');b.innerHTML='';for(const p of rows){const tr=document.createElement('tr');const ident=document.createElement('td');ident.textContent=(p.email||'(no email)')+'\\n'+p.uid;ident.style.whiteSpace='pre-line';const name=document.createElement('td');name.textContent=p.nickname;const score=document.createElement('td');const i=document.createElement('input');i.type='number';i.min='0';i.value=p.score;const save=document.createElement('button');save.textContent='Set';save.onclick=()=>setScore(p.uid,i.value);const reward=document.createElement('button');reward.textContent='+100';reward.className='good';reward.onclick=()=>rewardScore(p.uid,100);score.append(i,save,reward);const state=document.createElement('td');state.textContent=(p.online?'🟢 Online':'⚪ Offline')+'\\nVIP: '+fmt(p.vipExpiresAt);state.style.whiteSpace='pre-line';const mod=document.createElement('td');for(const [label,action] of [['Kick','kick'],['Ban 7d','ban'],['Unban','unban'],['Mute 24h','mute'],['Unmute','unmute']]){const bt=document.createElement('button');bt.textContent=label;bt.onclick=()=>moderate(p.uid,action);mod.appendChild(bt)}tr.append(ident,name,score,state,mod);b.appendChild(tr)}}
function renderAudit(rows){const b=$('audit');b.innerHTML='';for(const x of rows){const tr=document.createElement('tr');for(const v of [fmt(x.created_at),x.actor,x.action,x.target_uid||'',x.metadata||'']){const td=document.createElement('td');td.textContent=String(v);tr.appendChild(td)}b.appendChild(tr)}}
function renderPayments(rows){const b=$('payments');b.innerHTML='';for(const x of rows){const tr=document.createElement('tr');for(const v of [x.uid,x.item,x.amount,fmt(x.createdAt),x.transactionRef]){const td=document.createElement('td');td.textContent=String(v??'');tr.appendChild(td)}b.appendChild(tr)}}
async function setScore(uid,score){await api('/admin/api/score',{method:'POST',body:JSON.stringify({server:$('server').value,uid,score:Number(score)})});await loadAll()}
async function rewardScore(uid,delta){await api('/admin/api/reward',{method:'POST',body:JSON.stringify({server:$('server').value,uid,delta:Number(delta),reason:'Admin reward'})});await loadAll()}
async function moderate(uid,action){const durationMs=action==='ban'?7*86400000:action==='mute'?86400000:0;await api('/admin/api/moderate',{method:'POST',body:JSON.stringify({uid,action,durationMs,reason:'Admin panel'})});await loadAll()}
async function setControl(key,value){await api('/admin/api/control',{method:'POST',body:JSON.stringify({key,value})});await loadAll()}
document.querySelectorAll('[data-control]').forEach(b=>b.onclick=()=>setControl(b.dataset.control,$(b.dataset.control).value));
document.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=()=>setControl(b.dataset.toggle,!Boolean(lastControls[b.dataset.toggle])));
$('setRole').onclick=async()=>{await api('/admin/api/role',{method:'POST',body:JSON.stringify({email:$('roleEmail').value,role:$('roleValue').value})});await loadAll()};
$('login').onclick=async()=>{try{diag('Google Login clicked');const a=await ensureAuth();provider.setCustomParameters({prompt:'select_account'});$('status').className='muted';$('status').textContent='กำลังเปิด Google Login...';let finished=false;const watchdog=setTimeout(()=>{if(!finished&&!a.currentUser){diag('Popup still pending after 10s');$('status').className='err';$('status').textContent='Google Login ยังไม่ตอบกลับ · ดูบรรทัด Auth diagnostic ด้านบน'}},10000);const result=await a.signInWithPopup(provider);finished=true;clearTimeout(watchdog);diag('Popup resolved: '+(result?.user?'user received':'no user'))}catch(e){diag('Popup error: '+(e?.code||'')+' '+(e?.message||''));$('status').className='err';$('status').textContent=authError(e)}};$('logout').onclick=async()=>{const a=await ensureAuth();await a.signOut()};$('refresh').onclick=loadAll;$('server').onchange=loadAll;
$('export').onclick=async()=>{const r=await fetch('/admin/api/export?server='+$('server').value,{headers:await headers()});if(!r.ok)throw Error('Export failed');const blob=await r.blob(),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='voxel-'+$('server').value+'-players.csv';a.click();URL.revokeObjectURL(u)};
$('backup').onclick=async()=>{const r=await fetch('/admin/api/backup?server='+$('server').value,{headers:await headers()});if(!r.ok)throw Error('Backup failed');const blob=await r.blob(),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='voxel-'+$('server').value+'-backup.json';a.click();URL.revokeObjectURL(u)};
setInterval(()=>{if(auth?.currentUser)loadAll()},5000);ensureAuth().catch(e=>{$('status').className='err';$('status').textContent=e.message});
</script></main></body></html>`;
}

export async function handleAdmin(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/admin'&&request.method==='GET') return new Response(adminHtml(),{headers:{
    'content-type':'text/html; charset=utf-8','cache-control':'no-store',
    'content-security-policy':"default-src 'self'; script-src 'self' https://www.gstatic.com https://apis.google.com https://www.google.com https://www.recaptcha.net 'unsafe-inline'; connect-src 'self' https://*.googleapis.com https://securetoken.googleapis.com https://accounts.google.com https://gpt-voxel-3d-staging.firebaseapp.com https://www.google.com https://www.recaptcha.net; frame-src 'self' https://accounts.google.com https://gpt-voxel-3d-staging.firebaseapp.com https://www.google.com https://www.recaptcha.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;" }});
  if(url.pathname==='/admin/api/public-config'&&request.method==='GET'){
    let firebase;try{firebase=JSON.parse(String(env?.FIREBASE_PUBLIC_CONFIG||''))}catch(_){}
    const safe=firebase&&typeof firebase==='object'&&!Array.isArray(firebase)?{apiKey:String(firebase.apiKey||''),authDomain:String(firebase.authDomain||''),projectId:String(firebase.projectId||''),appId:String(firebase.appId||''),messagingSenderId:String(firebase.messagingSenderId||'')}:null;
    const siteKey=String(env?.FIREBASE_APP_CHECK_SITE_KEY||'').trim();
    if(!safe||!safe.apiKey||!safe.authDomain||safe.projectId!==env?.FIREBASE_PROJECT_ID||!siteKey)return json({ok:false,error:'Admin Firebase config unavailable'},503);
    return json({ok:true,firebase:safe,appCheck:{siteKey}});
  }

  const admin=await adminIdentity(request,env); if(!admin.ok)return json({ok:false,error:admin.error},admin.status);
  if(url.pathname==='/admin/api/me') return json({ok:true,email:admin.identity.email,role:admin.role});

  const server=url.searchParams.get('server')||'free1', room=roomFor(env,server);
  if(['/admin/api/overview','/admin/api/players','/admin/api/audit','/admin/api/export'].includes(url.pathname)&&!room)
    return json({ok:false,error:'Invalid server'},400);

  if(url.pathname==='/admin/api/overview'&&request.method==='GET'){
    if(!requireRole(admin,'moderator'))return json({ok:false,error:'Insufficient role'},403);
    const [{data:o},{data:global}]=await Promise.all([internalJson(room,'/_internal/admin/overview'),internalJson(freeRoom(env),'/_internal/admin/runtime-controls')]);
    return json({...o,controls:{
      announcement:global.announcement||'',free_name:global.freeName||'',vip_name:global.vipName||'',
      maintenance_free:Boolean(global.maintenanceFree),maintenance_vip:Boolean(global.maintenanceVip),
      payment_emergency:Boolean(global.paymentPaused),vip_admission_emergency:Boolean(global.vipAdmissionPaused)
    }});
  }
  if(url.pathname==='/admin/api/players'&&request.method==='GET'){
    if(!requireRole(admin,'moderator'))return json({ok:false,error:'Insufficient role'},403);
    const {response,data}=await internalJson(room,'/_internal/admin/list-players');return json(data,response.status);
  }
  if(url.pathname==='/admin/api/audit'&&request.method==='GET'){
    if(!requireRole(admin,'admin'))return json({ok:false,error:'Insufficient role'},403);
    const {response,data}=await internalJson(room,'/_internal/admin/audit');return json(data,response.status);
  }
  if(url.pathname==='/admin/api/payments'&&request.method==='GET'){
    if(!requireRole(admin,'admin'))return json({ok:false,error:'Insufficient role'},403);
    const {response,data}=await internalJson(freeRoom(env),'/_internal/admin/payments');return json(data,response.status);
  }
  if(url.pathname==='/admin/api/export'&&request.method==='GET'){
    if(!requireRole(admin,'admin'))return json({ok:false,error:'Insufficient role'},403);
    const {data}=await internalJson(room,'/_internal/admin/list-players');
    const esc=v=>'"'+String(v??'').replaceAll('"','""')+'"';
    const rows=[['uid','email','nickname','score','online','vipExpiresAt','bannedUntil','mutedUntil'],...(data.players||[]).map(p=>[p.uid,p.email,p.nickname,p.score,p.online,p.vipExpiresAt,p.bannedUntil,p.mutedUntil])];
    return new Response(rows.map(r=>r.map(esc).join(',')).join('\n'),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="voxel-players.csv"','cache-control':'no-store'}});
  }
  if(url.pathname==='/admin/api/backup'&&request.method==='GET'){
    if(!requireRole(admin,'admin'))return json({ok:false,error:'Insufficient role'},403);
    const [{data:players},{data:overview},{data:audit},{data:payments}]=await Promise.all([
      internalJson(room,'/_internal/admin/list-players'),internalJson(room,'/_internal/admin/overview'),
      internalJson(room,'/_internal/admin/audit'),internalJson(freeRoom(env),'/_internal/admin/payments')
    ]);
    const payload={schemaVersion:1,createdAt:Date.now(),server,overview,players:players.players||[],audit:audit.rows||[],payments:payments.rows||[]};
    return new Response(JSON.stringify(payload,null,2),{headers:{'content-type':'application/json; charset=utf-8',
      'content-disposition':'attachment; filename="voxel-backup.json"','cache-control':'no-store'}});
  }

  let body={}; if(request.method==='POST'){try{body=await request.json()}catch(_){return json({ok:false,error:'Invalid JSON'},400)}}
  if(url.pathname==='/admin/api/score'&&request.method==='POST'){
    if(!requireRole(admin,'admin'))return json({ok:false,error:'Insufficient role'},403);
    const target=roomFor(env,body?.server);if(!target)return json({ok:false,error:'Invalid server'},400);
    const {response,data}=await internalJson(target,'/_internal/admin/set-score',{method:'POST',body:{uid:body.uid,score:body.score,actor:admin.identity.email}});
    return json(data,response.status);
  }
  if(url.pathname==='/admin/api/reward'&&request.method==='POST'){
    if(!requireRole(admin,'admin'))return json({ok:false,error:'Insufficient role'},403);
    const target=roomFor(env,body?.server);if(!target)return json({ok:false,error:'Invalid server'},400);
    const {response,data}=await internalJson(target,'/_internal/admin/add-score',{method:'POST',body:{uid:body.uid,delta:body.delta,reason:body.reason,actor:admin.identity.email}});
    return json(data,response.status);
  }
  if(url.pathname==='/admin/api/moderate'&&request.method==='POST'){
    if(!requireRole(admin,'moderator'))return json({ok:false,error:'Insufficient role'},403);
    const payload={uid:body.uid,action:body.action,durationMs:body.durationMs,reason:body.reason,actor:admin.identity.email};
    const [a,b]=await Promise.all([internalJson(roomFor(env,'free1'),'/_internal/admin/moderate',{method:'POST',body:payload}),internalJson(roomFor(env,'vip1'),'/_internal/admin/moderate',{method:'POST',body:payload})]);
    if(!a.response.ok&&!b.response.ok)return json({ok:false,error:'Moderation failed'},503);return json({ok:true,free:a.data,vip:b.data});
  }
  if(url.pathname==='/admin/api/control'&&request.method==='POST'){
    const emergency=['payment_emergency','vip_admission_emergency'].includes(String(body?.key||''));
    if(!requireRole(admin,emergency?'owner':'admin'))return json({ok:false,error:'Insufficient role'},403);
    const {response,data}=await internalJson(freeRoom(env),'/_internal/admin/control-set',{method:'POST',body:{key:body.key,value:body.value,actor:admin.identity.email}});
    return json(data,response.status);
  }
  if(url.pathname==='/admin/api/role'&&request.method==='POST'){
    if(!requireRole(admin,'owner'))return json({ok:false,error:'Owner role required'},403);
    const {response,data}=await internalJson(freeRoom(env),'/_internal/admin/role-set',{method:'POST',body:{email:body.email,role:body.role,actor:admin.identity.email}});
    return json(data,response.status);
  }
  return json({ok:false,error:'Admin route not found'},404);
}

export async function publicSiteConfig(env){
  try {
    const {response,data}=await internalJson(freeRoom(env),'/_internal/admin/runtime-controls');
    if(!response.ok||!data?.ok)throw Error('unavailable');
    return json({ok:true,announcement:data.announcement||'',freeName:data.freeName||'Free Server ฟรีไม่จำกัด',
      vipName:data.vipName||'VIP Server 1',maintenanceFree:Boolean(data.maintenanceFree),
      maintenanceVip:Boolean(data.maintenanceVip),paymentPaused:Boolean(data.paymentPaused),
      vipAdmissionPaused:Boolean(data.vipAdmissionPaused),serverNow:data.serverNow});
  } catch (_) { return json({ok:false,error:'Site config unavailable'},503); }
}
