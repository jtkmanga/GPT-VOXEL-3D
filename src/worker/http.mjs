import { PAYMENT_PRICES } from '../shared/catalog.mjs';
import { verifyFirebaseIdToken } from './firebase-auth.mjs';

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || origin;

  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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

export async function handleVerifySlip(request, env) {
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

  const prices = PAYMENT_PRICES;

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


export async function handleGetEntitlements(request, env) {
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
