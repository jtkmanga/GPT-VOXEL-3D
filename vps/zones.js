const MAP_SIZE = 1500;
const ZONE_GRID_SIZE = 10;
const ZONE_SIZE = MAP_SIZE / ZONE_GRID_SIZE;
const HALF_MAP = MAP_SIZE / 2;

function normalizeZoneId(value) {
  const match =
    /^(\d{1,2}),(\d{1,2})$/.exec(String(value || ''));

  if (!match) return null;

  const x = Number(match[1]);
  const z = Number(match[2]);

  if (
    !Number.isInteger(x) ||
    !Number.isInteger(z) ||
    x < 0 ||
    z < 0 ||
    x >= ZONE_GRID_SIZE ||
    z >= ZONE_GRID_SIZE
  ) {
    return null;
  }

  return `${x},${z}`;
}

function zoneFromPosition(x, z) {
  x = Number(x);
  z = Number(z);

  if (
    !Number.isFinite(x) ||
    !Number.isFinite(z) ||
    x < -HALF_MAP ||
    x > HALF_MAP ||
    z < -HALF_MAP ||
    z > HALF_MAP
  ) {
    return null;
  }

  const zoneX = Math.min(
    ZONE_GRID_SIZE - 1,
    Math.max(
      0,
      Math.floor((x + HALF_MAP) / ZONE_SIZE)
    )
  );

  const zoneZ = Math.min(
    ZONE_GRID_SIZE - 1,
    Math.max(
      0,
      Math.floor((z + HALF_MAP) / ZONE_SIZE)
    )
  );

  return `${zoneX},${zoneZ}`;
}

function neighboringZones(zoneId, radius = 1) {
  const normalized = normalizeZoneId(zoneId);

  if (!normalized) return [];

  const [cx, cz] =
    normalized.split(',').map(Number);

  const result = [];

  for (
    let x = cx - radius;
    x <= cx + radius;
    x++
  ) {
    for (
      let z = cz - radius;
      z <= cz + radius;
      z++
    ) {
      if (
        x < 0 ||
        z < 0 ||
        x >= ZONE_GRID_SIZE ||
        z >= ZONE_GRID_SIZE
      ) {
        continue;
      }

      result.push(`${x},${z}`);
    }
  }

  return result;
}

module.exports = {
  MAP_SIZE,
  ZONE_GRID_SIZE,
  ZONE_SIZE,
  normalizeZoneId,
  zoneFromPosition,
  neighboringZones
};
