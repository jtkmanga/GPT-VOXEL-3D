// Shared deterministic prediction kernel. The Worker selects elapsed time,
// speed entitlement and world geometry; packets contain intent only.
export const MOVEMENT = {
  speed: 22,
  entitledSpeed: 44,
  groundAcceleration: 18,
  airAcceleration: 10,
  gravity: 42,
  jumpVelocity: 16,
  bounds: 748,
  maxElapsedSeconds: .5,
  stepSeconds: 1 / 60
};

export function validMovementInput(input) {
  return Boolean(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).length === 3 && Object.hasOwn(input, 'x') &&
    Object.hasOwn(input, 'z') && Object.hasOwn(input, 'jump') &&
    Number.isFinite(input.x) && Number.isFinite(input.z) &&
    Math.abs(input.x) <= 1 && Math.abs(input.z) <= 1 &&
    Math.hypot(input.x, input.z) <= 1 + 1e-9 && typeof input.jump === 'boolean');
}

function sweepAxis(start, end, other, axis, obstacles) {
  const min = axis === 'x' ? 'minX' : 'minZ';
  const max = axis === 'x' ? 'maxX' : 'maxZ';
  const otherMin = axis === 'x' ? 'minZ' : 'minX';
  const otherMax = axis === 'x' ? 'maxZ' : 'maxX';
  let result = end;
  for (const box of obstacles) {
    if (other <= box[otherMin] || other >= box[otherMax]) continue;
    // Continuous segment intersection also catches thin obstacles. Contacts
    // stop just outside the inflated geometry, permitting sliding on walls.
    if (end > start && start <= box[min] && result >= box[min]) {
      result = Math.min(result, box[min] - 1e-7);
    } else if (end < start && start >= box[max] && result <= box[max]) {
      result = Math.max(result, box[max] + 1e-7);
    } else if (start > box[min] && start < box[max] && end > box[min] && end < box[max]) {
      // An upgraded/spawned state inside geometry may leave, never move deeper.
      const midpoint = (box[min] + box[max]) / 2;
      if ((start <= midpoint && end > start) || (start > midpoint && end < start)) result = start;
    }
  }
  return result;
}

export function integrateMovement(state, input, elapsedSeconds, options = {}) {
  if (!validMovementInput(input)) throw new TypeError('Invalid movement intent');
  const result = {
    x: Number.isFinite(state?.x) ? state.x : 0,
    y: Number.isFinite(state?.y) ? Math.max(0, state.y) : 0,
    z: Number.isFinite(state?.z) ? state.z : 0,
    r: Number.isFinite(state?.r) ? state.r : 0,
    vx: Number.isFinite(state?.vx) ? state.vx : 0,
    vz: Number.isFinite(state?.vz) ? state.vz : 0,
    vy: Number.isFinite(state?.vy) ? state.vy : 0,
    jumpHeld: state?.jumpHeld === true,
    grounded: typeof state?.grounded === 'boolean' ? state.grounded : !(state?.y > 0)
  };
  const elapsed = Math.min(MOVEMENT.maxElapsedSeconds,
    Math.max(0, Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0));
  const speed = Number.isFinite(options.speed) && options.speed >= 0 ? options.speed : MOVEMENT.speed;
  const bounds = Number.isFinite(options.bounds) && options.bounds > 0 ? options.bounds : MOVEMENT.bounds;
  const obstacles = Array.isArray(options.obstacles) ? options.obstacles : [];
  if (input.jump && !result.jumpHeld && result.grounded) {
    result.vy = MOVEMENT.jumpVelocity;
    result.grounded = false;
  }
  result.jumpHeld = input.jump;
  if (!elapsed) return result;
  const steps = Math.max(1, Math.ceil(elapsed / MOVEMENT.stepSeconds));
  const delta = elapsed / steps;
  for (let step = 0; step < steps; step++) {
    const acceleration = result.grounded ? MOVEMENT.groundAcceleration : MOVEMENT.airAcceleration;
    const damping = Math.min(1, acceleration * delta);
    result.vx += (input.x * speed - result.vx) * damping;
    result.vz += (input.z * speed - result.vz) * damping;
    const candidateX = Math.min(bounds, Math.max(-bounds, result.x + result.vx * delta));
    const x = sweepAxis(result.x, candidateX, result.z, 'x', obstacles);
    if (Math.abs(x - (result.x + result.vx * delta)) > 1e-9) result.vx = 0;
    result.x = x;
    const candidateZ = Math.min(bounds, Math.max(-bounds, result.z + result.vz * delta));
    const z = sweepAxis(result.z, candidateZ, result.x, 'z', obstacles);
    if (Math.abs(z - (result.z + result.vz * delta)) > 1e-9) result.vz = 0;
    result.z = z;
    if (Math.hypot(result.vx, result.vz) > .5) {
      let difference = Math.atan2(result.vx, result.vz) - result.r;
      while (difference < -Math.PI) difference += Math.PI * 2;
      while (difference > Math.PI) difference -= Math.PI * 2;
      result.r += difference * Math.min(1, MOVEMENT.groundAcceleration * delta);
    }
    if (!result.grounded) {
      result.y += result.vy * delta;
      result.vy -= MOVEMENT.gravity * delta;
      if (result.y <= 0) {
        result.y = 0;
        result.vy = 0;
        result.grounded = true;
      }
    }
  }
  return result;
}
