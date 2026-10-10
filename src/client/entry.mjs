// Canonical P1 source assembly manifest.
// Classic fragments deliberately retain shared global scope, callback timing,
// override assignment and startup order. They are build inputs, not standalone
// browser ESM entrypoints. The legacy index.html is generated from this manifest.
import * as config from '../shared/config.mjs';
import * as protocol from '../shared/protocol.mjs';
import * as catalog from '../shared/catalog.mjs';

export { config, protocol, catalog };
export const CLIENT_SOURCES = [
  "./auth-state.js",
  "./audio.js",
  "./firebase-multiplayer.js",
  "./menu-shop.js",
  "./world.js",
  "./controls.js",
  "./wheel-frame.js",
  "./secure-entitlements-payment.js",
  "./secure-snapshots.js",
  "./secure-socket-handoff.js",
  "./secure-menu-economy.js",
  "./secure-wheel-startup.js"
];
