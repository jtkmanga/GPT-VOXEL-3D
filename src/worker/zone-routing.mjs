import { PLAYER_VISIBILITY_RADIUS, SERVER_MAP_SIZE, ZONE_SIZE } from '../shared/config.mjs';
import { normalizeZoneId } from './spatial.mjs';

// Broad-phase routing only. Recipients still apply the exact circle test.
export function playerCanReachZone(player, zoneId, radius=PLAYER_VISIBILITY_RADIUS) {
  const normalized=normalizeZoneId(zoneId);
  const x=Number(player?.x),z=Number(player?.z);
  if (!normalized || ![x,z,radius].every(Number.isFinite) || radius<0) return false;
  const [zx,zz]=normalized.split(',').map(Number);
  const minX=-SERVER_MAP_SIZE/2+zx*ZONE_SIZE;
  const minZ=-SERVER_MAP_SIZE/2+zz*ZONE_SIZE;
  const dx=x-Math.max(minX,Math.min(minX+ZONE_SIZE,x));
  const dz=z-Math.max(minZ,Math.min(minZ+ZONE_SIZE,z));
  return dx*dx+dz*dz<=radius*radius;
}

export function nearbyPublicPlayers(players, observer, radius=PLAYER_VISIBILITY_RADIUS) {
  const x=Number(observer?.x),z=Number(observer?.z);
  if (![x,z,radius].every(Number.isFinite) || radius<0) return [];
  return players.filter(player=>player.id!==observer.id &&
    (Number(player.x)-x)**2+(Number(player.z)-z)**2<=radius*radius);
}
