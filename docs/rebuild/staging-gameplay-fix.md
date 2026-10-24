# Staging movement and coin pickup runtime fix

Source checkpoint: `bc50e2ef03eadd5bb001e9d928dd78f24d9a03c9` on
`rebuild-p0-p8`. This is a correction after the first staging deployment,
not a restart of any completed rebuild phase.

## Confirmed movement cause

The client predicted ordered per-frame inputs, but sent only its newest input
every 200 ms. The server applied that input retroactively over the packet's
arrival/dispatch interval. Client reconciliation retired frames by sequence,
so server time already included network delay that later prediction replay
could simulate again. Burst packets also hit the legacy 200 ms gate.

The actual client and ZoneRoom reproduction produced corrections exceeding
six world units on direction changes and delayed delivery, triggering hard
position snaps. Collision geometry, ordinary position writers, stale-socket
fencing and reconnect handling were checked; no corresponding defect was found.

The staging client now sends the exact ordered prediction frames for each
sequence. Authority validates at most 64 frames, each with an input and a
bounded duration; the total cannot exceed 0.5 seconds. Durations cannot grant
time: a capped server-clock budget determines the affordable simulation prefix.
The same authoritative speed, bounds and collision kernel still apply.
Sequence, ownership, authentication and packet-rate protections remain active.
Legacy packets clear unused batch credit to prevent double spending.

Reset/handoff starts without claiming pre-reset render time. High frame rates
flush before packet limits. Cancellation clears spent simulation credit rather
than restoring it with the previous position.

Regression maximum position correction is zero for rapid turns and 250 ms
ordered jitter, and approximately 0.367 world units for the 350 ms backlog case.
The latter retains the authoritative 0.5-second clock cap.

## Confirmed coin causes

Pickup ran every animation frame while movement reached authority every 200 ms.
At normal speed, valid rendered contact could therefore be tested against a
server position over 2.35 units away. The next immediate retry hit the 150 ms
collection throttle, which returned silently and left the client waiting for
its 2.7-second visual timeout.

Pickup now flushes the current sequence's movement frames before sending
COLLECT. WebSocket order and the owning Durable Object queue apply movement
before validation. COLLECT still contains only resource and action identifiers;
it cannot author position, distance, reward or score. Throttle/rejection replies
restore authoritative visibility and provide a bounded retry delay.

Coin IDs and geometry already matched. GameRoom remains the economy owner;
ZoneRoom submits the latest owning-session checkpoint. Distance validation and
transactional reward/cooldown/receipt logic are unchanged. Tests verify one
award, observer removal, a 60,000 ms cooldown and exactly 200 map coins.

## Verification before deployment

- Active behavior/security suites: **370 passed, 0 failed, 0 skipped**,
  including **20 new movement, pickup and handoff regressions**.
- The unchanged P9 source-preservation proof: **2 passed** on its actual
  original checkpoint. The history runner retains this complete immutable
  proof, as it already does for earlier phase-specific scope proofs. Existing
  test files and assertions are unchanged.
- New offline gameplay browser regression: **6 passed, 0 failed, 0 skipped**.
  It runs the generated client, Three.js/WebGL, keyboard input and game loop
  against actual bundled Worker, ZoneRoom, GameRoom, RSA verification and
  SQLite fixtures. It covers walking, delayed ACKs, opposite inputs, pickup,
  observer removal, exact respawn and the coin cap without external traffic.
- Existing staging browser compatibility regression: **11 passed**.
- Legacy multiplayer/static checks, syntax, generated-client consistency,
  secret/configuration scan, configured staging isolation and
  `git diff --check`: **PASS**.
- Pinned Wrangler 4.149.0 staging deployment dry-run: **PASS**; target exactly
  `gpt-voxel-3d-staging-01`, Firebase project `gpt-voxel-3d-staging`.

The staging manifest and its Firebase public configuration stay under ignored
`work/staging`; no credential values belong in this checkpoint. Production
Wrangler configuration remains unchanged. Deployment uses only the existing
staging Worker and its staging-owned namespaces; no migrations were added.

After deployment, refresh the staging page and manually retest continuous
walking/turning/jumping, two-player pickup/removal and the next 60-second coin
cycle. This local evidence does not replace the user's real device/network
test. VIP and payment integration testing is outside this correction.
