# Rebuild P0 frozen baseline

This is a **new rebuild track** from `origin/main` commit
`f98aa9a044616b1b965b889cf0c02a0d3b041f65`. It records the active
`worker.js`, `index.html`, and `wrangler.jsonc` at that commit. It does not
represent, reconstruct, or claim to be any lost original P0–P3 source. No recovery
task filesystem, old source variant, archive, or patch was used for this catalog.

P0 adds documentation and a regression harness; gameplay and runtime behavior are
frozen. The behavior below is a source-derived contract. Automated test results
and remote checkpoint evidence must be recorded separately by the phase gate;
this document does not assert that mobile hardware or production has been tested.

## Constants and logical-server state

| Contract | Actual baseline |
| --- | --- |
| World | Size 1500; fixed server seed `free1`; usable movement coordinates within ±748 |
| Coins | Exactly 200 logical IDs, 0–199, per logical server; all zones use the same `GameRoom` economy |
| Coin respawn | 60,000 ms from a successful collection, measured with server `Date.now()` |
| Lucky Box | One persisted row, `id=1`, per logical server; not one per zone |
| Lucky Box respawn | 14,400,000 ms (4 hours) from successful spin/reward, measured with server time |
| Lucky Box claim | 90,000 ms exclusive claim before spin; expired claim is cleared when the box snapshot is read |
| Player visibility | Horizontal Euclidean radius 120, inclusive, for same-zone and border players |
| Movement/network | Client sends position at 200 ms intervals (5 Hz); server accepts movement no more often than 200 ms |
| Border snapshots | At most one ordinary flush per 500 ms per active zone; forced flushes bypass this throttle |
| Zone grid | 10 × 10 server movement zones, each 150 units; IDs `0,0` through `9,9` |
| Socket caps | Legacy room 160 accepted sockets; each zone 120 accepted sockets, including unauthenticated sockets |
| VIP catalog | 50 THB / 30 × 24 hours; current backend limits **active entitlements** to 100, not concurrent players |
| Other catalog | Speed ×2: 10 THB / 24 hours; coin ×2: 20 THB / 24 hours |

Coins and box positions are deterministic by ID/cycle and seed. Candidate
positions avoid the generated building/tree collision rectangles. Lucky Box
positions must be at least 120 units from the world origin, but the baseline does
**not** check positions against current players. Coin positions change at each
successful collection cycle, with the new position hidden until its respawn time.

The single logical economy owner is `ROOM.getByName('free-v2-demo')`; the movement
owners are `ZONE.getByName('free-zone-' + zoneId)`. Legacy `/play` and zoned
`/play?zone=...` use that same score/coin/box/payment store. Economy fanout can be
zone-filtered, but the stored 200/1 limits are global to this logical server.

## Worker entrypoint and configuration

`wrangler.jsonc` freezes these values:

| Setting | Value |
| --- | --- |
| Worker name | `voxel-run-v2-demo` |
| Entrypoint | `worker.js` |
| Compatibility date | `2026-09-27` |
| Public project ID variable | `FIREBASE_PROJECT_ID`, configured for the active Firebase project |
| Durable Object binding | `ROOM` → exported `GameRoom` |
| Durable Object binding | `ZONE` → exported `ZoneRoom` |
| Migration tag `v1` | `new_sqlite_classes: ["GameRoom"]` |
| Migration tag `v2-zone-room` | `new_sqlite_classes: ["ZoneRoom"]` |

Runtime configuration also reads `ALLOWED_ORIGIN`, `SLIP2GO_API_SECRET`, and
`PAYMENT_RECEIVER_ACCOUNT`. Their secret/account values are deliberately omitted.
The JSONC baseline does not configure an origin allowlist or contain payment
secrets. The browser hardcodes the deployed worker HTTP/WebSocket base and loads
Three.js r128, Firebase compat 10.8.0, Tailwind CDN, font resources, and payment QR
images from external providers. P0 tests must replace these network dependencies
with mocks; no real payment or production deployment is authorized.

## Public HTTP surface

| Path | Method / request | Auth and response |
| --- | --- | --- |
| `/health` | Any method accepted by the baseline path handler | No auth; 200 text `VOXEL RUN v4 online` |
| `/entitlements` | `GET`; `OPTIONS` → 204 | Firebase bearer token; returns `{ok, serverNow, entitlements:{speedExpires,coinExpires,vip1Expires}, servers:{vip1:{count,max:100}}, active:{speed,coin,vip1}}`; other methods 405 |
| `/verify-slip` | `POST` multipart `{file,item}`; `OPTIONS` → 204 | Firebase bearer token; origin check if configured; validated purchase returns `{ok:true,verified:true,item,price,expiresAt,entitlements}`; other methods 405 |
| `/play` | Request with `Upgrade: websocket` | Optional configured origin check; routes to legacy `GameRoom`; no bearer token during upgrade, Firebase auth required in first gameplay exchange |
| `/play?zone=x,z` | WebSocket upgrade with normalized grid coordinates | Valid zone routes to `free-zone-x,z`; invalid zone → 400; authentication takes place over WS |
| Other path / `/play` without upgrade | Any | 404 text `WebSocket endpoint: /play` |

Bearer token failures on entitlement/payment requests return 401. Configured
origin mismatch returns 403. Without `ALLOWED_ORIGIN`, CORS reflects the request
origin, allows `GET, POST, OPTIONS`, and allows `Authorization, Content-Type`.
HTTP `/play` does not require a particular method beyond the upgrade header.

Slip validation allows only `speed`, `coin`, or `vip1` at backend prices 10, 20,
and 50. File must be a nonempty image no larger than 8 MiB. Missing payment
configuration returns 500. The baseline calls the external Slip2Go QR-image API
with duplicate, recipient-account, and exact-amount checks, requires its success
code, rechecks amount, and derives a transaction key from bank/transaction reference
or a fallback reference ID. Provider/network failures produce 400/502 as handled;
grant/storage failures produce 400/500; reused stored transaction returns 409 to
the public caller. There is no webhook route in this baseline.

## Internal Durable Object HTTP surface

These paths are reached through DO bindings, not forwarded by the public worker.
They rely on binding-level isolation and contain no separate bearer-token check.
All request fields below are JSON except the stated GET endpoint.

| Owner / method / path | Request | Result / behavior |
| --- | --- | --- |
| GameRoom `POST /_internal/get-entitlements` | `{uid}` | Validates nonempty UID ≤128; authoritative expiry timestamps and active-entitlement count |
| GameRoom `POST /_internal/grant-payment` | `{uid,item,amount,transactionId}` | SQL transaction, duplicate rejection, expiry extension, persisted payment audit row |
| GameRoom `POST /_internal/zone-bootstrap` | `{uid,name}` | Creates/updates score nickname; returns score, top, all coins, box, entitlement expiries, server time |
| GameRoom `POST /_internal/create-zone-handoff` | `{uid,playerId,fromZone,toZone,x,y,z,r}` | Adjacent-zone/bounds validation; UUID ticket, expiry `now+12000`; deletes old expired tickets |
| GameRoom `POST /_internal/consume-zone-handoff` | `{uid,token,toZone}` | Atomically validates and deletes ticket; wrong UID/zone, replay, or expired ticket → 409; returns player/position/creation time |
| GameRoom `POST /_internal/zone-collect` | `{uid,id,x,y,z}` | Global coin distance/transaction validation; `{ok,collected,event?,score?,reward?,leaderboard?,activeAfter?,serverNow}` |
| GameRoom `POST /_internal/zone-collect-box` | `{uid,x,y,z}` | Exclusive claim and shared box state; `{ok,claimed,box,serverNow}` |
| GameRoom `POST /_internal/zone-spin-box` | `{uid}` | Single reward/score/cooldown transaction; invalid claim/cooldown → 409 |
| ZoneRoom `GET /_internal/border-state` | None | `{ok,zone,players,serverNow}` snapshot |
| ZoneRoom `POST /_internal/border-snapshot` | `{sourceZone,players,serverNow}` | Adjacent source only; at most 140 raw players; validates entries and sends radius-filtered ghost snapshots |
| ZoneRoom `POST /_internal/world-event` | Event object | Broadcasts event to all authenticated sockets in that zone |

Invalid JSON normally returns 400 on internal POST routes. ZoneRoom other fetches
without a WebSocket upgrade return 426. Room/zone capacity failures return 503.

## WebSocket protocol and identity/session behavior

Incoming frames must be strings no longer than 8192 characters; otherwise the
socket closes 1009. Malformed JSON is silently ignored. `auth` is processed before
the non-auth frame limit; subsequent gameplay frames longer than 256 characters
are silently ignored. Unknown types are silently ignored. Before every non-auth
packet, missing UID or expired token closes 1008. `acceptedAt` is stored but no
server authentication deadline is enforced. At most three initial auth attempts
are allowed; a fourth closes 1008. Same-UID refresh updates `exp`; changing UID
closes 1008. Refresh does not create a new player ID.

Firebase verifier checks RS256, key ID, project audience/issuer, nonempty subject
≤128, integer unexpired `exp`, non-future integer `iat`/`auth_time`, and signature.
It fetches Google X.509 signing certificates and imports their SPKI. Certificate
cache max age is capped at 3600 seconds with a 300-second fallback. Full tokens
are not explicitly logged by the baseline verifier. There is no Firebase
revocation/user-disabled check, certificate request coalescing, auth/HTTP flood
limiter, or schema-wide protocol version validation.

| Client → server type | Fields / actual baseline interpretation |
| --- | --- |
| `auth` | `{type,token,name?,handoffToken?}`; `name` normalized to 12 Unicode code points; optional handoff token applies only to ZoneRoom; client UID/entitlement claims are ignored |
| `move` | `{type,x,y,z,r}` numeric client position, not movement intent; server validates finite/bounds/time/speed envelope |
| `collect` | Legacy `{type,id}`; zoned client adds `{x,y,z,r}` contact position, which can update its stored position within the movement envelope |
| `collect_box` | `{type}`; claim based on stored player position |
| `spin_box` | `{type}`; reward based on unexpired server claim |
| `handoff_resume` | Zone only `{type,x,y,z,r}`; one validated continuation within the target zone and a nine-second target resume deadline |
| `handoff_cancel` | Zone only `{type}`; clears pending/resume state; emits cancellation |

Public player shape is `{id,x,y,z,r,name}` without UID. Coin shape is
`{id,x,z,respawnAt,cycle}`. Box shape is
`{active,x,z,nextSpawnAt,cycle,claimed,claimExpiresAt,serverNow}`. Leaderboard row
shape from SQL is `{nickname,score}`.

| Server → client type | Fields |
| --- | --- |
| `welcome` | `{protocol,id,spawn,players,coins,luckyBox,score,leaderboard,serverNow,count}`; legacy protocol 4; zone protocol 6 plus `{phase:'2B1',handoff,fromZone,zone}`; zone spawn includes `r` |
| `join` / `move` | `{player,count?}`; radius-filtered |
| `leave` | `{id,count}`; local-room/zone broadcast |
| `ghost_snapshot` | `{zone,players,serverNow}`; adjacent-zone snapshot filtered by radius |
| `auth_refreshed` | No extra fields |
| `auth_error` / `server_error` / `box_error` / `handoff_error` | `{message}` |
| `score` | `{score}`; used by legacy coin collection |
| `leaderboard` | `{top}`; global authoritative top ten |
| `coin_collected` | `{id,x,z,cycle,respawnAt,serverNow}`; new-cycle location and cooldown |
| `coin_state` | Legacy `{id,respawnAt,serverNow}` on cooldown retry |
| `coin_collect_result` | Zone `{id,collected,serverNow}` plus success `{event,score,reward}` or rejection `{activeAfter}` |
| `box_state` / `box_spin_ready` | `{box,serverNow}` |
| `box_reward` | `{reward,score,serverNow}` |
| `zone_change` | `{from,zone,handoffToken,expiresAt,position:{x,y,z,r}}` |
| `handoff_resumed` | `{x,y,z,r,zone,serverNow}` |
| `handoff_resume_error` | `{message,retryable?,serverNow?}` |
| `handoff_cancelled` | `{zone,serverNow}` |

No inbound version is required, and the client does not validate welcome protocol
compatibility. Initial login creates a new UUID player per socket. There is no
UID-wide single-session registry, ownership epoch, reconnect resume token, or
durable player position. DO WebSocket attachments preserve state during
hibernation, but ordinary reconnect creates another session/spawn. Token expiry
is checked on inbound gameplay, not by a proactive timer; periodic client HTTP
entitlement refresh does not refresh its established WS auth token.

## Movement, multiplayer, handoff, and browser controls

Server movement accepts horizontal distance ≤`maxSpeed*dt+0.65`, vertical distance
≤`9*dt+0.5`; `dt` uses server time and is capped at 1.5 seconds. Max speed is 26
normally or 50 with active speed entitlement. Bounds: `|x|,|z|≤748`,
`-0.25≤y≤8`, `|r|≤10000`. The baseline validates client coordinates rather than
simulating inputs and does not check movement collision or sequence numbers.
Legacy speed expiry is queried from SQL per move; ZoneRoom caches the expiry from
bootstrap, so a purchase during an existing zone session is not applied until a
new bootstrap. Zone coin contact position permits wider tolerances 1.25/0.75.

Keyboard: W/A/S/D or arrows; Space jumps. Touch: left joystick, jump button,
independent camera drag; mouse drag rotates camera. Gameplay is intended for
landscape. Browser uses `requestAnimationFrame`, frame delta capped at 0.1 s,
normal move speed 22 (44 with buff), ground/air acceleration 18/10, jump velocity
16, gravity 42, per-axis local building/tree collision, and camera-relative
movement. Remote players interpolate toward received targets; stale avatars are
removed after 3500 ms. Browser prediction is local position simulation without
regular self-position ACK/reconciliation from the server.

The active secure overrides suppress legacy Firebase score/economy/player writes;
older Firebase AOI helper declarations remain in `index.html` but are superseded.
Actual network movement is the secure 10×10 Worker zone system, not the earlier
15×15/100-unit Firebase AOI constants. Google Firebase login is required to start
the current secure game, and the map is initialized with `free1`.

Border crossing requests an adjacent-zone handoff. Ticket is bound to UID,
player ID, target zone and expires after 12 seconds; consuming it is atomic and
single use. Source remains connected while target authenticates and receives
welcome, then the browser sends resume and closes source after ACK. Resume uses
server elapsed time capped at nine seconds and horizontal/vertical tolerances
1.75/1.0. Client welcome timeout is ten seconds; resume ACK attempt timeout is
3200 ms. Returning to the source may cancel, and failure can restore the last
stable position. Unintentional ordinary close returns to the menu. These are
existing smooth-transfer mechanics, not proof of single authoritative ownership:
source and target can both be authenticated until the client closes one.

## Economy, persistence, leaderboard, entitlement/payment

Collection cooldown and reward changes run in synchronous SQL transactions.
Coin claim requires horizontal distance ≤2.35 and player height ≤2.6; collection
requests are throttled per socket to 150 ms. Reward is one or two with a persisted
coin buff. Repeated claim during cooldown does not award another score. Successful
claims set server cooldown/cycle and broadcast authoritative state. Zone updates
fan out near old/new coin positions, and the leaderboard goes to all 100 zones.
Collector ACK avoids waiting for fanout by using `waitUntil`.

Box claim distance is ≤2.8 with height ≤3.2. Spin requires matching claim UID and
unexpired claim. Reward distribution uses Web Crypto: 100 (50%), 500 (30%), 1000
(19%), 5000 (0.9%), 9999 (0.1%). Reward, score, next spawn time, cycle, and claim
clear commit together. Cooldown/claim/coin/score/payment survive DO recreation
through SQL. Leaderboard reads persisted scores ordered `score DESC, updated_at
ASC LIMIT 10`, without client-provided scores.

Purchases extend expiry from `max(currentExpiry,now)` by configured duration.
Payment transaction primary key prevents repeat grants. Active VIP renewal is
allowed even if 100 entitlements exist; a new inactive VIP buyer is rejected when
100 unexpired VIP entitlements exist. This counts memberships, not socket
admission. The active browser explicitly blocks VIP purchase and VIP entry while
the backend lacks a separate VIP room; backend `/verify-slip` still recognizes
`vip1`. Speed/coin browser flow still targets the payment provider and must be
mocked during this rebuild. Client grant/score mutations are disabled by overrides.

### Persisted SQL schemas

All six tables and the index are owned by GameRoom. ZoneRoom declares no SQL
tables in the baseline. Timestamps are milliseconds except JWT `exp` in seconds.

```text
voxel_scores:
  uid TEXT PRIMARY KEY, nickname TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
voxel_coins:
  id INTEGER PRIMARY KEY, respawn_at INTEGER NOT NULL,
  cycle INTEGER NOT NULL DEFAULT 0
voxel_lucky_box:
  id INTEGER PRIMARY KEY, next_spawn_at INTEGER NOT NULL DEFAULT 0,
  cycle INTEGER NOT NULL DEFAULT 0, claimed_uid TEXT,
  claim_expires_at INTEGER NOT NULL DEFAULT 0
voxel_entitlements:
  uid TEXT PRIMARY KEY, speed_expires INTEGER NOT NULL DEFAULT 0,
  coin_expires INTEGER NOT NULL DEFAULT 0,
  vip1_expires INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
voxel_payments:
  transaction_id TEXT PRIMARY KEY, uid TEXT NOT NULL, item TEXT NOT NULL,
  amount INTEGER NOT NULL, created_at INTEGER NOT NULL
voxel_zone_handoffs:
  token TEXT PRIMARY KEY, uid TEXT NOT NULL, player_id TEXT NOT NULL,
  from_zone TEXT NOT NULL, to_zone TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL, r REAL NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
voxel_zone_handoffs_exp_idx: INDEX on voxel_zone_handoffs(expires_at)
```

`cycle` is added to existing coin tables with `ALTER TABLE ... ADD COLUMN` under a
catch. Constructor creates box row `id=1`. The existing storage key
`coinRespawns` is imported into SQL once in `blockConcurrencyWhile`, then deleted
from that DO's storage. This runtime migration is frozen baseline behavior; it is
unrelated to the separate recovery task filesystem.

## Frozen defects and evidence limits for later phases

- No WS auth deadline, inbound protocol negotiation, UID duplicate-session
  ownership, stable reconnect/resume, or flood counters for malformed/unknown
  packets. Local caps can be occupied before auth; movement/collect throttles
  discard packets without enforcing an overall packet budget.
- Client coordinates remain movement authority within an envelope; no server
  input simulation, collision enforcement, sequence validation, or ordinary
  prediction reconciliation. Handoff has one-use tickets but no exclusive owner
  epoch; late target ACK and source cancellation are not durably coordinated.
- Logical economy is central, but GameRoom receives all bootstrap/global actions,
  top calculations and payment state. Every leaderboard/box update can fan out to
  all 100 zones. Cross-zone propagation failures are swallowed by
  `Promise.allSettled`; no durable retry/outbox exists.
- Coin/Lucky Box cooldowns prevent immediate double reward, but no durable
  per-action client request ID distinguishes retry across a future cycle. Box
  spawn avoidance checks origin/collision, not all players. Browser ordinary coin
  respawn loop compares local `Date.now()` to server cooldown rather than always
  using its server-time offset.
- VIP room/admission and a payment webhook do not exist; 100 means unexpired
  subscriptions. Client VIP purchase/entry is disabled while the backend catalog
  remains defined. Payment-provider traffic and money are prohibited in rebuild
  tests. Recipient configuration/QR consistency requires later manual setup.
- No observed load, CPU, memory, soak, mobile-device, production persistence,
  failure recovery, or deployment evidence is supplied by this catalog.
  **NOT YET VERIFIED FOR 10,000 CONCURRENT.**

These findings are baseline observations, not fixes or instructions to bypass a
phase gate. P0 tests should verify the current behavior without asserting that
these missing guarantees already exist. Later changes must add explicit coverage
for each guarantee while retaining relevant baseline regressions.
