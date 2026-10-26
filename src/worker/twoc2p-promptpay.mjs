import { verifyFirebaseRequestTokens } from './firebase-auth.mjs';
import { sign2c2pJwt, verify2c2pJwt, parse2c2pJson, Twoc2pJwtError } from './twoc2p-jwt.mjs';
import { PromptPayStore } from './promptpay-store.mjs';
import { paymentEventFingerprint, validVipUid } from './payment-events.mjs';

export const TWOC2P_PROMPTPAY = Object.freeze({
  tokenApi: 'https://pgw.2c2p.com/payment/4.5/paymentToken',
  paymentApi: 'https://pgw.2c2p.com/payment/4.5/payment',
  origin: 'https://voxel-run-v2-demo.hjinffv5426.workers.dev',
  clientOrigin: 'https://jtkmanga.github.io',
  project: 'lucky-game-6936b',
  channelCode: 'PPQR',
  currency: 'THB'
});

export class PromptPayError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}
const fail=(message,status)=>{throw new PromptPayError(message,status);};
const ownObject=value=>value&&typeof value==='object'&&!Array.isArray(value);
const safeIdentifier=(value,maximum)=>typeof value==='string'&&value.length>0&&value.length<=maximum&&/^[A-Za-z0-9._:-]+$/.test(value);

export function promptPayConfig(env,action='checkout'){
  if(env.APP_ENV==='staging'||env.PAYMENT_MODE!=='2c2p-promptpay-production'||
      env.ALLOWED_ORIGIN!==TWOC2P_PROMPTPAY.clientOrigin||
      env.FIREBASE_PROJECT_ID!==TWOC2P_PROMPTPAY.project||!env.ROOM||!env.ZONE)
    fail('PromptPay production payment is disabled',503);
  if(env.TWOC2P_PROMPTPAY_ENABLED!=='true'||
      env.TWOC2P_PROMPTPAY_MERCHANT_CAPABILITIES_VERIFIED!=='true'||
      (action==='checkout'&&env.TWOC2P_PROMPTPAY_CHECKOUT_ENABLED!=='true')||
      (action==='backend'&&env.TWOC2P_PROMPTPAY_BACKEND_ENABLED!=='true'))
    fail('PromptPay production payment is disabled',503);
  const merchantID=String(env.TWOC2P_PRODUCTION_MERCHANT_ID||'').trim();
  const secret=env.TWOC2P_PRODUCTION_SECRET_KEY;
  const size=typeof secret==='string'?new TextEncoder().encode(secret).byteLength:0;
  if(!safeIdentifier(merchantID,64)||size<32||size>4096)
    fail('PromptPay production signing boundary is unavailable',503);
  return {merchantID,secret};
}

async function boundedJson(message,maximum=24*1024){
  if(!/^application\/json(?:\s*;|$)/i.test(message.headers.get('Content-Type')||''))
    fail('JSON payment data required',415);
  const declared=message.headers.get('Content-Length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximum))fail('Payment data too large',413);
  if(!message.body)fail('Payment data required',400);
  const reader=message.body.getReader(),parts=[];let size=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>maximum){await reader.cancel();fail('Payment data too large',413);}parts.push(value);}
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.byteLength;}
  let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
  catch(_){fail('Invalid payment data',400);}
  try{return parse2c2pJson(text,maximum);}catch(_){fail('Invalid payment data',400);}
}

function envelopeToken(envelope){
  if(!ownObject(envelope)||Object.keys(envelope).length!==1||typeof envelope.payload!=='string')
    fail('Invalid signed payment envelope',400);
  return envelope.payload;
}

async function authenticatedIdentity(request,env){
  if(request.headers.get('Origin')!==TWOC2P_PROMPTPAY.clientOrigin)fail('Origin not allowed',403);
  const authorization=request.headers.get('Authorization')||'';
  if(!/^Bearer [A-Za-z0-9._-]+$/.test(authorization))fail('Sign in required',401);
  try{
    const identity=await verifyFirebaseRequestTokens(authorization.slice(7),request.headers.get('X-Firebase-AppCheck'),env);
    if(!validVipUid(identity.uid))fail('Sign in required',401);
    return identity;
  }catch(_){fail('Sign in required',401);}
}

function requireCurrentIdentity(identity){
  if(!identity||!Number.isSafeInteger(identity.exp)||identity.exp<=Math.floor(Date.now()/1000))
    fail('Sign in required',401);
}

export function buildPromptPayPaymentTokenRequest(checkout,merchantID){
  if(!ownObject(checkout)||checkout.merchantID!==merchantID||
      !Number.isSafeInteger(checkout.amount)||checkout.amount<1||checkout.amount>100000||
      checkout.currencyCode!=='THB'||!safeIdentifier(checkout.invoiceNo,20)||
      !Number.isSafeInteger(checkout.periodEnd))fail('PromptPay invoice unavailable',503);
  return {
    merchantID,invoiceNo:checkout.invoiceNo,
    description:'VOXEL RUN VIP Server 30 days',
    amount:checkout.amount,currencyCode:'THB',paymentChannel:['PPQR'],
    frontendReturnUrl:TWOC2P_PROMPTPAY.clientOrigin+'/?payment=promptpay-return',
    backendReturnUrl:TWOC2P_PROMPTPAY.origin+'/payments/promptpay/backend'
  };
}

export function buildPromptPayDoPaymentRequest(paymentToken){
  if(typeof paymentToken!=='string'||paymentToken.length<16||paymentToken.length>512)
    fail('PromptPay payment token unavailable',502);
  return {
    paymentToken,locale:'th',
    responseReturnUrl:TWOC2P_PROMPTPAY.clientOrigin+'/?payment=promptpay-return',
    payment:{code:{channelCode:'PPQR'},data:{name:'VOXEL RUN Player'}}
  };
}

export function validatePromptPayQrResponse(payload){
  if(!ownObject(payload)||payload.respCode!=='1005'||payload.channelCode!=='PPQR'||
      payload.type!=='URL'||typeof payload.data!=='string'||payload.data.length<10||payload.data.length>2048)
    fail('PromptPay QR response rejected',502);
  let url;try{url=new URL(payload.data);}catch(_){fail('PromptPay QR response rejected',502);}
  const host=url.hostname.toLowerCase();
  const allowed=(host==='pgw-static.s3.amazonaws.com'||host==='pgw-static-sandbox.s3.amazonaws.com'||
    host==='pgw.2c2p.com'||host.endsWith('.pgw.2c2p.com')||host==='api.2c2p.com'||host.endsWith('.api.2c2p.com'));
  if(url.protocol!=='https:'||url.username||url.password||url.port||!allowed)
    fail('PromptPay QR response rejected',502);
  const expiryTimer=Number(payload.expiryTimer);
  return {qrImageUrl:url.href,expiryTimer:Number.isFinite(expiryTimer)&&expiryTimer>0&&expiryTimer<=30*60*1000?expiryTimer:null};
}

function validProviderDate(value){
  if(typeof value!=='string'||!/^\d{14}$/.test(value))return false;
  const p=[value.slice(0,4),value.slice(4,6),value.slice(6,8),value.slice(8,10),value.slice(10,12),value.slice(12,14)].map(Number);
  const [year,month,day,hour,minute,second]=p;
  return year>=2000&&month>=1&&month<=12&&day>=1&&hour<=23&&minute<=59&&second<=59&&
    new Date(Date.UTC(year,month,0)).getUTCDate()>=day;
}

export function normalizePromptPayNotification(payload,merchantID){
  const clientOwned=['uid','userId','vip','vip1','paid','success','entitlement','entitlements',
    'vip1Expires','periodStart','periodEnd','score','reward','__proto__','constructor','prototype'];
  if(!ownObject(payload)||payload.merchantID!==merchantID||clientOwned.some(name=>Object.hasOwn(payload,name))||
      !safeIdentifier(payload.invoiceNo,20)||payload.currencyCode!=='THB'||
      !safeIdentifier(payload.paymentID,255)||!safeIdentifier(payload.referenceNo,50)||
      typeof payload.respCode!=='string'||!/^\d{4}$/.test(payload.respCode)||
      !validProviderDate(payload.transactionDateTime))
    fail('Invalid PromptPay payment notification',400);
  if(!Number.isSafeInteger(payload.amount)||payload.amount<1||payload.amount>100000)
    fail('Invalid PromptPay payment amount',400);
  const result={merchantID:payload.merchantID,invoiceNo:payload.invoiceNo,amount:payload.amount,
    currencyCode:'THB',paymentID:payload.paymentID,referenceNo:payload.referenceNo,
    respCode:payload.respCode,transactionDateTime:payload.transactionDateTime};
  if(payload.tranRef!==undefined){
    if(!safeIdentifier(payload.tranRef,255))fail('Invalid PromptPay transaction identity',400);
    result.tranRef=payload.tranRef;
  }
  return result;
}

const reply=(body,status=200)=>Response.json(body,{status,headers:{
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
const failureReply=error=>reply({ok:false,error:error instanceof PromptPayError||error instanceof Twoc2pJwtError?
  error.message:'PromptPay payment authority unavailable'},
  error instanceof PromptPayError||error instanceof Twoc2pJwtError?error.status:503);

async function assertPaymentsNotPaused(env){
  const response=await env.ROOM.getByName('free-v2-demo').fetch(new Request('https://internal/_internal/admin/runtime-controls'));
  const data=await response.json();
  if(!response.ok)fail('Payment authority unavailable',503);
  if(data?.paymentPaused===true)fail('Payments are temporarily paused',503);
}

async function internalCall(env,action,body){
  const response=await env.ROOM.getByName('free-v2-demo').fetch(new Request(
    'https://internal/_internal/promptpay/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));
  const result=await response.json();
  if(!response.ok||!result?.ok)fail(result?.error||'PromptPay payment authority unavailable',response.status);
  return result;
}

async function providerCall(url,payload,secret,label){
  const signed=await sign2c2pJwt(payload,secret);
  const response=await fetch(url,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({payload:signed}),signal:AbortSignal.timeout(10_000)});
  if(!response.ok)fail(label+' request failed',502);
  try{return await verify2c2pJwt(envelopeToken(await boundedJson(response)),secret);}
  catch(error){if(error instanceof Twoc2pJwtError)fail(label+' response unverified',502);throw error;}
}

export async function handle2c2pPromptPay(request,env){
  const url=new URL(request.url),path=url.pathname;
  try{
    if(path==='/payments/promptpay/backend'){
      const config=promptPayConfig(env,'backend');await assertPaymentsNotPaused(env);
      if(request.method!=='POST')return reply({ok:false,error:'Method not allowed'},405);
      const payload=await verify2c2pJwt(envelopeToken(await boundedJson(request)),config.secret);
      const notification=normalizePromptPayNotification(payload,config.merchantID);
      const result=await internalCall(env,'notification',{notification,fingerprint:await paymentEventFingerprint(notification)});
      return reply({ok:true,status:result.status,replayed:Boolean(result.replayed),entitlementGranted:Boolean(result.entitlementGranted)});
    }
    if(path!=='/payments/promptpay/checkout'&&path!=='/payments/promptpay/status')
      return reply({ok:false,error:'Not found'},404);
    const config=promptPayConfig(env,'checkout');
    if((path.endsWith('/checkout')&&request.method!=='POST')||(path.endsWith('/status')&&request.method!=='GET'))
      return reply({ok:false,error:'Method not allowed'},405);
    const identity=await authenticatedIdentity(request,env),uid=identity.uid;
    if(path.endsWith('/status')){
      const invoiceNo=url.searchParams.get('invoiceNo');
      if(!safeIdentifier(invoiceNo,20)||url.searchParams.getAll('invoiceNo').length!==1||
          [...url.searchParams.keys()].some(key=>key!=='invoiceNo'))fail('Invalid PromptPay invoice',400);
      const status=await internalCall(env,'status',{uid,invoiceNo});requireCurrentIdentity(identity);return reply(status);
    }
    await assertPaymentsNotPaused(env);
    const input=await boundedJson(request,2048);
    if(Object.keys(input).length!==1||!safeIdentifier(input.requestId,128)||input.requestId.length<16)
      fail('Invalid PromptPay checkout request',400);
    const checkout=await internalCall(env,'create',{uid,requestId:input.requestId});
    const claimed=await internalCall(env,'claim',{uid,invoiceNo:checkout.invoiceNo});
    if(!claimed.ok)fail('PromptPay checkout already requested',409);
    try{
      requireCurrentIdentity(identity);
      const tokenResponse=await providerCall(TWOC2P_PROMPTPAY.tokenApi,
        buildPromptPayPaymentTokenRequest(checkout,config.merchantID),config.secret,'PromptPay payment token');
      if(tokenResponse.respCode!=='0000'||typeof tokenResponse.paymentToken!=='string')
        fail('PromptPay payment token request rejected',502);
      requireCurrentIdentity(identity);
      const paymentResponse=await providerCall(TWOC2P_PROMPTPAY.paymentApi,
        buildPromptPayDoPaymentRequest(tokenResponse.paymentToken),config.secret,'PromptPay QR');
      const qr=validatePromptPayQrResponse(paymentResponse);
      await internalCall(env,'finish',{uid,invoiceNo:checkout.invoiceNo,succeeded:true});
      requireCurrentIdentity(identity);
      return reply({ok:true,invoiceNo:checkout.invoiceNo,amount:checkout.amount,currencyCode:'THB',
        expiresAt:checkout.expiresAt,qrImageUrl:qr.qrImageUrl,qrExpiresInMs:qr.expiryTimer});
    }catch(error){
      try{await internalCall(env,'finish',{uid,invoiceNo:checkout.invoiceNo,succeeded:false});}catch(_){}
      throw error;
    }
  }catch(error){return failureReply(error);}
}

export async function handlePromptPayInternal(request,room){
  try{
    if(room.serverScope!=='free1'||request.method!=='POST')fail('PromptPay entitlement authority unavailable',403);
    const action=new URL(request.url).pathname.slice('/_internal/promptpay/'.length);
    const config=promptPayConfig(room.env,action==='notification'?'backend':'checkout');
    const input=await boundedJson(request);
    const store=room.promptPayStore??=new PromptPayStore(room.ctx,room.vip);
    let result;
    if(action==='create'){
      if(!validVipUid(input.uid)||!safeIdentifier(input.requestId,128)||input.requestId.length<16||
          Object.keys(input).some(key=>!['uid','requestId'].includes(key)))fail('Invalid PromptPay checkout',400);
      result=store.createCheckout({uid:input.uid,merchantID:config.merchantID,requestId:input.requestId},
        Date.now(),room.price('vip1'));
    }else if(action==='claim'||action==='finish'||action==='status'){
      if(!validVipUid(input.uid)||!safeIdentifier(input.invoiceNo,20))fail('Invalid PromptPay invoice',400);
      const row=store.checkout(input.invoiceNo);
      if(!row.ok||row.uid!==input.uid||row.merchantID!==config.merchantID)fail('PromptPay invoice unavailable',404);
      if(action==='claim')result=store.claimTokenAttempt({invoiceNo:input.invoiceNo,uid:input.uid});
      else if(action==='finish'){
        if(typeof input.succeeded!=='boolean')fail('Invalid PromptPay token result',400);
        result=store.finishTokenAttempt({invoiceNo:input.invoiceNo,uid:input.uid,succeeded:input.succeeded});
      }else result={ok:true,invoiceNo:row.invoiceNo,status:row.status,expiresAt:row.expiresAt,
        vipExpiresAt:room.vip.entitlement(input.uid).expiresAt};
    }else if(action==='notification'){
      const notification=normalizePromptPayNotification(input.notification,config.merchantID);
      if(input.fingerprint!==await paymentEventFingerprint(notification))fail('PromptPay event integrity conflict',400);
      result=store.applyNotification({notification,fingerprint:input.fingerprint});
    }else fail('Unknown PromptPay payment action',404);
    return reply(result,result.ok?200:result.status||409);
  }catch(error){return failureReply(error);}
}
