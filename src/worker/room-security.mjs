import { WS_MESSAGE } from '../shared/protocol.mjs';
import { parseFrame, SECURITY } from './security.mjs';

// Serialize asynchronous verification and mutation for each connection. The
// durable session generation, rather than a transport or client UID, owns it.
const queues = new WeakMap();
const pendingFrames = new WeakMap();
const owned = result => result === true || result?.ok === true;

export function sessionMetadata(player) {
  return {
    sessionId: player.sessionId,
    resumeToken: player.resumeToken,
    resumeExpiresAt: player.resumeExpiresAt,
    tokenExpiresAt: player.exp * 1000
  };
}

async function handleFrame(room, ws, raw, protocol, dispatch) {
  await room.ready;
  if (ws.readyState !== 1) return;
  let player = room.player(ws);
  if (!player || player.revoked) { ws.close(1008, 'Session unavailable'); return; }
  if (!player.uid && Date.now() >= player.acceptedAt + SECURITY.authDeadlineMs) {
    ws.close(1008, 'Authentication deadline exceeded'); return;
  }
  const parsed = parseFrame(raw, player, protocol);
  if (!parsed.ok) {
    player.schemaFailures = (player.schemaFailures || 0) + 1;
    ws.serializeAttachment(player);
    if (parsed.kind !== 'schema' || player.schemaFailures >= 3) ws.close(parsed.code, parsed.reason);
    return;
  }
  const packet = parsed.packet;
  ws.serializeAttachment(player);
  if (packet.type === WS_MESSAGE.AUTH) {
    await dispatch(packet, player);
    return;
  }
  if (!player.uid || Math.floor(Date.now() / 1000) >= player.exp) {
    ws.close(1008, 'Sign in required'); return;
  }
  const provisional = Boolean(player.handoffResume);
  if (provisional) {
    if (packet.type !== WS_MESSAGE.HANDOFF_RESUME && packet.type !== WS_MESSAGE.HANDOFF_CANCEL) {
      ws.close(1008, 'Handoff acknowledgement required'); return;
    }
  } else if (!owned(await room.sessionCall('validate', {
    uid: player.uid, sessionId: player.sessionId, owner: room.sessionOwner()
  }))) {
    ws.close(1008, 'Session no longer owned'); return;
  }
  // A replacement can revoke this transport while the coordinator RPC awaits.
  player = room.player(ws);
  if (ws.readyState !== 1 || !player || player.revoked || player.sessionClosed) return;
  // Old clients may omit sequence IDs; authored sequences cannot be replayed.
  if (packet.seq !== undefined) {
    if (Number.isSafeInteger(player.lastSequence) && packet.seq <= player.lastSequence) return;
    player.lastSequence = packet.seq;
  }
  if (packet.requestId !== undefined) {
    const key = `${typeof packet.requestId}:${packet.requestId}`;
    player.recentRequests ||= [];
    if (player.recentRequests.includes(key)) return;
    player.recentRequests.push(key);
    if (player.recentRequests.length > 128) player.recentRequests.shift();
  }
  ws.serializeAttachment(player);
  await dispatch(packet, player);
  player = room.player(ws);
  if (ws.readyState !== 1 || !player?.uid || player.revoked || player.handoffResume) return;
  const checkpoint = await room.sessionCall('checkpoint', {
    uid: player.uid, sessionId: player.sessionId, owner: room.sessionOwner(),
    position: { x: player.x, y: player.y, z: player.z, r: player.r }
  });
  if (!owned(checkpoint)) { ws.close(1008, 'Session no longer owned'); return; }
  if (Number.isFinite(checkpoint.resumeExpiresAt)) player.resumeExpiresAt = checkpoint.resumeExpiresAt;
  const now = Date.now();
  if (!Number.isFinite(player.sessionNoticeAt)) player.sessionNoticeAt = now;
  if (now - player.sessionNoticeAt >= 30_000) {
    player.sessionNoticeAt = now;
    room.send(ws, { type: WS_MESSAGE.AUTH_REFRESHED, session: sessionMetadata(player),
      sessionRenewed: true, serverNow: now });
  }
  ws.serializeAttachment(player);
}

export function enqueueFrame(room, ws, raw, protocol, dispatch) {
  if (typeof raw !== 'string') { ws.close(1003, 'Text frames required'); return Promise.resolve(); }
  if (new TextEncoder().encode(raw).byteLength > SECURITY.maxUTF8Bytes) {
    ws.close(1009, 'Frame too large'); return Promise.resolve();
  }
  const pending = pendingFrames.get(ws) || 0;
  if (pending >= 64) { ws.close(1008, 'Pending packet limit exceeded'); return Promise.resolve(); }
  pendingFrames.set(ws, pending + 1);
  const previous = queues.get(ws) || Promise.resolve();
  const current = previous.then(() => handleFrame(room, ws, raw, protocol, dispatch)).catch(() => {
    // Never authorize an in-memory replacement when durable authority fails.
    room.send(ws, { type: WS_MESSAGE.SERVER_ERROR, message: 'Session service unavailable' });
    try { ws.close(1011, 'Session service unavailable'); } catch (_) {}
  });
  queues.set(ws, current);
  return current.finally(() => {
    pendingFrames.set(ws, Math.max(0, (pendingFrames.get(ws) || 1) - 1));
    if (queues.get(ws) === current) queues.delete(ws);
  });
}
