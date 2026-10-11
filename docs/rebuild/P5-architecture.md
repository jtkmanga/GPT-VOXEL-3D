# P5 zone ownership, routing and scaling boundaries

P5 builds on the pushed P4 rebuild checkpoint
`149ecd9f4c617dd432e3536443be7b3081827c9b`. It partitions movement visibility and
resource-event delivery while retaining the P4 world, movement, resource and
payment semantics. It does not establish production capacity.

## Authoritative ownership and routing

The original Worker exports and bindings remain `GameRoom`/`ROOM` and
`ZoneRoom`/`ZONE`, with the same migration tags. `/play` without a `zone` retains
the legacy `free-v2-demo` room. `/play?zone=x,z` resolves a validated grid
coordinate to `free-zone-x,z`. Public HTTP routes, WebSocket message types,
Firebase validation and movement input schemas remain unchanged.

The 1,500-unit map has a deterministic 10-by-10 grid of 150-unit movement zones.
A ZoneRoom accepts at most 120 transport sockets, including pending
authentication. That is an admission bound for one zone, not a claim that the
100-zone grid supports any particular total concurrency. A crowded zone can
reach its bound while distant zones remain empty. The legacy room separately
retains its 160-socket bound.

GameRoom stores one durable session row per verified UID. The row identifies
the session generation, player ID, owner, resume ticket, expiry and latest
server-authoritative position. Zones simulate only their owned players, using
the same authored physics and deterministic collision world as browser
prediction. Neither the browser nor a provisional handoff target can become an
authority for position, rewards or ownership.

Within a zone, player updates select authenticated active recipients inside the
preserved 120-unit visibility radius. Border snapshots connect at most eight
adjacent zones and receivers apply the same recipient-distance filter. A border
snapshot is visibility state; it does not confer simulation ownership. The
500 ms border cadence and 200 ms movement cadence remain distinct.

Live-zone membership comes from the authoritative session table's owner, lease
and Firebase-token expiry, using an owner/lease/expiry index. There is no second
mutable presence registry whose contents can outlive an owner. GameRoom's
private active-zone query returns validated occupied zones, optionally limited
to a requesting zone's neighbors. Resource events intersect their original
geographic recipients with those live zones; logical-server leaderboard and
Lucky Box events target live zones instead of waking every cell in the grid.
A later join still receives the full persisted bootstrap state.

Visibility excludes both expired Firebase sessions and expired server-issued
resume leases. This mirrors the existing 120-second durable ownership lease;
it does not extend lease or token lifetime. An expired row cannot keep a zone
subscribed or a ghost/player visible solely because its socket is still open.

`zone-routing.mjs` performs the circle/zone-rectangle broad-phase test using the
canonical map size and radius. `zone-visibility.mjs` maintains a zone-local
projection cache and monotonically increasing durable border revisions. Border
messages carry private source revision and server-time metadata; receivers
discard older revisions/timestamps. The cached source state is projected again
when the observer moves, so an unchanged remote player can enter or leave the
observer's radius. A full per-source snapshot is emitted only when that
observer's projected visible set changes. Same-zone visibility tracks membership
and sends the existing `join`/`leave` message types on entering/leaving radius.

Adjacent live-zone lookup is shared by concurrent local requests and cached for
500 ms. A received border snapshot becomes stale after two seconds without an
update and is projected as empty. A routing lookup failure clears projected
visibility rather than creating an owner or authorizing an action. These
projection tables contain no economic, entitlement or session authority.

## Logical-server resources and persistence

Only GameRoom constructs an `EconomyStore`. The logical server has exactly 200
coins and one Lucky Box, regardless of the number of active movement zones.
Coin cooldown remains 60 seconds and Lucky Box cooldown remains four hours.
Zone collections identify a verified durable session; GameRoom obtains contact
position from its persisted server checkpoint, rather than submitted client
coordinates.

Coin generations, Lucky Box lifecycle/claims, score changes and action receipts
use durable transactional storage. A collection commits its authoritative
state before its event is published. Score and leaderboard derive from that
same persisted economy. Routing a snapshot or event into a zone never creates
a resource pool in the zone. Payment and entitlement behavior is unchanged in
P5; the later payment phase is responsible for the requested VIP policy.

## Transfer and failure recovery

A border crossing creates a short-lived server-issued ticket anchored to the
source simulation. The target verifies the same Firebase UID and consumes a
single-use ticket, but remains provisional until the durable owner compare and
swap succeeds. Resume validates the server anchor, transfers that one owner,
acknowledges the target and then revokes the source socket. An old source close
callback cannot release the successor generation.

Source cancellation invalidates both an unconsumed ticket and a consumed
pending grant. It restores only the source server's saved pre-crossing state.
Late acknowledgement, duplicate resume, expiry and connection loss cannot
create a second owner. If durable ownership or persistence is unavailable,
the operation fails closed instead of inventing a fresh in-memory owner or
reward. The short resume ticket recovers the last durable position; it does
not authorize a client-selected teleport.

P5 closes a reproduced snapshot race: a provisional target's bootstrap can
precede an economic change while the target cannot yet receive live owner-only
events. After transfer and checkpoint, but before the target resume ACK, the
target requests current world state from GameRoom using the committed UID,
session generation and owner. GameRoom validates that identity and returns the
existing 200-coin snapshot, Lucky Box, persisted score and leaderboard. The
target revalidates ownership after that RPC and projects those values through
the existing `coin_state`, `box_state`, `score` and `leaderboard` messages before
acknowledging resume. The coin snapshot is one bounded array message rather
than 200 messages. Only a `coin_state` packet carrying that array invokes the
existing authoritative browser snapshot function; single-coin updates retain
their previous path. Neither new wire message types nor reward/mutation paths
are added. A state-refresh failure attempts generation-fenced release and
source revocation and closes the target instead of acknowledging stale or
invented success. Successful target ACK still precedes source close.

Visibility updates can also arrive while a packet's durable checkpoint RPC is
pending. P5 serializes successful economic replay receipts before that wait,
then rereads the current attachment and checks UID, generation, transport,
revocation and provisional state immediately after it. This prevents a stale
local attachment from erasing a fresh visibility projection or revocation.
Movement awaits its receiver projection refresh before returning to the packet
dispatcher. The existing token, ownership, protocol and replay validations
remain intact.

GameRoom startup preserves the durable session/economy tables and re-arms the
Lucky Box alarm. A ZoneRoom reconstruction restores WebSocket attachments and
the remaining auth deadlines, and preserves its border-cache/revision tables.
Event delivery and border snapshots are
secondary to the durable authority: a missing notification cannot grant a
second reward. Reconnecting/bootstrap reads the authoritative resource state.

## Bottleneck audit and assumptions

Movement integration, local recipient selection and border snapshots run in
the owning ZoneRoom. The maximum number of same-zone recipients is bounded by
zone admission and the radius filter. Border communication is bounded by
adjacency; it does not broadcast movement to all 100 zones. The current
recipient search still scans a zone's sockets rather than a spatial index.

GameRoom remains a global authority and a significant scaling constraint:

- Each accepted authenticated zone frame validates its owner in GameRoom and
  checkpoints the resulting position there. At the normal five movement
  messages per second this produces about ten coordinator RPCs per player per
  second before auth, collection, handoff and other traffic. For 10,000 players,
  100,000 RPCs per second is a demand estimate, not measured throughput.
- Session admission, duplicate-session fencing, transfers, resource mutations,
  score ordering, payment and entitlement persistence share that authority.
- Leaderboard and Lucky Box updates remain logical-server events; relevant
  occupied zones must receive a consistent authoritative value. A concentrated
  collection or login burst can still contend on the coordinator.
- Per-socket token buckets and serialized input queues bound a connection's
  work, but do not establish a tested global reconnect/login burst capacity.
- Real Durable Object scheduling, SQLite/runtime limits, WebSocket hibernation,
  regional network latency and failure behavior require suitable infrastructure
  evidence; the local runtime harness cannot prove those limits.

Further coordinator partitioning requires a separate design that preserves a
durable unique UID owner and generation fence. One possible direction is
durable sharded session authority with a single logical economic authority and
authenticated server-issued ownership capabilities. Reducing checkpoints or
replacing an owner validation with a cache must first prove that immediate
duplicate-session revocation and fail-closed collection remain intact. P5 does
not make either security tradeoff.

## Validation and release boundary

Active P0–P4 behavioral/security tests continue to run on the P5 source. P5
adds actual routing, subscription, proximity, border, handoff, failure and
logical-economy tests. The active scope proof compares P5 to the real P4 Git
checkpoint and freezes the unchanged Firebase/session/schema, movement/world,
economy, payment, browser and external-binding sources. Phase-bound historical
AST comparisons run additionally at their own actual checkpoints; they do not
replace active behavioral regressions.

The scope proof permits exactly the reviewed routing methods and private border
routes. After removing one routing index, one zone-visibility constructor, one
local subscription initializer and one receiver-refresh call, the original
constructor/auth/movement executable ASTs remain equal to P4. The original
handoff/CAS control flow remains exact after removing only the reviewed
post-checkpoint state refresh/fail-closed sequence. The only new world-state
query validates current ownership before reading existing snapshots. Every
original payment/economy route/method remains exact. The client scope restores
one snapshot branch to its previous single-state call and then requires the
entire original fragment AST to match. The dispatcher proof removes only the
new successful-receipt serialization and post-checkpoint generation/attachment
fence, then requires its entire module AST to match P4. New modules may
access only `voxel_border_snapshots` and `voxel_border_revision`; they cannot
instantiate economic/session stores or write their authority tables.

Local tests, browser loading and Wrangler bundle/dry-run are permitted here.
There is no production deploy, publish, merge, real payment or secret change.
Production load, failover and mobile-device evidence remain release work.

**NOT YET VERIFIED FOR 10,000 CONCURRENT.** The number of possible grid cells,
their admission bounds and local synthetic test results are not evidence of
production capacity or release readiness.

## Completed local hard gate

P5 passed 249 tests, zero failures and zero skips (239 Node cases, two unchanged
legacy WebSocket smoke programs and eight isolated Chromium cases), all 43
legacy assertions and 85 JavaScript syntax units. Static/generated-client,
staged/unstaged diff, secret/config and Wrangler bundle dry-run checks passed.
Active P5 tests include 26 real Worker/SQLite zone cases, 11 exact scope proofs
and three actual client snapshot cases. Failure tests cover dropped/late ACK,
expired leases, monotonic snapshot recovery, delayed checkpoint attachment
updates and unavailable post-transfer world state. These local results do not
verify coordinator capacity or production availability.
