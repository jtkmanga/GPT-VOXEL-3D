# P6 authenticated identity and persistent player checkpoints

P6 extends verified P5 `0200876db8a6d26c6ce372264c37bfbdca29262c`.
Firebase remains the browser sign-in entry point. The existing real Firebase
ID-token verifier validates issuer, audience, signature, UID and token expiry
before a room can acquire a session. Public packets still cannot supply UID,
player ID, session ownership, saved position/revision, economy state, rewards,
inventory or VIP state. No public player-save API is added.

## Durable identity and saved state

The existing logical-server SQLite `voxel_sessions` row remains the source of
UID ownership, stable player ID and last server-approved position. Fresh verified
login restores that player ID and position after release, resume-ticket expiry
or a GameRoom instance restart. The 120-second resume ticket is a short-lived
transport recovery capability, not the lifetime of the player's saved state.
Each successful acquisition rotates session generation and resume token, so
an old socket cannot mutate or release the new owner. Storage errors and corrupt
saved state fail closed; they do not produce an unsaved replacement identity.

P6 adds `save_revision` and `save_fingerprint` with an additive column migration.
P5 rows and all other authority tables stay intact. Score remains in
`voxel_scores` and economy receipts remain in the existing EconomyStore. These
fields are loaded from the backend, never copied from a browser save payload.
Nickname remains the existing validated score/profile display field rather than
a second competing copy in the session table.

A private position checkpoint has a server-authored monotonic revision. Newer
writes advance it. Older writes are rejected. A duplicate with exactly the same
revision and position returns the original success without changing data or
extending a lease; a same-revision different position or auth expiry is rejected.
The generation and owner check applies before idempotent replay. A failed SQLite
transaction leaves the previous revision and state intact, allowing an exact
retry. Token/lease refresh without a position does not advance the save revision.
A handoff advances the revision and changes owner transactionally; the source
owner cannot checkpoint after the transfer.

Every active P6 runtime position-write path supplies a revision and persists the
acknowledged revision in its WebSocket attachment, including movement, economic
contact checkpoints, handoff acknowledgement and cancellation. Omission remains
supported only for private trusted P0-P5 compatibility callers/fixtures, which
receive the next durable revision. Such a private call is not a browser route,
and no public packet accepts revision-controlled saving. Public protocol tests
prove attempted save packets, revisions and economic fields cannot reach this
boundary.

Position validation requires exactly finite numeric `x`, `y`, `z`, `r` fields;
`x/z` stay within the existing 748-unit movement bounds, height is 0 through 8,
and rotation uses the existing protocol range. Checkpoint payloads reject any
unknown fields, including score, balance, rewards, inventory and entitlement.

## Zone reconnect and preserved admission policy

Same-owner fresh login restores the saved position. A disconnected player whose
saved location belongs to its prior zone cannot choose a different zone to erase
that position: the server rejects the attempted acquisition with the saved
canonical `resumeZone`, without rotating ownership, and the browser follows a
bounded verified-auth redirect to that zone.

P5 already permits a verified active player to replace its session by explicitly
joining another zone. That policy is retained: a currently live cross-zone
replacement uses the target zone's server-generated spawn and keeps the stable
player ID. The distinct legacy-room-to-zone entry path also retains its
server-generated spawn. Neither path accepts client coordinates. Same-owner
recovery remains valid if a trusted server checkpoint lies across a zone border
while handoff is pending. Redirect applies only to a released/expired prior zone
with a canonical checkpoint in that prior zone; it is not a client teleport or
an unverified account-location disclosure.

## Names and visibility

Display names are constrained by the existing protocol's string/length rules,
then normalized by the trusted backend. Controls, direction overrides and
invisible formatting cannot become an authoritative displayed name. Rendering
uses world nameplates under the existing nearby-player/zone visibility rules.
The white world nameplate style remains covered by client and browser regression
checks; names do not become unrelated status/game UI text.

## Local verification and limits

`p6-identity.test.cjs` executes the active Worker graph, real Firebase signature
verification, SQLite transactions and synthetic WebSocket transport. Its cases
cover long reconnect/restart save restoration; stable ID; nonmutating verified
zone redirect; P5 cross-zone replacement; duplicate/stale/conflicting saves;
malformed positions/revisions; prohibited economic fields; UID/generation/owner
spoofing; expired token/lease; rollback and exact retry; refresh revisions; runtime
checkpoint revision/attachment handling; public save rejection; additive P5
migration; and corrupt-state rejection. P0-P5 behavior suites continue on active
source. Their unchanged phase-bound source scope proofs also run at their pinned
Git checkpoints.

The complete P6 hard gate additionally runs legacy assertions, browser/client
cases, static and generated-client checks, syntax checks, diff checks,
secret/config scan and Wrangler bundle dry-run. Local persistence/restart tests
exercise the real authority code through the SQLite harness; real cloud storage
availability, deployed hibernation, regional latency and 10,000-player capacity
remain unverified. No production deploy, publishing, payment or production
secret is involved in this phase.

## Completed hard gate

`node scripts/rebuild/gate-phase.cjs P6` passed 277 tests: 267 Node cases,
two unchanged legacy smoke programs and eight isolated Chromium cases, zero
failures and zero skips. All 43 legacy assertions, 89 syntax units, static and
generated-client checks, staged/unstaged diff checks, secret/config scan and
Wrangler bundle dry-run passed. Existing test files were not modified; the
unchanged phase-bound P5 source proof additionally runs at its verified SHA.
