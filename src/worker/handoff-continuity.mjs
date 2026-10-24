import { MOVEMENT } from '../shared/movement.mjs';

// Only the source Durable Object can author this state. It is never accepted
// from a browser AUTH, MOVE or resume packet.
export function handoffMotion(value) {
  if (!value || typeof value !== 'object' ||
      !['vx','vz','vy','clock','credit'].every(key => Number.isFinite(value[key])) ||
      Math.hypot(value.vx,value.vz)>MOVEMENT.entitledSpeed+1e-6 ||
      Math.abs(value.vy)>128 || typeof value.grounded!=='boolean' ||
      typeof value.jumpHeld!=='boolean' || !Number.isSafeInteger(value.seq) || value.seq<0 ||
      value.clock<=0 || value.credit<0 || value.credit>MOVEMENT.maxElapsedSeconds+1e-9)
    throw Error('Invalid authoritative handoff motion');
  return Object.fromEntries(['vx','vz','vy','grounded','jumpHeld','seq','clock','credit']
    .map(key=>[key,value[key]]));
}

export function handoffPosition(value) {
  if (!value || !['x','y','z','r'].every(key=>Number.isFinite(value[key])) ||
      Math.abs(value.x)>MOVEMENT.bounds || Math.abs(value.z)>MOVEMENT.bounds ||
      value.y<0 || value.y>8 || Math.abs(value.r)>10000)
    throw Error('Invalid authoritative handoff position');
  return Object.fromEntries(['x','y','z','r'].map(key=>[key,value[key]]));
}
