// VOXEL RUN v4 — Firebase Google identity + server-owned coins + persistent leaderboard.
// Scores live in the game's Durable Object, separate from Firebase Realtime Database.
// WORLD_LUCKYBOX_V2_PATCH
// FREE_10K_PHASE1
// Phase 1: reduce movement traffic and only fan out nearby player movement.
// This is the safe foundation before spatial zone sharding in Phase 2.
// FREE_10K_PHASE2A
// Phase 2A: additive movement-zone sharding.
// Existing /play without ?zone= stays on the already-tested Phase 1 room.
// FREE_10K_PHASE2B1
// B1: secure zone handoff tickets + global coin/Lucky Box actions.
// FREE_10K_PHASE2B2
// B2: cross-zone border visibility via throttled zone snapshots.
// FREE_10K_PHASE2C1_1_SMOOTH_HANDOFF
// Smooth handoff: client may keep moving locally while target Zone connects;
// target validates one authoritative handoff_resume before normal movement resumes.
// FREE_10K_PHASE2C2_MULTIPLAYER_FIX
// Fixes: chosen player names + global leaderboard, more reliable multiplayer handoff,
// and low-latency server-authoritative coin collection.

// P1 compatibility entrypoint: source modules preserve the original contracts.
import worker from './src/worker/router.mjs';

export { GameRoom } from './src/worker/game-room.mjs';
export { ZoneRoom } from './src/worker/zone-room.mjs';
export { verifyFirebaseIdToken } from './src/worker/firebase-auth.mjs';
export default worker;
