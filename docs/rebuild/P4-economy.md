# P4 authoritative logical-server economy

P4 starts from the pushed P3 rebuild checkpoint
`592c0707a746f7a55002ce5fcc7110f00cdccf66`. This is the current rebuild
track; it does not claim to be source from any earlier recovery task. Its scope
is coins, Lucky Box, persisted scores and economic action idempotence. Firebase
verification, durable session ownership, movement simulation, handoff fences,
payment behavior and production bindings remain outside this phase.

## Invariants and authority

The logical server has one authoritative `GameRoom` economy. Movement
`ZoneRoom` objects call that owner through private Durable Object bindings; they
do not create a separate coin or box pool. The public Worker does not expose
these internal routes. Legacy room and zoned sessions use the same persisted
scores and resources.

| Resource | Required invariant |
| --- | --- |
| Coins | Exactly 200 logical IDs, 0 through 199, across the logical server |
| Coin reward | One authoritative award per successful coin cycle; persisted coin buff retains its existing one/two reward |
| Coin visibility | Successful collection removes that cycle for all viewers |
| Coin respawn | 60,000 milliseconds after the successful server transaction |
| Lucky Box | One persisted box across the logical server, not one per movement zone |
| Box claim | Exclusive, server-owned 90-second claim before spin |
| Box reward | One persisted reward for a valid claim/cycle; unchanged reward catalog and server RNG |
| Box respawn | Four hours after the successful reward transaction |
| Box spawn | Avoid collision, the original spawn exclusion and current authoritative player positions |
| Leaderboard | Top ten persisted scores ordered by score descending, then update time ascending |

A client can request an economic action but cannot choose its UID, ownership,
position, score, reward, buff, cooldown or spawn time. The economy owner validates
the current durable session generation and uses authoritative server position.
Zoned collection checkpoints the zone server's accepted movement position before
requesting an economic action. A submitted legacy contact coordinate cannot
change that position or authorize collection.

## Atomic persistence and retries

Economic mutations use synchronous SQL transactions. A successful transaction
commits the action identity, resource cycle/cooldown, reward and score together.
An idempotency receipt is scoped to the verified actor and action, so a retry
cannot collect a later cycle or repeat an already awarded spin. Receipt identity
does not confer session ownership: the current server ownership fence must still
pass before any action or retry response.

Coin and box snapshots read persisted server timestamps and cycles. Restart or
reconnect does not generate a replacement resource, reset a cooldown, repeat a
reward or replace authoritative score with a client value. Legacy persisted
cooldowns are retained during startup migration. Client optimistic coin hiding
remains only a visual hint; server snapshots and acknowledgments resolve it.

The room schedules the nearest persisted Lucky Box claim expiry or respawn time
with its Durable Object alarm. When that alarm runs, it reads the current row,
clears an expired claim or publishes the respawn snapshot to room and zone
viewers, then schedules the next deadline. Constructor startup re-arms the
persisted deadline. A claimant closing without spinning therefore does not leave
the other clients waiting indefinitely for a new login to refresh box state.

The client reuses its action ID for a retry of the same known resource cycle and
uses the server-time offset for cooldown display. It cannot promote an unknown
or explicitly inactive Lucky Box state into a locally claimable box. Existing
WebSocket vocabulary remains the same 28 message types; receipt/cycle metadata
extends existing economic packets without adding a second protocol definition.
An authoritative rejection ends that attempt, permitting a new action ID when
the player makes a later attempt. A missing network response retains the same
ID so retrying cannot repeat a committed reward.

## Active scope and regression proof

`tests/rebuild/p4-scope.test.cjs` compares active source to the real P3 Git
checkpoint. It retains exact comparisons for the shared configuration, protocol,
catalog and movement kernel, Firebase verifier, session module, public endpoints,
production bindings, every movement/auth/handoff/payment method and all
non-economic browser handlers. It isolates only the economic methods, route
branches and receipt/state handlers. The browser assembly still uses the same
twelve fragments and the same single authored physics kernel.
The active module graph adds one economic store instantiated by `GameRoom`;
movement zones do not instantiate it. The store's SQL cannot mutate session,
handoff, payment or entitlement authority tables. The only dispatch replay-cache
change defers caching the three economic request kinds until the actual handler
reports successful completion; every other auth, ownership, deadline, rate,
sequence and checkpoint statement remains under the exact AST comparison.

The six changed socket cases are `score`, `coin_collect_result`, `box_state`,
`box_spin_ready`, `box_reward` and `box_error`. They handle authoritative score
ordering, matched action acknowledgments, duplicate reward-display receipts and
retry state. In particular, `box_state` clears a claim attempt ID only when the
server explicitly rejects that matching attempt with `claimed:false`; this
permits a later legitimate attempt while preserving the original ID after an
unknown network outcome. Welcome, auth refresh, movement, ghost visibility and
every handoff case retain the P3 AST.

The original P1/P2/P3 phase-bound source proofs execute unchanged against their
actual checkpoints. Their equality assertions describe those completed phases;
all P0/P2/P3 runtime, client and security regressions continue to execute against
the active P4 source. No behavioral regression is moved to a historical runtime.
P4 adds actual Worker/SQL coverage for concurrent claims, durable retries, fake
server-clock expiry, restart recovery, cross-zone consistency, spawn exclusion
and persisted leaderboard accuracy. Test setup uses synthetic Firebase
credentials and local storage/WebSockets; client packets cannot invoke trusted
fixture placement.

## Evidence limits

The phase gate records the actual passing/failing/skipped totals and bundle,
syntax, browser, diff and secret checks separately. This document does not assert
results before those gates finish.

Local SQL and WebSocket tests establish the exercised transaction and ownership
invariants. They do not establish real Cloudflare scheduling, billing, network
failure, hibernation, production persistence throughput or distributed load
capacity. `GameRoom` remains a global economic/session coordinator; zone scaling
and delivery/recovery architecture remain subsequent phases. Actual mobile
hardware, real Firebase account revocation and payment-provider sandbox
integration still require later validation. No production deployment, paid
infrastructure, real payment, production secret/configuration change or merge to
main is part of this phase. Capacity remains **NOT YET VERIFIED FOR 10,000
CONCURRENT**.

## Completed local hard gate

P4 passed 209 tests, zero failures and zero skips (199 Node cases, two unchanged
legacy WebSocket smoke programs and eight isolated Chromium cases), all 43
legacy assertions and 80 syntax units. Static/generated-client checks, staged
and unstaged diff checks, secret/config scan and Wrangler bundle dry-run passed.
Review reproduced and fixed uncommitted rejection retry liveness and server
publication at claim expiry. The extracted coin packet send contract is proved
with an actual connected peer; nonblocking fanout is proved with delayed
transport and an already committed collector ACK. No real payment, production
configuration change or deployment was performed.
