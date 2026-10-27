import { verifyFirebaseRequestTokens } from './firebase-auth.mjs';
import { verifyPaymentEvent, PaymentBoundaryError } from './payment-events.mjs';

async function runtimeControls(env) {
  const response=await env.ROOM.getByName('free-v2-demo').fetch(new Request('https://internal/_internal/admin/runtime-controls'));
  const data=await response.json();
  if (!response.ok || !data?.ok) throw Error('Runtime controls unavailable');
  return data;
}
async function paymentsPaused(env) {
  try { return (await runtimeControls(env))?.paymentPaused===true; }
  catch (_) { return false; }
}
async function currentPrice(env,item) {
  const data=await runtimeControls(env);
  const price=Number(data?.pricing?.[item]);
  if (!['speed','coin','vip1'].includes(item) || !Number.isSafeInteger(price) || price<1 || price>100000)
    throw Error('Pricing authority unavailable');
  return price;
}

// Server-to-server provider adapter. A Firebase login or browser payment flag
// cannot authorize this route; only a fresh signature over the exact bytes can.
export async function handlePaymentWebhook(request, env) {
  try {
    const verified = await verifyPaymentEvent(request, env);
    if (await paymentsPaused(env)) return Response.json({ok:false,error:'Payments are temporarily paused'},{status:503});
    const response = await env.ROOM.getByName('free-v2-demo').fetch(new Request(
      'https://internal/_internal/vip/apply-event', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(verified)
      }));
    const result = await response.json();
    return Response.json(result, { status: response.status });
  } catch (error) {
    const status = error instanceof PaymentBoundaryError ? error.status : 503;
    return Response.json({ ok: false, error: status === 503
      ? 'Payment authority unavailable' : error.message }, { status });
  }
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || origin;

  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Firebase-AppCheck',
    'Vary': 'Origin'
  };
}

export function jsonResponse(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request, env),
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

// A same-origin browser GET can omit Origin. Staging's explicit host guard
// still fences it; bearer identity remains mandatory. Legacy CORS is unchanged.
export function allowedRequestOrigin(request, env) {
  if (!env.ALLOWED_ORIGIN || request.headers.get('Origin') === env.ALLOWED_ORIGIN) return true;
  return env.APP_ENV === 'staging' && !request.headers.has('Origin') &&
    new URL(request.url).origin === env.STAGING_WORKER_ORIGIN;
}

const PROMPTPAY_TYPES = Object.freeze({
  phone_number: { accountType: '02001', pattern: /^0\d{9}$/ },
  citizen_id: { accountType: '02003', pattern: /^\d{13}$/ },
  e_wallet: { accountType: '02004', pattern: /^\d{1,32}$/ }
});

function paymentRolloutAllowed(env, identity) {
  const rollout=String(env.PAYMENT_ROLLOUT||'canary').trim();
  if(rollout==='public') return true;
  if(rollout!=='canary') return false;
  const owner=String(env.ADMIN_OWNER_EMAIL||'').trim().toLowerCase();
  const email=String(identity?.email||'').trim().toLowerCase();
  return Boolean(owner&&email&&email===owner);
}

export function slip2goReceiverConfig(env) {
  const promptPayType=String(env.PAYMENT_RECEIVER_TYPE||'phone_number').trim();
  const rule=PROMPTPAY_TYPES[promptPayType];
  const account=String(env.PAYMENT_RECEIVER_ACCOUNT||'').replace(/\s+/g,'');
  const accountName=String(env.PAYMENT_RECEIVER_NAME||'Lucky Game').trim();
  if(!rule||!rule.pattern.test(account)||accountName.length<2||accountName.length>160)
    throw Error('Payment receiver is not configured');
  return {promptPayType,accountType:rule.accountType,account,accountName};
}

export function buildSlip2GoQrPayload({receiver,price}) {
  if(!receiver||!Number.isSafeInteger(price)||price<1||price>100000)
    throw Error('Invalid payment QR request');
  return {
    promptPayCode:receiver.account,
    promptPayType:receiver.promptPayType,
    accountName:receiver.accountName,
    amount:price.toFixed(2)
  };
}

export async function handlePaymentQr(request, env) {
  if (env.PAYMENT_MODE !== 'slip2go-production') {
    return jsonResponse(request, env, {ok:false,error:'Production payment is disabled'}, 503);
  }
  if (request.method !== 'POST') {
    return jsonResponse(request, env, {ok:false,error:'Method not allowed'}, 405);
  }
  if (await paymentsPaused(env)) {
    return jsonResponse(request, env, {ok:false,error:'Payments are temporarily paused'}, 503);
  }
  if (env.ALLOWED_ORIGIN && request.headers.get('Origin') !== env.ALLOWED_ORIGIN) {
    return jsonResponse(request, env, {ok:false,error:'Origin not allowed'}, 403);
  }
  const match=/^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization')||'');
  if(!match) return jsonResponse(request, env, {ok:false,error:'Sign in required'}, 401);
  let verified;
  try {
    verified=await verifyFirebaseRequestTokens(match[1],request.headers.get('X-Firebase-AppCheck'),env);
  } catch (_) {
    return jsonResponse(request, env, {ok:false,error:'Invalid Firebase token'}, 401);
  }
  if(!paymentRolloutAllowed(env,verified)) {
    return jsonResponse(request,env,{ok:false,error:'Payment canary is restricted'},403);
  }
  let input;
  try { input=await request.json(); }
  catch (_) { return jsonResponse(request,env,{ok:false,error:'Invalid JSON'},400); }
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||
      !Object.hasOwn(input,'item')) {
    return jsonResponse(request,env,{ok:false,error:'Invalid payment QR request'},400);
  }
  const item=String(input.item||'');
  let price;
  try { price=await currentPrice(env,item); }
  catch (_) { return jsonResponse(request,env,{ok:false,error:'Pricing authority unavailable'},503); }
  if(!env.SLIP2GO_API_SECRET) {
    return jsonResponse(request,env,{ok:false,error:'Payment server is not configured'},503);
  }
  let receiver;
  try { receiver=slip2goReceiverConfig(env); }
  catch (_) { return jsonResponse(request,env,{ok:false,error:'Payment server is not configured'},503); }

  let slipResponse;
  try {
    slipResponse=await fetch('https://connect.slip2go.com/api/qr-payment/generate-qr-image-link',{
      method:'POST',
      headers:{'Authorization':`Bearer ${env.SLIP2GO_API_SECRET}`,'Content-Type':'application/json'},
      body:JSON.stringify(buildSlip2GoQrPayload({receiver,price}))
    });
  } catch (_) {
    return jsonResponse(request,env,{ok:false,error:'Payment QR service unavailable'},502);
  }
  let result;
  try { result=await slipResponse.json(); }
  catch (_) { return jsonResponse(request,env,{ok:false,error:'Invalid response from QR service'},502); }
  const providerCode=String(result?.code??'').trim();
  const providerMessage=typeof result?.message==='string' ? result.message.trim().slice(0,160) : '';
  if(!slipResponse.ok||providerCode!=='200') {
    const safeCode=/^\d{3,6}$/.test(providerCode)?providerCode:'unknown';
    return jsonResponse(request,env,{
      ok:false,
      error:'Slip2Go QR error ['+safeCode+']'+(providerMessage?' '+providerMessage:'')
    },502);
  }
  const data=result?.data||{};
  let qr;
  try { qr=new URL(String(data.qrImageLink||'')); }
  catch (_) { return jsonResponse(request,env,{ok:false,error:'Slip2Go QR success response is missing a valid image URL'},502); }
  const returnedAmount=Number(data.amount);
  const returnedName=String(data.accountName||'').trim();
  if(qr.protocol!=='https:'||qr.username||qr.password||
      !Number.isFinite(returnedAmount)||returnedAmount!==price) {
    return jsonResponse(request,env,{ok:false,error:'Slip2Go QR success response failed integrity checks'},502);
  }
  return jsonResponse(request,env,{
    ok:true,item,price,currency:'THB',qrImageUrl:qr.href,
    accountName:returnedName||receiver.accountName
  });
}

export async function handleVerifySlip(request, env) {
  if (env.PAYMENT_MODE !== 'slip2go-production') {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Production payment is disabled'
    }, 503);
  }

  if (await paymentsPaused(env)) {
    return jsonResponse(request, env, { ok:false, error:'Payments are temporarily paused' }, 503);
  }

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
    verified = await verifyFirebaseRequestTokens(match[1], request.headers.get('X-Firebase-AppCheck'), env);
  } catch {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Invalid Firebase token'
    }, 401);
  }

  if (!paymentRolloutAllowed(env, verified)) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Payment canary is restricted'
    }, 403);
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

  let price;
  try { price=await currentPrice(env,item); }
  catch (_) {
    return jsonResponse(request, env, {
      ok: false,
      error: 'Pricing authority unavailable'
    }, 503);
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

  let receiver;
  try { receiver=slip2goReceiverConfig(env); }
  catch (_) {
    return jsonResponse(request,env,{ok:false,error:'Payment server is not configured'},503);
  }

  const payload = {
    checkReceiver: [{
      accountType: receiver.accountType,
      accountNumber: receiver.account
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
          'Authorization': `Bearer ${env.SLIP2GO_API_SECRET}`
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


export async function handleGetEntitlements(request, env) {
  if (!allowedRequestOrigin(request, env)) {
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
    verified = await verifyFirebaseRequestTokens(match[1], request.headers.get('X-Firebase-AppCheck'), env);
  } catch (error) {
    const diagnostic = env.APP_ENV === 'staging' &&
      env.STAGING_WORKER_NAME === 'gpt-voxel-3d-staging-01' &&
      env.TWOC2P_SANDBOX_E2E_TEST_MODE === 'true' &&
      request.headers.get('X-Voxel-Staging-Diagnostic') === 'gate5-auth-stage-v1' &&
      ['app-check', 'active-user'].includes(error?.authStage) ? error.authStage : undefined;
    const diagnosticReason = diagnostic === 'active-user' &&
      /^lookup-(?:http-(?:4\d\d|5\d\d)|transport|invalid-response|identity-mismatch|disabled|invalid-valid-since|revoked)$/.test(error?.authReason)
      ? error.authReason : undefined;
    return jsonResponse(request, env, {
      ok: false,
      error: 'Invalid Firebase token',
      ...(diagnostic ? { diagnosticStage: diagnostic } : {}),
      ...(diagnosticReason ? { diagnosticReason } : {})
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
