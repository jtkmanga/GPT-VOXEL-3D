import { corsHeaders, jsonResponse, handlePaymentQr, handleVerifySlip, handleGetEntitlements, handlePaymentWebhook } from './http.mjs';
import { normalizeZoneId } from './spatial.mjs';
import { stagingContext, stagingError, stagingAsset } from './staging-boundary.mjs';
import { handle2c2pSandbox } from './twoc2p-sandbox.mjs';
import { handleAdmin, publicSiteConfig } from './admin.mjs';
import { isBangkokSunday } from './score-reset.mjs';

async function liveControls(env) {
  try {
    const response=await env.ROOM.getByName('free-v2-demo').fetch(new Request('https://internal/_internal/admin/runtime-controls'));
    const data=await response.json();
    return response.ok&&data?.ok?data:{};
  } catch (_) { return {}; }
}

const worker = {
  async scheduled(controller,env,ctx) {
    const at=Number(controller?.scheduledTime)||Date.now();
    const free=env.ROOM.getByName('free-v2-demo');
    const vip=env.ROOM.getByName('vip1-v2-demo');
    const tasks=[];
    if (isBangkokSunday(at)) {
      tasks.push(free.fetch(new Request('https://internal/_internal/admin/scheduled-score-reset',{method:'POST'})));
    }
    tasks.push((async()=>{
      const configured=await vip.fetch(new Request('https://internal/_internal/configure-scope',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:'vip1'})
      }));
      if (!configured.ok) throw Error('VIP score reset scope unavailable');
      const reset=await vip.fetch(new Request('https://internal/_internal/admin/scheduled-score-reset',{method:'POST'}));
      if (!reset.ok) throw Error('VIP score reset unavailable');
    })());
    const work=Promise.all(tasks);
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work;
  },
  async fetch(request,env) {
    const url=new URL(request.url);
    const staging=stagingContext(request,env);
    if (staging.error) return stagingError(staging);

    if (url.pathname==='/site-config' && request.method==='GET') return publicSiteConfig(env);

    // Same-origin proxy required by Firebase Auth redirect flows on browsers that
    // block third-party storage. Keep the browser on this Worker origin while
    // serving Firebase's auth helper resources transparently.
    if (url.pathname.startsWith('/__/auth/')) {
      const project=String(env?.FIREBASE_PROJECT_ID||'').trim();
      if (!project) return new Response('Firebase auth unavailable',{status:503});
      const upstream=new URL(request.url);
      upstream.protocol='https:';
      upstream.hostname=project+'.firebaseapp.com';
      upstream.port='';
      const proxied=new Request(upstream.toString(),request);
      const response=await fetch(proxied);
      const headers=new Headers(response.headers);
      headers.set('cache-control','no-store');
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    }

    if (url.pathname.startsWith('/payments/2c2p/')) return handle2c2pSandbox(request,env);

    if (url.pathname==='/admin' || url.pathname.startsWith('/admin/api/')) return handleAdmin(request,env);

    if (staging.enabled && url.pathname==='/staging-config') {
      if (request.method!=='GET') return new Response('Method not allowed',{status:405});
      return Response.json(staging.config,{headers:{'Cache-Control':'no-store'}});
    }

    if (url.pathname==='/payments/webhook') return handlePaymentWebhook(request,env);

    if (url.pathname==='/health')
      return new Response(staging.enabled ? 'GPT-VOXEL-3D staging online' : 'VOXEL RUN v4 online',
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

    if (url.pathname==='/payment-qr') {
      if (staging.enabled) return Response.json({ok:false,error:'Real payments disabled in staging'},{status:503});
      if (request.method==='OPTIONS') return new Response(null,{status:204,headers:corsHeaders(request,env)});
      if (request.method!=='POST') return jsonResponse(request,env,{ok:false,error:'Method not allowed'},405);
      return handlePaymentQr(request,env);
    }

    if (url.pathname==='/verify-slip') {
      if (staging.enabled) return Response.json({ok:false,error:'Real payment verification is disabled in staging'},
        {status:503,headers:{'Cache-Control':'no-store'}});
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

    if (staging.enabled && !['/play','/entitlements','/payments/webhook','/verify-slip','/health','/staging-config'].includes(url.pathname)) {
      if (url.pathname.startsWith('/_internal') || request.headers.get('Upgrade')?.toLowerCase()==='websocket')
        return new Response('Not found',{status:404});
      return stagingAsset(request,env);
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

    const requestedServer = url.searchParams.get('server');
    if (requestedServer !== null && !['free1','vip1'].includes(requestedServer))
      return new Response('Invalid server',{status:400});
    const controls=await liveControls(env);
    if ((requestedServer==='vip1' && (controls.maintenanceVip || controls.vipAdmissionPaused)) ||
        ((requestedServer===null || requestedServer==='free1') && controls.maintenanceFree))
      return new Response('Server temporarily unavailable',{status:503});
    if (requestedServer==='vip1') {
      if (url.searchParams.has('zone')) return new Response('VIP has no zone route',{status:400});
      const room=env.ROOM.getByName('vip1-v2-demo');
      const configured=await room.fetch(new Request('https://internal/_internal/configure-scope',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:'vip1'})
      }));
      if (!configured.ok) return new Response('VIP authority unavailable',{status:503});
      return room.fetch(request);
    }

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

export default worker;
