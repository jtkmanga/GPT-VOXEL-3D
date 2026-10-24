import { SERVER_MAP_SIZE, SERVER_WORLD_SEED, SERVER_COIN_COUNT, LUCKY_BOX_MIN_DISTANCE_FROM_SPAWN } from '../shared/config.mjs';
import { LUCKY_REWARDS } from '../shared/catalog.mjs';

export function serverSeededRandom(seedText) {
  let seed = 2166136261;
  const str = String(seedText || 'default-map');
  for (let i = 0; i < str.length; i++) {
    seed ^= str.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  return function() {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildServerCollisionWorld(seedText) {
  const rng = serverSeededRandom(seedText);
  const buildings = [];
  const trees = [];

  for (let bx = -600; bx <= 600; bx += 200) {
    for (let bz = -600; bz <= 600; bz += 200) {
      if (Math.abs(bx) < 100 && Math.abs(bz) < 100) continue;
      const width = 18 + Math.floor(rng() * 20);
      const depth = 18 + Math.floor(rng() * 20);
      28 + Math.floor(rng() * 65); // advance height RNG
      Math.floor(rng() * 3);       // advance material RNG
      const posX = bx + (rng() - 0.5) * 60;
      const posZ = bz + (rng() - 0.5) * 60;
      buildings.push({
        minX: posX - width / 2 - 2,
        maxX: posX + width / 2 + 2,
        minZ: posZ - depth / 2 - 2,
        maxZ: posZ + depth / 2 + 2
      });
    }
  }

  for (let i = 0; i < 250; i++) {
    const tx = (rng() - 0.5) * (SERVER_MAP_SIZE - 50);
    const tz = (rng() - 0.5) * (SERVER_MAP_SIZE - 50);
    const insideBuilding = buildings.some(b => tx >= b.minX && tx <= b.maxX && tz >= b.minZ && tz <= b.maxZ);
    if (insideBuilding || (Math.abs(tx) < 25 && Math.abs(tz) < 25)) continue;
    6 + rng() * 4; // advance trunkHeight RNG
    6 + rng() * 3; // advance leafSize RNG
    trees.push({
      minX: tx - 1.8,
      maxX: tx + 1.8,
      minZ: tz - 1.8,
      maxZ: tz + 1.8
    });
  }

  return { buildings, trees };
}

export const SERVER_WORLD = buildServerCollisionWorld(SERVER_WORLD_SEED);

export function safeWorldPosition(seedText, minDistanceFromSpawn = 0, margin = 12) {
  const rng = serverSeededRandom(seedText);
  let rx = 0, rz = 0;
  for (let attempt = 0; attempt < 2000; attempt++) {
    rx = (rng() - 0.5) * (SERVER_MAP_SIZE - margin);
    rz = (rng() - 0.5) * (SERVER_MAP_SIZE - margin);
    if (minDistanceFromSpawn > 0 && Math.hypot(rx, rz) < minDistanceFromSpawn) continue;
    const collision =
      SERVER_WORLD.buildings.some(b => rx >= b.minX && rx <= b.maxX && rz >= b.minZ && rz <= b.maxZ) ||
      SERVER_WORLD.trees.some(t => rx >= t.minX && rx <= t.maxX && rz >= t.minZ && rz <= t.maxZ);
    if (!collision) return { x: rx, z: rz };
  }
  return { x: minDistanceFromSpawn + 50, z: 0 };
}

export function coinPosition(id, cycle = 0) {
  return safeWorldPosition(`${SERVER_WORLD_SEED}:coin:${Number(id) || 0}:cycle:${Number(cycle) || 0}`, 0, 12);
}

export const COINS = Array.from({length:SERVER_COIN_COUNT}, (_,id) => {
  const pos = coinPosition(id, 0);
  return [pos.x, pos.z];
});

export function luckyBoxPosition(cycle = 0) {
  return safeWorldPosition(`${SERVER_WORLD_SEED}:position:lucky-box-${Number(cycle) || 0}`, LUCKY_BOX_MIN_DISTANCE_FROM_SPAWN, 20);
}

export function secureLuckyReward() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  const roll = (a[0] / 4294967296) * 100;
  if (roll < LUCKY_REWARDS[0].upperBound) return LUCKY_REWARDS[0].value;      // 50.0%
  if (roll < LUCKY_REWARDS[1].upperBound) return LUCKY_REWARDS[1].value;      // 30.0%
  if (roll < LUCKY_REWARDS[2].upperBound) return LUCKY_REWARDS[2].value;     // 19.0%
  if (roll < LUCKY_REWARDS[3].upperBound) return LUCKY_REWARDS[3].value;   // 0.9%
  return LUCKY_REWARDS[4].value;                    // 0.1%
}
