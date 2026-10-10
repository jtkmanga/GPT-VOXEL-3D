# P1 source structure

This is a new rebuild from P0 commit
`0acbdf43a94c9c228e07957cf2828c1c99a6e83a`, originally based on
`main@f98aa9a044616b1b965b889cf0c02a0d3b041f65`. It does not represent
recovered original P0–P3 source. P1 changes source organization only.

## Source ownership

| Path | Responsibility |
| --- | --- |
| `src/shared/config.mjs` | Existing world, coin, box, timing, visibility and capacity settings |
| `src/shared/protocol.mjs` | Existing 28 WebSocket message names and room protocol versions 4/6 |
| `src/shared/catalog.mjs` | Existing prices, durations, payment object projections and wheel rewards |
| `src/worker/spatial.mjs` | Existing name normalization and zone helpers |
| `src/worker/world.mjs` | Existing RNG, collision world, singleton coins and Lucky Box helpers |
| `src/worker/firebase-auth.mjs` | Existing Firebase verifier and private certificate cache |
| `src/worker/http.mjs` | Existing CORS, payment and entitlement handlers |
| `src/worker/router.mjs` | Existing default HTTP/WebSocket routing |
| `src/worker/game-room.mjs` | Existing `GameRoom` Durable Object |
| `src/worker/zone-room.mjs` | Existing `ZoneRoom` Durable Object |
| `src/client/entry.mjs` | Imports the actual shared modules and lists ordered client build inputs |
| `src/client/*.js` | Twelve classic-script fragments grouped by existing responsibilities |
| `src/client/index.template.html` | Existing HTML shell, SDK URLs, styles and event handlers |
| `worker.js` | Compatibility exports for the original Wrangler entrypoint |
| `index.html` | Generated compatibility artifact for the original browser entrypoint |

The client fragments share a single classic-script lexical scope. They are build
inputs, not independently executable browser modules. `entry.mjs` is a valid ESM
manifest that can also be loaded by the browser. Converting gameplay to ESM would
change strictness, global handlers and scheduling, so P1 retains its original
execution model. Existing overrides and the final bootstrap calls retain their
order.

After changing client source or shared data, run `npm run build:client`.
`npm run check:client` and the P1 freshness test reject a stale `index.html`.
The generator resolves shared references from the imported manifest into literals
without minification or runtime helpers. The generated literals are not separately
authored source of truth. Static HTML labels remain the unchanged P0 UI copy.

Shared catalog projections preserve ordinary object prototypes, original field
order and mutable shapes. Server reward thresholds remain exactly 50, 80, 99 and
99.9 with the original unconditional final reward. RNG draw order is unchanged.
Equal-valued but unrelated settings remain separate, including visibility versus
Lucky Box spawn distance, legacy client AOI versus secure zone size, and client
movement speed versus the server's existing movement envelope.

## Compatibility and verification

`wrangler.jsonc` is unchanged byte-for-byte. `GameRoom`, `ZoneRoom`, `ROOM`, `ZONE`,
the migration tags, routes, wire messages and public exports are retained. P1
does not add auth deadlines, new ownership rules, movement authority, payment
policy, admission rules or protocol validation. P0 security limitations remain.

The original P0 test assertions remain enabled. The runtime harness now bundles
the production ESM graph with esbuild instead of stripping root export keywords.
Each fixture receives its own evaluated bundle, synthetic Firebase credentials,
mock payment provider, server clock and SQLite stores. Runtime tests cannot reach
external services.

The complete HTTP/WebSocket inventory and the test-extractor repair are recorded
in `P1-protocol-inventory.md`. The repair changes test classification only.

`source-view.cjs` traverses the active module graph and resolves shared wire/catalog
values for the unchanged legacy source checks. It is only a transparent static
view; runtime tests execute the real bundle independently. P1 also compares every
original Worker declaration and router, and the entire ordered client AST, against
the pinned P0 Git commit. The comparison ignores source locations/formatting and
folds only literal arithmetic/data expressions and top-level primitive const
initializers using earlier immutable const bindings. Function/control-flow changes
remain visible. A differential scenario executes both real bundles with identical
synthetic fixtures and compares startup, players, movement, coins and entitlements.

The browser gate uses local Chromium, the exact Three.js r128 development fixture,
mock Firebase SDK startup and loopback module serving. External assets are fulfilled
locally; application requests to production services are prohibited. This verifies
DOM/global-handler startup, real Three.js rendering initialization, controls and
browser imports. It does not validate real Google login, Firebase service access,
mobile devices, production payments, deployment or capacity.

## Required gates

1. `npm test` — all P0 static/semantic/runtime/legacy tests plus P1 tests.
2. `npm run check:static` and `npm run check:client`.
3. `npm run check:syntax`.
4. `git diff --check`.
5. `npm run bundle:dry-run` — no production deploy/publish.
6. `python tests/rebuild/p1-browser.py` — local browser/module loading.
7. Review complete diff and staged paths; commit only P1 files, push normally,
   verify matching local/remote SHA, unchanged main and clean working tree.

Any failed gate stops P1 before commit or the next phase. P2 requires a separate
user instruction even after a successful P1 checkpoint.
