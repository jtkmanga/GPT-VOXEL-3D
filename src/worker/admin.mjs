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
:root{color-scheme:dark;--bg:#07111f;--panel:#0d1828;--panel2:#101d30;--line:#213149;--line2:#2d405d;--text:#edf4ff;--muted:#91a3bc;--accent:#60a5fa;--accent2:#1d4ed8;--good:#4ade80;--goodbg:#102b1e;--warn:#fbbf24;--danger:#f87171;--dangerbg:#38151b;--shadow:0 14px 35px rgba(0,0,0,.22)}
*{box-sizing:border-box}html{background:var(--bg)}body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:radial-gradient(circle at 20% -10%,#102847 0,transparent 34%),var(--bg);color:var(--text);min-height:100vh}main{max-width:1460px;margin:auto;padding:18px}
.topbar{position:sticky;top:0;z-index:30;margin:-18px -18px 18px;padding:14px 18px;background:rgba(7,17,31,.92);backdrop-filter:blur(14px);border-bottom:1px solid rgba(96,165,250,.15);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:11px;min-width:220px;flex:1}.brand-mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(145deg,#2563eb,#0ea5e9);box-shadow:0 8px 24px rgba(37,99,235,.28);font-weight:900}.brand h1{font-size:20px;margin:0;letter-spacing:.2px}.brand small{display:block;color:var(--muted);margin-top:1px}
.top-actions,.row,.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.toolbar{padding:12px 14px;background:rgba(13,24,40,.75);border:1px solid var(--line);border-radius:14px;margin-bottom:18px;box-shadow:var(--shadow)}
button,input,select,textarea{font:inherit;border:1px solid var(--line2);background:#0a1423;color:var(--text);border-radius:10px;min-height:38px}button{cursor:pointer;padding:8px 12px;font-weight:650;transition:.16s ease}button:hover{border-color:#4b6b95;transform:translateY(-1px)}button:active{transform:none}input,select{padding:8px 10px}textarea{width:100%;min-height:94px;padding:10px;resize:vertical}input:focus,select:focus,textarea:focus{outline:2px solid rgba(96,165,250,.22);border-color:var(--accent)}
button.primary{background:linear-gradient(180deg,#2563eb,#1d4ed8);border-color:#3b82f6}button.ghost{background:#0b1728}button.good{border-color:#21683e;background:var(--goodbg);color:#a7f3c0}button.danger{border-color:#7f2631;background:var(--dangerbg);color:#fecaca}button.active{border-color:#3b82f6;background:#142c4f;color:#dbeafe;box-shadow:inset 0 0 0 1px rgba(96,165,250,.16)}
.pill{padding:5px 9px;border:1px solid var(--line2);border-radius:999px;font-size:11px;background:#0a1423;color:#c9d8ec}.status{margin:0 0 12px;padding:9px 12px;border-radius:10px;background:#0b1728;border:1px solid var(--line);font-size:13px}.muted{color:var(--muted)}.ok{color:#a7f3c0;border-color:#215d3a;background:#0e231a}.err{color:#fecaca;border-color:#7f2631;background:#30141a}
.section{margin:18px 0 22px}.section-head{display:flex;justify-content:space-between;align-items:end;gap:12px;margin:0 0 10px}.section-head h2{font-size:17px;margin:0}.section-head span{font-size:12px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card{background:linear-gradient(180deg,rgba(16,29,48,.98),rgba(12,23,39,.98));border:1px solid var(--line);border-radius:16px;padding:14px;box-shadow:var(--shadow)}.card>b{display:block;font-size:13px;margin-bottom:8px;color:#dbe8fb}
.metric{position:relative;overflow:hidden;min-height:108px}.metric:after{content:"";position:absolute;width:82px;height:82px;border-radius:50%;right:-24px;top:-28px;background:rgba(96,165,250,.08)}.metric-label{color:var(--muted);font-size:12px}.metric-value{font-size:30px;font-weight:800;line-height:1.15;margin-top:8px;letter-spacing:-.8px}
.control-card{min-height:150px}.control-card input{width:100%;margin-bottom:8px}.control-card .row{margin-top:8px}.reset-card{min-height:170px}.reset-time{font-size:17px;font-weight:800;margin:7px 0}.winner{font-size:12px;line-height:1.55;color:#c8d7eb}.reset-note{font-size:11px;color:var(--muted);margin:8px 0 10px}
.table-card{background:rgba(13,24,40,.92);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}.scroll{overflow:auto;max-height:540px}.scroll.tall{max-height:620px}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;min-width:760px}thead{position:sticky;top:0;z-index:5;background:#101d30}th{font-size:11px;color:#a9bad1;text-transform:uppercase;letter-spacing:.3px}th,td{padding:10px;border-bottom:1px solid #1d2b40;text-align:left;vertical-align:top}tbody tr:hover{background:rgba(96,165,250,.045)}tbody tr:last-child td{border-bottom:0}td input[type=number]{width:120px;min-height:34px}td button{min-height:32px;padding:6px 9px;margin:0 4px 4px 0;font-size:11px}
.roles-card{display:grid;grid-template-columns:minmax(180px,1fr) 150px auto;gap:8px;align-items:center}.diagnostic{white-space:pre-wrap;font-size:11px;margin:8px 0 12px;max-height:150px;overflow:auto;padding:10px 12px;border:1px solid #7f2631;background:#271218;color:#fecaca;border-radius:10px}
@media(max-width:720px){main{padding:12px}.topbar{margin:-12px -12px 12px;padding:11px 12px}.brand h1{font-size:18px}.brand small{display:none}.top-actions{width:100%}.top-actions button{flex:1}.toolbar>*{flex:1 1 130px}.grid{grid-template-columns:1fr 1fr}.metric{min-height:92px}.metric-value{font-size:25px}.section{margin:15px 0 18px}.roles-card{grid-template-columns:1fr}.table-card{border-radius:12px}.scroll{max-height:520px}table{font-size:11px;min-width:720px}th,td{padding:8px}.control-card{min-height:auto}}
@media(max-width:430px){.grid{grid-template-columns:1fr 1fr}.metric{padding:12px}.metric-value{font-size:23px}.section-head span{display:none}}
</style></head><body><main>
<header class="topbar">
  <div class="brand"><div class="brand-mark">VR</div><div><h1>VOXEL RUN Admin</h1><small>Live operations · staging</small></div></div>
  <div class="top-actions"><span id="role" class="pill">signed out</span><button id="login" class="primary">Google Login</button><button id="logout" class="ghost">Logout</button></div>
</header>
<p id="status" class="status muted">ยังไม่ได้เข้าสู่ระบบ</p>
<pre id="authDiag" class="diagnostic" hidden></pre>
<div class="toolbar"><select id="server"><option value="free1">Free Server</option><option value="vip1">VIP Server</option></select><button id="refresh" class="ghost">รีเฟรชทั้งหมด</button><button id="export" class="ghost">Export CSV</button><button id="backup" class="ghost">Backup JSON</button></div>

<section class="section">
<div class="section-head"><h2>Dashboard</h2><span>สถานะเซิร์ฟเวอร์แบบเรียลไทม์</span></div>
<div class="grid">
<div class="card metric"><div class="metric-label">Online now</div><div class="metric-value" id="online">-</div></div>
<div class="card metric"><div class="metric-label">Players</div><div class="metric-value" id="playersCount">-</div></div>
<div class="card metric"><div class="metric-label">Banned</div><div class="metric-value" id="bannedCount">-</div></div>
<div class="card metric"><div class="metric-label">Muted</div><div class="metric-value" id="mutedCount">-</div></div>
</div>
</section>

<section class="section">
<div class="section-head"><h2>Score Reset</h2><span>ระบบอัตโนมัติเป็นหลัก · Manual reset สำหรับ Owner เท่านั้น</span></div>
<div class="grid">
  <div class="card reset-card">
    <b>Free Server</b>
    <div class="reset-time" id="freeResetNext">-</div>
    <div class="reset-note">อัตโนมัติ: ทุกวันอาทิตย์ 00:00 น. เวลาไทย</div>
    <div class="winner" id="freeResetWinner">ยังไม่มีประวัติการรีเซ็ต</div>
    <div class="row"><button id="resetFree" class="danger">รีเซ็ต Free ตอนนี้</button></div>
  </div>
  <div class="card reset-card">
    <b>VIP Server</b>
    <div class="reset-time" id="vipResetNext">-</div>
    <div class="reset-note">อัตโนมัติ: ทุกวัน 00:00 น. เวลาไทย</div>
    <div class="winner" id="vipResetWinner">ยังไม่มีประวัติการรีเซ็ต</div>
    <div class="row"><button id="resetVip" class="danger">รีเซ็ต VIP ตอนนี้</button></div>
  </div>
</div>
<div class="table-card" style="margin-top:12px"><div class="scroll"><table><thead><tr><th>Reset time</th><th>Server</th><th>Type</th><th>Winner email</th><th>Name</th><th>Score</th></tr></thead><tbody id="resetHistory"></tbody></table></div></div>
</section>

<section class="section">
<div class="section-head"><h2>Pricing</h2><span>ราคาจริงจาก Server · หน่วยบาทไทย (THB)</span></div>
<div class="grid">
  <div class="card control-card"><b>Speed ×2 (24 ช.ม.)</b><input id="price_speed" type="number" min="1" max="100000" step="1"><div class="row"><button class="primary" data-price="speed">บันทึกราคา Speed</button></div></div>
  <div class="card control-card"><b>Coin ×2 (24 ช.ม.)</b><input id="price_coin" type="number" min="1" max="100000" step="1"><div class="row"><button class="primary" data-price="coin">บันทึกราคา Coin</button></div></div>
  <div class="card control-card"><b>VIP Server (30 วัน)</b><input id="price_vip1" type="number" min="1" max="100000" step="1"><div class="row"><button class="primary" data-price="vip1">บันทึกราคา VIP</button></div></div>
  <div class="card control-card"><b>ข้อกำหนด</b><p class="muted">รองรับจำนวนเต็ม 1–100,000 บาท · การแก้ราคาถูกบันทึกใน Audit Log · checkout ใหม่ใช้ราคาใหม่ ส่วนรายการที่เริ่มชำระแล้วใช้ราคาที่ snapshot ไว้</p></div>
</div>
</section>

<section class="section">
<div class="section-head"><h2>Live Site / Server Controls</h2><span>การเปลี่ยนแปลงมีผลกับ staging ทันที</span></div>
<div class="grid">
<div class="card control-card"><b>ประกาศ</b><textarea id="announcement" maxlength="300" placeholder="ข้อความประกาศในเกม"></textarea><div class="row"><button class="primary" data-control="announcement">บันทึกประกาศ</button></div></div>
<div class="card control-card"><b>ชื่อเซิร์ฟเวอร์</b><input id="free_name" maxlength="80" placeholder="Free Server"><input id="vip_name" maxlength="80" placeholder="VIP Server"><div class="row"><button class="ghost" data-control="free_name">บันทึก Free</button><button class="ghost" data-control="vip_name">บันทึก VIP</button></div></div>
<div class="card control-card"><b>Maintenance</b><div class="row"><button class="ghost" data-toggle="maintenance_free">Free</button><button class="ghost" data-toggle="maintenance_vip">VIP</button></div><p class="muted">เปิดใช้เมื่อจำเป็นต้องหยุดให้บริการชั่วคราว</p></div>
<div class="card control-card"><b>Emergency</b><div class="row"><button class="danger" data-toggle="payment_emergency">Pause payment</button><button class="danger" data-toggle="vip_admission_emergency">Pause VIP admission</button></div><p class="muted">Owner only · ใช้เมื่อเกิดเหตุฉุกเฉิน</p></div>
</div>
</section>

<section class="section">
<div class="section-head"><h2>Players</h2><span>คะแนน สถานะ และ moderation</span></div>
<div class="table-card"><div class="scroll tall"><table><thead><tr><th>Email / UID</th><th>Name</th><th>Score</th><th>Online / VIP</th><th>Moderation</th></tr></thead><tbody id="players"></tbody></table></div></div>
</section>

<section class="section">
<div class="section-head"><h2>Roles</h2><span>กำหนดสิทธิ์ผู้ดูแล</span></div>
<div class="card roles-card"><input id="roleEmail" placeholder="email@example.com"><select id="roleValue"><option value="moderator">Moderator</option><option value="admin">Admin</option><option value="none">Remove</option></select><button id="setRole" class="primary">บันทึก Role</button></div>
</section>

<section class="section">
<div class="section-head"><h2>ประวัติการชำระเงิน / สลิป</h2><span>เก็บเฉพาะข้อมูลที่จำเป็น · ไม่เก็บรูปสลิปหรือเลขบัญชี</span></div>
<div class="grid" style="margin-bottom:12px">
  <div class="card metric"><div class="metric-label">รายการทั้งหมด</div><div class="metric-value" id="paymentTotal">-</div></div>
  <div class="card metric"><div class="metric-label">ให้สิทธิ์สำเร็จ</div><div class="metric-value" id="paymentGranted">-</div></div>
  <div class="card metric"><div class="metric-label">สลิปใช้ซ้ำ</div><div class="metric-value" id="paymentDuplicate">-</div></div>
  <div class="card metric"><div class="metric-label">ไม่ผ่าน / ขัดข้อง</div><div class="metric-value" id="paymentFailed">-</div></div>
</div>
<div class="toolbar" style="margin-bottom:10px"><label for="paymentFilter" class="muted">สถานะ</label><select id="paymentFilter"><option value="all">ทั้งหมด</option><option value="granted">สำเร็จ</option><option value="duplicate">สลิปใช้ซ้ำ</option><option value="failed">ไม่ผ่าน / ขัดข้อง</option></select></div>
<div class="table-card"><div class="scroll tall"><table><thead><tr><th>เวลา</th><th>ผู้เล่น</th><th>รายการ</th><th>ยอด</th><th>สถานะ</th><th>สิทธิ์ / รายละเอียด</th><th>Ref</th></tr></thead><tbody id="payments"></tbody></table></div></div>
</section>

<section class="section">
<div class="section-head"><h2>Audit Log</h2><span>ประวัติการทำงานของ Admin</span></div>
<div class="table-card"><div class="scroll"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody id="audit"></tbody></table></div></div>
</section>

<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script><script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js"></script><script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check-compat.js"></script>
<script>
let auth=null,provider=null,appCheck=null,me=null,lastControls={},lastPayments=[]; const $=id=>document.getElementById(id);
function diag(msg,important=false){const el=$('authDiag');if(!el)return;const t=new Date().toLocaleTimeString('th-TH');el.textContent=(el.textContent+'['+t+'] '+String(msg)+'\\n').slice(-4000);el.scrollTop=el.scrollHeight;if(important)el.hidden=false}
function clearDiag(){const el=$('authDiag');if(el){el.hidden=true;el.textContent=''}}
window.addEventListener('error',e=>diag('JS error: '+(e?.message||'unknown'),true));
window.addEventListener('unhandledrejection',e=>diag('Promise error: '+(e?.reason?.code||'')+' '+(e?.reason?.message||e?.reason||'unknown'),true));
function authError(e){const code=String(e?.code||'');if(code==='auth/unauthorized-domain')return 'โดเมน staging ยังไม่ได้รับอนุญาตใน Firebase Authentication';if(code==='auth/popup-blocked'||code==='auth/popup-closed-by-user'||code==='auth/cancelled-popup-request')return 'เบราว์เซอร์ปิดหน้าต่างเข้าสู่ระบบ กรุณาลองใหม่';return e?.message||'เข้าสู่ระบบไม่สำเร็จ'}
async function ensureAuth(){if(auth)return auth;diag('Loading Firebase config...');const r=await fetch('/admin/api/public-config',{cache:'no-store'}),j=await r.json();if(!r.ok)throw Error(j.error||'Firebase config unavailable');diag('Firebase config OK · authDomain='+j.firebase.authDomain);firebase.initializeApp(j.firebase);if(!j.appCheck?.siteKey)throw Error('Firebase App Check config unavailable');appCheck=firebase.appCheck();appCheck.activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(j.appCheck.siteKey),true);diag('Firebase App Check initialized');try{const token=await appCheck.getToken(false);if(!token?.token)throw Error('App Check token missing');diag('Firebase App Check token ready')}catch(e){diag('App Check error: '+(e?.code||'')+' '+(e?.message||''),true);throw Error('Firebase App Check token unavailable')}auth=firebase.auth();provider=new firebase.auth.GoogleAuthProvider();diag('Firebase Auth initialized');try{await auth.getRedirectResult()}catch(e){diag('Redirect result error: '+(e?.code||'')+' '+(e?.message||''),true);$('status').className='status err';$('status').textContent=authError(e)}auth.onAuthStateChanged(async u=>{diag('Auth state: '+(u?'SIGNED IN':'signed out'));if(u){await loadMe();await loadAll();}else{me=null;$('role').textContent='signed out';if(!$('status').classList.contains('err'))$('status').textContent='ยังไม่ได้เข้าสู่ระบบ';}});return auth}
async function headers(){const a=await ensureAuth(),u=a.currentUser;if(!u)throw Error('กรุณาเข้าสู่ระบบ');return {'Authorization':'Bearer '+await u.getIdToken(),'Content-Type':'application/json'}}
async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{...(opt.headers||{}),...(await headers())}});const type=r.headers.get('content-type')||'';const j=type.includes('json')?await r.json():await r.text();if(!r.ok)throw Error(j?.error||j||'Request failed');return j}
async function loadMe(){me=await api('/admin/api/me');$('role').textContent=me.email+' · '+me.role}
function fmt(t){return t?new Date(Number(t)).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'}):'-'}
function syncToggleButtons(){document.querySelectorAll('[data-toggle]').forEach(b=>b.classList.toggle('active',Boolean(lastControls[b.dataset.toggle])))}
function resetWinnerText(status){const latest=status?.history?.[0];if(!latest)return 'ยังไม่มีประวัติการรีเซ็ต';const winners=latest.winners||[];if(!winners.length)return 'รีเซ็ตล่าสุด '+fmt(latest.resetAt)+' · ไม่มีผู้เล่น';const label=winners.map(w=>(w.email||'(no email)')+' · '+w.score+' คะแนน').join(' / ');return 'แชมป์ล่าสุด: '+label+' · '+fmt(latest.resetAt)}
function renderResetStatus(data){const free=data?.free||{},vip=data?.vip||{};$('freeResetNext').textContent='ครั้งถัดไป '+fmt(free.nextResetAt);$('vipResetNext').textContent='ครั้งถัดไป '+fmt(vip.nextResetAt);$('freeResetWinner').textContent=resetWinnerText(free);$('vipResetWinner').textContent=resetWinnerText(vip);const rows=[];for(const status of [free,vip])for(const reset of status.history||[]){if(reset.winners?.length){for(const w of reset.winners)rows.push({reset,w})}else rows.push({reset,w:{email:'-',nickname:'-',score:0}})}rows.sort((a,b)=>Number(b.reset.resetAt)-Number(a.reset.resetAt));const body=$('resetHistory');body.innerHTML='';for(const item of rows.slice(0,60)){const tr=document.createElement('tr');for(const v of [fmt(item.reset.resetAt),item.reset.server==='vip1'?'VIP':'Free',item.reset.resetType,item.w.email||'(no email)',item.w.nickname||'-',item.w.score]){const td=document.createElement('td');td.textContent=String(v);tr.appendChild(td)}body.appendChild(tr)}}
async function loadAll(){try{const s=$('server').value;const [o,p,a,pm,rs,pricing]=await Promise.all([api('/admin/api/overview?server='+s),api('/admin/api/players?server='+s),api('/admin/api/audit?server='+s),api('/admin/api/payments'),api('/admin/api/reset-status'),api('/admin/api/pricing')]);$('online').textContent=o.online;$('playersCount').textContent=o.players;$('bannedCount').textContent=o.banned;$('mutedCount').textContent=o.muted;lastControls=o.controls||{};for(const k of ['announcement','free_name','vip_name'])$(k).value=lastControls[k]||'';for(const item of ['speed','coin','vip1'])$('price_'+item).value=pricing.pricing?.[item]??'';syncToggleButtons();renderPlayers(p.players||[]);renderAudit(a.rows||[]);lastPayments=pm.rows||[];renderPaymentSummary();renderPayments();renderResetStatus(rs);clearDiag();$('status').className='status ok';$('status').textContent='ออนไลน์ · อัปเดต '+fmt(o.serverNow)}catch(e){$('status').className='status err';$('status').textContent=e.message;diag('Admin data error: '+(e?.message||e),true)}}
function renderPlayers(rows){const b=$('players');b.innerHTML='';for(const p of rows){const tr=document.createElement('tr');const ident=document.createElement('td');ident.textContent=(p.email||'(no email)')+'\\n'+p.uid;ident.style.whiteSpace='pre-line';const name=document.createElement('td');name.textContent=p.nickname;const score=document.createElement('td');const i=document.createElement('input');i.type='number';i.min='0';i.value=p.score;const save=document.createElement('button');save.textContent='Set';save.onclick=()=>setScore(p.uid,i.value);const reward=document.createElement('button');reward.textContent='+100';reward.className='good';reward.onclick=()=>rewardScore(p.uid,100);score.append(i,save,reward);const state=document.createElement('td');state.textContent=(p.online?'🟢 Online':'⚪ Offline')+'\\nVIP: '+fmt(p.vipExpiresAt);state.style.whiteSpace='pre-line';const mod=document.createElement('td');for(const [label,action] of [['Kick','kick'],['Ban 7d','ban'],['Unban','unban'],['Mute 24h','mute'],['Unmute','unmute']]){const bt=document.createElement('button');bt.textContent=label;bt.onclick=()=>moderate(p.uid,action);mod.appendChild(bt)}tr.append(ident,name,score,state,mod);b.appendChild(tr)}}
function renderAudit(rows){const b=$('audit');b.innerHTML='';for(const x of rows){const tr=document.createElement('tr');for(const v of [fmt(x.created_at),x.actor,x.action,x.target_uid||'',x.metadata||'']){const td=document.createElement('td');td.textContent=String(v);tr.appendChild(td)}b.appendChild(tr)}}
function paymentStatusLabel(status){return ({granted:'✅ ให้สิทธิ์สำเร็จ',duplicate:'♻️ สลิปใช้แล้ว',rejected:'❌ Slip2Go ไม่ผ่าน',amount_mismatch:'⚠️ ยอดไม่ตรง',reference_missing:'⚠️ ไม่พบ Reference',grant_failed:'❌ ให้สิทธิ์ไม่สำเร็จ',service_error:'⚠️ ระบบขัดข้อง'})[status]||status||'-'}
function renderPaymentSummary(){const rows=lastPayments;$('paymentTotal').textContent=rows.length;$('paymentGranted').textContent=rows.filter(x=>x.status==='granted').length;$('paymentDuplicate').textContent=rows.filter(x=>x.status==='duplicate').length;$('paymentFailed').textContent=rows.filter(x=>!['granted','duplicate'].includes(x.status)).length}
function renderPayments(){const b=$('payments');b.innerHTML='';const filter=$('paymentFilter')?.value||'all';const rows=lastPayments.filter(x=>filter==='all'||x.status===filter||(filter==='failed'&&!['granted','duplicate'].includes(x.status)));for(const x of rows){const tr=document.createElement('tr');const player=(x.email||'(no email)')+'\\n'+(x.nickname||x.uid||'-');const detail=x.status==='granted'?(x.expiresAt?'หมดอายุ '+fmt(x.expiresAt):'ให้สิทธิ์แล้ว'):[x.providerCode?('Code '+x.providerCode):'',x.message||''].filter(Boolean).join(' · ');for(const v of [fmt(x.createdAt),player,x.item,(x.amount??0)+' THB',paymentStatusLabel(x.status),detail,x.transactionRef?('…'+x.transactionRef):'-']){const td=document.createElement('td');td.textContent=String(v??'');if(v===player)td.style.whiteSpace='pre-line';tr.appendChild(td)}b.appendChild(tr)}}
async function setScore(uid,score){await api('/admin/api/score',{method:'POST',body:JSON.stringify({server:$('server').value,uid,score:Number(score)})});await loadAll()}
async function rewardScore(uid,delta){await api('/admin/api/reward',{method:'POST',body:JSON.stringify({server:$('server').value,uid,delta:Number(delta),reason:'Admin reward'})});await loadAll()}
async function moderate(uid,action){const durationMs=action==='ban'?7*86400000:action==='mute'?86400000:0;await api('/admin/api/moderate',{method:'POST',body:JSON.stringify({uid,action,durationMs,reason:'Admin panel'})});await loadAll()}
async function setControl(key,value){await api('/admin/api/control',{method:'POST',body:JSON.stringify({key,value})});await loadAll()}
async function setPrice(item){const input=$('price_'+item);const price=Number(input.value);if(!Number.isSafeInteger(price)||price<1||price>100000){alert('กรุณาใส่ราคาเป็นจำนวนเต็ม 1–100,000 บาท');return}if(!confirm('ยืนยันเปลี่ยนราคา '+item+' เป็น '+price+' บาท?'))return;await api('/admin/api/pricing',{method:'POST',body:JSON.stringify({item,price})});await loadAll()}
document.querySelectorAll('[data-price]').forEach(b=>b.onclick=()=>setPrice(b.dataset.price));
document.querySelectorAll('[data-control]').forEach(b=>b.onclick=()=>setControl(b.dataset.control,$(b.dataset.control).value));
document.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=()=>setControl(b.dataset.toggle,!Boolean(lastControls[b.dataset.toggle])));
$('setRole').onclick=async()=>{await api('/admin/api/role',{method:'POST',body:JSON.stringify({email:$('roleEmail').value,role:$('roleValue').value})});await loadAll()};
async function manualReset(server){const label=server==='vip1'?'VIP Server':'Free Server';if(!confirm('ยืนยันรีเซ็ตคะแนน '+label+' ตอนนี้? ระบบอัตโนมัติจะยังทำงานตามเวลาเดิม'))return;try{$('status').className='status muted';$('status').textContent='กำลังรีเซ็ตคะแนน '+label+'...';const result=await api('/admin/api/reset',{method:'POST',body:JSON.stringify({server})});$('status').className='status ok';$('status').textContent='รีเซ็ต '+label+' สำเร็จ · บันทึกแชมป์ '+(result.winners?.length||0)+' คน';await loadAll()}catch(e){$('status').className='status err';$('status').textContent=e.message;diag('Manual reset error: '+(e?.message||e),true)}}
$('resetFree').onclick=()=>manualReset('free1');$('resetVip').onclick=()=>manualReset('vip1');$('paymentFilter').onchange=renderPayments;
$('login').onclick=async()=>{try{clearDiag();const a=await ensureAuth();provider.setCustomParameters({prompt:'select_account'});$('status').className='status muted';$('status').textContent='กำลังเปิด Google Login...';await a.signInWithPopup(provider)}catch(e){diag('Popup error: '+(e?.code||'')+' '+(e?.message||''),true);$('status').className='status err';$('status').textContent=authError(e)}};$('logout').onclick=async()=>{const a=await ensureAuth();await a.signOut()};$('refresh').onclick=loadAll;$('server').onchange=loadAll;
$('export').onclick=async()=>{const r=await fetch('/admin/api/export?server='+$('server').value,{headers:await headers()});if(!r.ok)throw Error('Export failed');const blob=await r.blob(),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='voxel-'+$('server').value+'-players.csv';a.click();URL.revokeObjectURL(u)};
$('backup').onclick=async()=>{const r=await fetch('/admin/api/backup?server='+$('server').value,{headers:await headers()});if(!r.ok)throw Error('Backup failed');const blob=await r.blob(),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='voxel-'+$('server').value+'-backup.json';a.click();URL.revokeObjectURL(u)};
setInterval(()=>{if(auth?.currentUser)loadAll()},5000);ensureAuth().catch(e=>{diag('Auth startup error: '+(e?.message||e),true);$('status').className='status err';$('status').textContent=e.message});
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

  if(url.pathname==='/admin/api/reset-status'&&request.method==='GET'){
    if(!requireRole(admin,'admin'))return json({ok:false,error:'Insufficient role'},403);
    const free=roomFor(env,'free1'),vip=roomFor(env,'vip1');
    const configured=await vip.fetch(new Request('https://internal/_internal/configure-scope',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:'vip1'})
    }));
    if(!configured.ok)return json({ok:false,error:'VIP reset status unavailable'},503);
    const [freeResponse,vipResponse]=await Promise.all([
      free.fetch(new Request('https://internal/_internal/admin/reset-status')),
      vip.fetch(new Request('https://internal/_internal/admin/reset-status'))
    ]);
    const [freeData,vipData]=await Promise.all([freeResponse.json(),vipResponse.json()]);
    if(!freeResponse.ok||!vipResponse.ok)return json({ok:false,error:'Reset status unavailable'},503);
    return json({ok:true,free:freeData,vip:vipData,serverNow:Date.now()});
  }

  if(url.pathname==='/admin/api/pricing'&&request.method==='GET'){
    if(!requireRole(admin,'admin'))return json({ok:false,error:'Insufficient role'},403);
    const {response,data}=await internalJson(freeRoom(env),'/_internal/admin/pricing');
    return json(data,response.status);
  }

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
  if(url.pathname==='/admin/api/reset'&&request.method==='POST'){
    if(!requireRole(admin,'owner'))return json({ok:false,error:'Owner role required'},403);
    const scope=String(body?.server||'');
    const target=roomFor(env,scope);if(!target)return json({ok:false,error:'Invalid server'},400);
    if(scope==='vip1'){
      const configured=await target.fetch(new Request('https://internal/_internal/configure-scope',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:'vip1'})
      }));
      if(!configured.ok)return json({ok:false,error:'VIP reset scope unavailable'},503);
    }
    const {response,data}=await internalJson(target,'/_internal/admin/manual-score-reset',{
      method:'POST',body:{actor:admin.identity.email}
    });
    return json(data,response.status);
  }

  if(url.pathname==='/admin/api/pricing'&&request.method==='POST'){
    if(!requireRole(admin,'admin'))return json({ok:false,error:'Insufficient role'},403);
    const item=String(body?.item||''),price=Number(body?.price);
    const {response,data}=await internalJson(freeRoom(env),'/_internal/admin/price-set',{
      method:'POST',body:{item,price,actor:admin.identity.email}
    });
    return json(data,response.status);
  }

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
      vipAdmissionPaused:Boolean(data.vipAdmissionPaused),pricing:data.pricing||{currency:'THB',speed:10,coin:20,vip1:50},
      serverNow:data.serverNow});
  } catch (_) { return json({ok:false,error:'Site config unavailable'},503); }
}
