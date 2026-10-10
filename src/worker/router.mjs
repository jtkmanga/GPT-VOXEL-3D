import { corsHeaders, jsonResponse, handleVerifySlip, handleGetEntitlements } from './http.mjs';
import { normalizeZoneId } from './spatial.mjs';

const worker = {
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

export default worker;
