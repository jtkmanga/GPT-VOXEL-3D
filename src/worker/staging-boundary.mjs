import { validateStagingPublicConfig } from '../shared/staging.mjs';

// Staging selection is an explicit trusted deployment binding. A typo, missing
// setting or crossover never falls back to the preserved legacy deployment.
export function stagingContext(request, env) {
  const stagingSelectors = ['STAGING_WORKER_NAME', 'STAGING_WORKER_ORIGIN', 'STAGING_AUTH_MODE'];
  const stagingHost = new URL(request.url).hostname.startsWith('gpt-voxel-3d-staging');
  const explicitlyStaging = env.APP_ENV === 'staging' || stagingHost ||
    stagingSelectors.some(key => env[key] !== undefined);
  // FIREBASE_PUBLIC_CONFIG and FIREBASE_APP_CHECK_SITE_KEY are shared by both
  // staging and production Admin/Auth. Their presence alone must never switch a
  // production Worker into the staging boundary.
  if (!explicitlyStaging) return { enabled: false };
  try {
    if (env.APP_ENV !== 'staging' || env.PAYMENT_MODE !== 'provider-neutral-test' ||
        typeof env.FIREBASE_PUBLIC_CONFIG !== 'string' || env.FIREBASE_PUBLIC_CONFIG.length > 8192)
      throw Error('Invalid staging configuration');
    const url = new URL(request.url);
    const config = validateStagingPublicConfig({
      environment: 'staging', workerName: env.STAGING_WORKER_NAME,
      workerOrigin: env.STAGING_WORKER_ORIGIN,
      firebase: JSON.parse(env.FIREBASE_PUBLIC_CONFIG),
      appCheck: { provider: 'recaptcha-enterprise', siteKey: env.FIREBASE_APP_CHECK_SITE_KEY },
      authMode: env.STAGING_AUTH_MODE
    }, { allowTest: url.hostname.endsWith('.invalid') });
    if (config.workerOrigin !== url.origin || env.ALLOWED_ORIGIN !== config.workerOrigin ||
        env.FIREBASE_PROJECT_ID !== config.firebase.projectId ||
        !env.ROOM || !env.ZONE)
      throw Error('Invalid staging configuration');
    const origin = request.headers.get('Origin');
    const publicProbe = request.method === 'GET' &&
      ['/health', '/staging-config'].includes(url.pathname);
    // 2C2P's browser return is navigation only, never payment evidence. Allow
    // this exact GET path through the staging Origin fence so the dedicated
    // payment handler can redirect back to the app, where authenticated status
    // reconciliation verifies server-owned state. Backend notifications remain
    // signature-verified and all other payment routes keep the normal fence.
    const paymentReturnNavigation = ['GET', 'POST'].includes(request.method) &&
      url.pathname === '/payments/2c2p/return';
    if (!publicProbe && !paymentReturnNavigation && origin !== null && origin !== config.workerOrigin)
      return { enabled: true, status: 403, error: 'Origin not allowed' };
    return { enabled: true, config };
  } catch (_) {
    // Never echo a binding, raw input, verifier error or secret in HTTP/logs.
    return { enabled: true, status: 503, error: 'Staging configuration unavailable' };
  }
}

export function stagingError(context) {
  return Response.json({ ok: false, error: context.error }, {
    status: context.status, headers: { 'Cache-Control': 'no-store' }
  });
}

export async function stagingAsset(request, env) {
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response('Method not allowed', { status: 405 });
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function')
    return new Response('Staging client unavailable', { status: 503 });
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  // Public configuration changes must not leave a stale project/origin cached
  // after reload. Credentials remain in the Firebase SDK, never asset contents.
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, headers });
}
