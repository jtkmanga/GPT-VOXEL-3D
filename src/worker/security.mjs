import { WS_MESSAGE } from '../shared/protocol.mjs';
import { SERVER_COIN_COUNT } from '../shared/config.mjs';
import { validMovementInput, validMovementFrames } from '../shared/movement.mjs';

// Limits apply to individual sockets and use only server time. The mutable
// bucket state lives in the Durable Object WebSocket attachment so hibernation
// cannot reset a socket's allowance.
export const SECURITY = {
  authDeadlineMs: 10_000,
  authCapacity: 3,
  authRefillMs: 10_000,
  packetCapacity: 40,
  packetRefillPerSecond: 20,
  maxUTF8Bytes: 8192
};

const incomingFields = new Map([
  [WS_MESSAGE.AUTH, ['token', 'name', 'protocol', 'handoffToken', 'resumeToken', 'seq', 'continuousHandoff']],
  [WS_MESSAGE.MOVE, ['input', 'frames', 'protocol', 'seq']],
  [WS_MESSAGE.COLLECT, ['id', 'x', 'y', 'z', 'r', 'protocol', 'seq']],
  [WS_MESSAGE.COLLECT_BOX, ['protocol', 'seq']],
  [WS_MESSAGE.SPIN_BOX, ['protocol', 'seq']],
  [WS_MESSAGE.HANDOFF_RESUME, ['input', 'x', 'y', 'z', 'r', 'protocol', 'seq']],
  [WS_MESSAGE.HANDOFF_CANCEL, ['protocol', 'seq']]
]);
const positionFields = ['x', 'y', 'z', 'r'];
const serverOwnedFields = new Set(['uid', 'userId', 'entitlement', 'entitlements', 'vipExpires',
  'speedExpires', 'coinExpires', 'score', 'reward', 'coins', '__proto__', 'constructor', 'prototype']);
const authDeadlines = new WeakMap();

function failure(reason, kind = 'schema', code = 1008) {
  return { ok: false, reason, kind, code };
}

function takeToken(state, prefix, capacity, refillPerMs, now) {
  const atKey = `${prefix}RefillAt`, tokensKey = `${prefix}Tokens`;
  const previousAt = Number.isFinite(state[atKey]) ? state[atKey] : now;
  const previousTokens = Number.isFinite(state[tokensKey]) ? state[tokensKey] : capacity;
  const tokens = Math.min(capacity, Math.max(0, previousTokens) + Math.max(0, now - previousAt) * refillPerMs);
  state[atKey] = now;
  state[tokensKey] = tokens >= 1 ? tokens - 1 : tokens;
  return tokens >= 1;
}

function validRequestId(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)) ||
    (Number.isSafeInteger(value) && value >= 0);
}

function validPosition(packet, required) {
  const present = positionFields.filter(key => Object.hasOwn(packet, key));
  if (!present.length) return !required;
  if (present.length !== positionFields.length || !present.every(key => Number.isFinite(packet[key]))) return false;
  return Math.abs(packet.x) <= 748 && Math.abs(packet.z) <= 748 &&
    packet.y >= -.25 && packet.y <= 8 && Math.abs(packet.r) <= 10_000;
}

export function parseFrame(message, attachment, expectedProtocol) {
  if (!attachment || typeof attachment !== 'object') return failure('Socket state unavailable');
  if (!attachment.security || typeof attachment.security !== 'object') attachment.security = {};
  const now = Date.now();
  if (!takeToken(attachment.security, 'packet', SECURITY.packetCapacity, SECURITY.packetRefillPerSecond / 1000, now)) {
    return failure('Packet rate limit exceeded', 'packet_rate');
  }
  if (typeof message !== 'string') return failure('Text frames required', 'binary', 1003);
  if (new TextEncoder().encode(message).byteLength > SECURITY.maxUTF8Bytes) {
    return failure('Frame too large', 'oversized', 1009);
  }
  let packet;
  try { packet = JSON.parse(message); }
  catch (_) { return failure('Malformed JSON', 'malformed'); }
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return failure('Object packet required', 'malformed');
  if (typeof packet.type !== 'string' || !incomingFields.has(packet.type)) return failure('Unknown message type', 'protocol');
  const allowed = incomingFields.get(packet.type);
  if (Object.keys(packet).some(key => serverOwnedFields.has(key))) return failure('Server-owned packet field', 'authority');
  if (Object.keys(packet).some(key => key !== 'type' && key !== 'requestId' && !allowed.includes(key))) {
    return failure('Unknown or server-owned packet field');
  }
  if (Object.hasOwn(packet, 'protocol') && packet.protocol !== expectedProtocol) return failure('Incompatible protocol', 'protocol');
  if (Object.hasOwn(packet, 'seq') && (!Number.isSafeInteger(packet.seq) || packet.seq < 0)) return failure('Invalid sequence');
  if (Object.hasOwn(packet, 'requestId') && !validRequestId(packet.requestId)) return failure('Invalid request identifier');

  if (packet.type === WS_MESSAGE.AUTH) {
    if (!takeToken(attachment.security, 'auth', SECURITY.authCapacity, SECURITY.authCapacity / SECURITY.authRefillMs, now)) {
      return failure('Authentication rate limit exceeded', 'auth_rate');
    }
    if (typeof packet.token !== 'string' || !packet.token || packet.token.length > 8192) return failure('Invalid token field');
    if (Object.hasOwn(packet, 'name') && (typeof packet.name !== 'string' || packet.name.length > 64)) return failure('Invalid name');
    if (Object.hasOwn(packet, 'handoffToken') &&
        (typeof packet.handoffToken !== 'string' || !packet.handoffToken || packet.handoffToken.length > 256)) return failure('Invalid handoff token');
    if (Object.hasOwn(packet, 'resumeToken') &&
        (typeof packet.resumeToken !== 'string' || !packet.resumeToken || packet.resumeToken.length > 128)) return failure('Invalid resume token');
    if (Object.hasOwn(packet, 'continuousHandoff') && typeof packet.continuousHandoff !== 'boolean')
      return failure('Invalid handoff mode');
  } else if (packet.type === WS_MESSAGE.MOVE) {
    if (!Number.isSafeInteger(packet.seq) || packet.seq < 0 || !validMovementInput(packet.input) ||
        (Object.hasOwn(packet, 'frames') && !validMovementFrames(packet.frames)))
      return failure('Invalid movement intent');
  } else if (packet.type === WS_MESSAGE.HANDOFF_RESUME) {
    if (!validPosition(packet, false) ||
        (Object.hasOwn(packet, 'input') && !validMovementInput(packet.input)))
      return failure('Invalid handoff hint');
  } else if (packet.type === WS_MESSAGE.COLLECT) {
    if (!Number.isInteger(packet.id) || packet.id < 0 || packet.id >= SERVER_COIN_COUNT) return failure('Invalid coin identifier');
    if (!validPosition(packet, false)) return failure('Invalid collection position');
  }
  return { ok: true, packet };
}

export function clearAuthDeadline(ws) {
  const timer = authDeadlines.get(ws);
  if (timer !== undefined) clearTimeout(timer);
  authDeadlines.delete(ws);
}

export function scheduleAuthDeadline(room, ws) {
  clearAuthDeadline(ws);
  const player = room.player(ws);
  if (!player || player.uid) return;
  const acceptedAt = Number.isFinite(player.acceptedAt) ? player.acceptedAt : Date.now();
  const delay = Math.max(0, acceptedAt + SECURITY.authDeadlineMs - Date.now());
  const timer = setTimeout(() => {
    authDeadlines.delete(ws);
    // A token verifier completing after the deadline cannot revive a socket;
    // the room also checks readyState and acceptedAt before accepting auth.
    try {
      const current = room.player(ws);
      if (current && !current.uid) ws.close(1008, 'Authentication deadline exceeded');
    } catch (_) { /* Already-closed sockets have no authenticated session. */ }
  }, delay);
  timer?.unref?.();
  authDeadlines.set(ws, timer);
}
