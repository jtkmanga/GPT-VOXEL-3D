# P3 movement authority and scope proof

P3 starts from the pushed P2 checkpoint
`e7ce2674f66f8d7c7f22efb669bd506e5359bceb`. It changes movement authority,
prediction/reconciliation and the transfer of movement ownership. It does not
implement the later economy, zone scaling, payment or release phases.

## Authoritative movement

The browser sends `move` with a bounded `{x, z, jump}` intent and a monotonically
increasing integer `seq`. It cannot supply position, velocity, speed, elapsed
time, entitlement or score. The server uses its clock, verified speed entitlement
and the original deterministic world geometry. The same authored module,
`src/shared/movement.mjs`, supplies bounded acceleration, gravity, jump and
continuous axis collision to the Worker and browser prediction. The generated
classic browser script contains an assembled copy of that module; there is no
second authored physics implementation.

Keyboard and joystick directions retain the original camera-relative mapping.
The normal/entitled speeds remain 22/44, jump impulse 16 and gravity 42 from the
original client controls. Network updates retain the 200 ms cadence. The server
now calculates these positions instead of accepting the previous 26/50 speed
envelope around submitted coordinates. It bounds integration after a long gap
and rejects stale, duplicate, out-of-order and malformed intents.

An own-player `move` ACK carries authoritative position, velocity and the applied
sequence. The client discards acknowledged prediction work, replays subsequent
predictions using the shared kernel and damps a bounded visual correction. It
retains a jump intent until an applied ACK acknowledges that jump generation.
Disconnected and provisional target sockets cannot advance predicted movement.

## Handoff safety

A transfer position comes from the source server's accepted simulation state.
An optional legacy `handoff_resume` coordinate hint can be checked against that
anchor, but cannot move the target. The provisional target remains inactive
until the durable ownership CAS succeeds. Its private ticket fence records UID,
session generation, source, target, expiry and pending/completed/cancelled state.
Source cancellation invalidates both an unconsumed ticket and an already
consumed provisional grant. Cancellation restores only the saved server
pre-crossing movement state. Creation, cancellation or ownership-storage failure
closes the affected socket; it does not invent a fresh owner or spawn.

The existing `handoff_cancelled` message now carries the authoritative rollback
position and motion for reconciliation. No WebSocket message type is added or
removed. The target ACK precedes source revocation; late ACKs, expired grants and
old session generations cannot create duplicate active ownership.

## What the active source proof checks

`tests/rebuild/p3-source-preservation.test.cjs` compares the current files to the
real P2 Git checkpoint. It checks these boundaries directly:

- Root entrypoint, Wrangler bindings/migrations, public HTTP/router code,
  Firebase verifier, durable session module, world/spatial source and all shared
  config/protocol/catalog files are byte-identical to P2.
- The twelve client fragments remain in the same manifest order. The generated
  browser kernel has the exact AST of the single authored movement module, and
  the Worker module graph loads that same module.
- All client auth, entitlement, payment, shop, snapshot and nonmovement widgets
  retain their original executable AST. The jump control adds only the intent
  hook. New movement declarations and changed function boundaries have exact
  allowlists; all other ordered executable statements remain unchanged.
- Existing nonmovement socket cases remain exact. Only welcome, own-player
  movement, handoff reconciliation and the existing cancellation ACK handler are
  within the movement boundary. The coin and Lucky Box detection/render loops
  remain exact.
- GameRoom/ZoneRoom auth retains every P2 statement after removing exactly one
  motion initializer, one welcome motion field and, for the provisional Zone
  target, one private transfer-fence field.
- Every GameRoom economy, cooldown, reward, score, leaderboard, entitlement and
  payment method is unchanged. Existing economy schemas and startup recovery are
  exact; the only new constructor SQL table stores handoff fences.
- Existing internal economy, bootstrap and payment routes remain exact. Only
  handoff issue/consume/fence routes and session transfer are reviewed movement
  ownership boundaries.
- Zone collection removes only the old contact-coordinate declaration and its
  conditional client-position mutation. Collection throttles, global coordinator
  request, authoritative reward/state messages and error handling remain exact.
- Auth deadlines, packet/auth rate limits, secret/authority field denylist,
  Firebase auth packet validation and every nonmovement schema check retain the
  original AST. Only movement and transfer input branches change.

## Regression harness handling

The original P1 and P2 source-freeze tests remain unmodified and execute in full
against their actual Git checkpoints. Their equality assertions describe the
approved extraction and security changes at those checkpoints; demanding that
P3 preserve client-coordinate authority would contradict the approved P3 goal.
This active P3 proof replaces that contradictory comparison with the explicit
boundaries above. No behavioral regression is moved to historical source.

All P0/P2 behavior suites run on the active Worker/client. Movement fixtures send
valid intents through the real runtime and maintain the original security,
ownership, auth, economy and persistence assertions. Test setup can place a
server-owned player to exercise a resource interaction; a client packet cannot
use that fixture mechanism. P3 adds direct runtime coverage for movement,
prediction/reconciliation and handoff failure races. Synthetic Firebase
credentials and local SQL/WebSockets remain test-only.

## Preserved economy and limits

Coins remain 200 per logical server with a 60-second respawn. Lucky Box remains
one per logical server with a four-hour respawn. Rewards, score persistence,
leaderboards, buffs, existing payment catalog and backend entitlement authority
are unchanged in P3. Removing submitted contact positions prevents collection
from changing movement; it does not alter reward values or cooldowns.

This phase does not establish high-concurrency capacity or production readiness.
Actual mobile-device testing and suitable infrastructure/load evidence remain
later release gates. P3 validation uses local tests and Wrangler dry-run only;
there is no production deploy, payment, secret change or merge to main.
