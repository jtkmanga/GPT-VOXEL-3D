import { MOVEMENT, integrateMovement, validMovementInput } from '../shared/movement.mjs';
import { SERVER_WORLD } from './world.mjs';

const obstacles = [...SERVER_WORLD.buildings, ...SERVER_WORLD.trees];

export function initializeMotion(player, now = Date.now()) {
  player.motion = { vx: 0, vz: 0, vy: 0, jumpHeld: false, grounded: !(player.y > 0), seq: -1, clock: now };
  return player.motion;
}

export function publicMovement(player) {
  const motion = player.motion || initializeMotion(player);
  return { vx: motion.vx, vz: motion.vz, vy: motion.vy,
    grounded: motion.grounded, jumpHeld: motion.jumpHeld, lastSeq: motion.seq };
}

export function applyMovementIntent(player, packet, speed, now = Date.now()) {
  if (!validMovementInput(packet?.input) || !Number.isSafeInteger(packet.seq) || packet.seq < 0)
    return false;
  const motion = player.motion || initializeMotion(player, Number(player.at) || now);
  if (packet.seq <= motion.seq) return false;
  const next = integrateMovement({ ...player, ...motion }, packet.input,
    Math.max(0, now - motion.clock) / 1000, { speed, obstacles, bounds: MOVEMENT.bounds });
  Object.assign(player, { x: next.x, y: next.y, z: next.z, r: next.r, at: now, last: now,
    motion: { vx: next.vx, vz: next.vz, vy: next.vy, grounded: next.grounded, jumpHeld: next.jumpHeld,
      seq: packet.seq, clock: now } });
  return true;
}
