// P1 preserves the existing runtime values and keeps distinct semantics separate.
export const SERVER_MAP_SIZE = 1500;
export const SERVER_WORLD_SEED = 'free1';
export const SERVER_COIN_COUNT = 200;
export const LUCKY_BOX_RESPAWN_MS = 4 * 60 * 60 * 1000;
export const LUCKY_BOX_CLAIM_MS = 90 * 1000;
export const MOVE_TICK_MS = 200;
export const PLAYER_VISIBILITY_RADIUS = 120;
export const ROOM_SOFT_CAP = 160;
export const ZONE_GRID_SIZE = 10;
export const ZONE_SIZE = SERVER_MAP_SIZE / ZONE_GRID_SIZE;
export const ZONE_SOFT_CAP = 120;
export const BORDER_SNAPSHOT_INTERVAL_MS = 500;
export const RESPAWN_MS = 60_000;

// Baseline VIP policy limits active entitlements, not concurrent admission.
export const VIP_ENTITLEMENT_CAP = 100;

// Equal to the visibility radius today, but a different gameplay setting.
export const LUCKY_BOX_MIN_DISTANCE_FROM_SPAWN = 120;
