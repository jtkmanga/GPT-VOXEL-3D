import { MOVEMENT, integrateMovement, validMovementInput, validMovementFrames } from '../shared/movement.mjs';
import { SERVER_WORLD } from './world.mjs';

const obstacles = [...SERVER_WORLD.buildings, ...SERVER_WORLD.trees];

export function initializeMotion(player, now = Date.now()) {
  player.motion = { vx: 0, vz: 0, vy: 0, jumpHeld: false, grounded: !(player.y > 0), seq: -1, clock: now, credit: 0 };
  return player.motion;
}

export function publicMovement(player) {
  const motion = player.motion || initializeMotion(player);
  return { vx: motion.vx, vz: motion.vz, vy: motion.vy,
    grounded: motion.grounded, jumpHeld: motion.jumpHeld, lastSeq: motion.seq };
}

export function applyMovementIntent(player, packet, speed, now = Date.now()) {
  if (!validMovementInput(packet?.input) || !Number.isSafeInteger(packet.seq) || packet.seq < 0 ||
      (Object.hasOwn(packet, 'frames') && !validMovementFrames(packet.frames)))
    return false;
  const motion = player.motion || initializeMotion(player, Number(player.at) || now);
  if (packet.seq <= motion.seq) return false;
  const options = { speed, obstacles, bounds: MOVEMENT.bounds };
  let next, credit = 0;
  if (Object.hasOwn(packet, 'frames')) {
    // A clock regression must not move the budget anchor backwards and make
    // the same later wall-time interval spendable a second time.
    if (!Number.isFinite(now) || !Number.isFinite(motion.clock) || now < motion.clock) return false;
    const available = Math.min(MOVEMENT.maxElapsedSeconds,
      Math.max(0, Number(motion.credit) || 0) + Math.max(0, now - motion.clock) / 1000);
    // Network backlog cannot bank unbounded time. Spend only the affordable
    // ordered prefix, then ACK the authoritative result for the whole sequence.
    // Any excess claimed interval is denied, never retained for another packet.
    next = { ...player, ...motion };
    credit = available;
    for (const frame of packet.frames) {
      const elapsed = Math.min(frame.delta, credit);
      next = integrateMovement(next, frame.input, elapsed, options);
      credit = Math.max(0, credit - elapsed);
      if (elapsed + 1e-9 < frame.delta) break;
    }
  } else {
    // The unchanged legacy contract spends wall time directly. Drop retained
    // batch credit so switching formats cannot spend an interval twice.
    next = integrateMovement({ ...player, ...motion }, packet.input,
      Math.max(0, now - motion.clock) / 1000, options);
  }
  Object.assign(player, { x: next.x, y: next.y, z: next.z, r: next.r, at: now, last: now,
    motion: { vx: next.vx, vz: next.vz, vy: next.vy, grounded: next.grounded, jumpHeld: next.jumpHeld,
      seq: packet.seq, clock: now, credit } });
  return true;
}
