import { SERVER_MAP_SIZE, ZONE_GRID_SIZE, ZONE_SIZE, PLAYER_VISIBILITY_RADIUS } from '../shared/config.mjs';

export function normalizePlayerName(value, fallback='Player') {
  let name=String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g,'')
    .replace(/\s+/g,' ')
    .trim();
  if (!name) name=String(fallback || 'Player').trim() || 'Player';
  return [...name].slice(0,12).join('');
}

export function normalizeZoneId(value) {
  const m = /^(\d{1,2}),(\d{1,2})$/.exec(String(value || ''));
  if (!m) return null;

  const zx = Number(m[1]);
  const zz = Number(m[2]);

  if (
    !Number.isInteger(zx) ||
    !Number.isInteger(zz) ||
    zx < 0 ||
    zz < 0 ||
    zx >= ZONE_GRID_SIZE ||
    zz >= ZONE_GRID_SIZE
  ) return null;

  return `${zx},${zz}`;
}

export function zoneCenter(zoneId) {
  const normalized = normalizeZoneId(zoneId);
  if (!normalized) return null;
  const [zx,zz] = normalized.split(',').map(Number);
  const min = -SERVER_MAP_SIZE / 2;
  return {
    x: min + zx * ZONE_SIZE + ZONE_SIZE / 2,
    z: min + zz * ZONE_SIZE + ZONE_SIZE / 2
  };
}

export function zoneFromPosition(x,z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const half = SERVER_MAP_SIZE / 2;
  if (x < -half || x >= half || z < -half || z >= half) return null;
  const zx = Math.min(ZONE_GRID_SIZE - 1, Math.max(0, Math.floor((x + half) / ZONE_SIZE)));
  const zz = Math.min(ZONE_GRID_SIZE - 1, Math.max(0, Math.floor((z + half) / ZONE_SIZE)));
  return `${zx},${zz}`;
}


export function zoneIdsNearPosition(x,z,radius=PLAYER_VISIBILITY_RADIUS) {
  if (![x,z,radius].every(Number.isFinite)) return [];
  const half=SERVER_MAP_SIZE/2;
  const clamp=(v,min,max)=>Math.min(max,Math.max(min,v));
  const minX=clamp(x-radius,-half,half-0.0001);
  const maxX=clamp(x+radius,-half,half-0.0001);
  const minZ=clamp(z-radius,-half,half-0.0001);
  const maxZ=clamp(z+radius,-half,half-0.0001);
  const toIndex=v=>Math.min(ZONE_GRID_SIZE-1,Math.max(0,Math.floor((v+half)/ZONE_SIZE)));
  const x0=toIndex(minX), x1=toIndex(maxX), z0=toIndex(minZ), z1=toIndex(maxZ);
  const out=[];
  for(let zz=z0;zz<=z1;zz++) for(let xx=x0;xx<=x1;xx++) out.push(`${xx},${zz}`);
  return out;
}

export function allZoneIds() {
  const out=[];
  for(let zz=0;zz<ZONE_GRID_SIZE;zz++) for(let xx=0;xx<ZONE_GRID_SIZE;xx++) out.push(`${xx},${zz}`);
  return out;
}

export function zonesAreAdjacent(a,b) {
  const aa=normalizeZoneId(a), bb=normalizeZoneId(b);
  if(!aa || !bb || aa===bb) return false;
  const [ax,az]=aa.split(',').map(Number);
  const [bx,bz]=bb.split(',').map(Number);
  return Math.abs(ax-bx)<=1 && Math.abs(az-bz)<=1;
}


export function adjacentZoneIds(zoneId) {
  const normalized=normalizeZoneId(zoneId);
  if(!normalized) return [];
  const [zx,zz]=normalized.split(',').map(Number);
  const out=[];
  for(let dz=-1;dz<=1;dz++) {
    for(let dx=-1;dx<=1;dx++) {
      if(dx===0 && dz===0) continue;
      const nx=zx+dx, nz=zz+dz;
      if(nx<0 || nz<0 || nx>=ZONE_GRID_SIZE || nz>=ZONE_GRID_SIZE) continue;
      out.push(`${nx},${nz}`);
    }
  }
  return out;
}
