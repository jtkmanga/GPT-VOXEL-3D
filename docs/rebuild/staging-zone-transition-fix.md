# Continuous staging Zone transitions

Source checkpoint: `8f2c97f05cd810817fda6b7eae2689f2cfc63779`, on
`rebuild-p0-p8`. This corrects the boundary freeze found during the mobile
retest; it does not restart a rebuild phase.

## Cause

The old handoff marked the client as transferring before target authentication
and stopped both prediction and movement transmission until ownership was
acknowledged. The source also discarded movement while its ticket was pending.
Target authentication and resume reset motion, and multiple sequential
coordinator requests kept target input queued. A slow target handshake therefore
became a visible movement pause. Simply replaying several seconds afterward
would conflict with the existing half-second authoritative time budget.

## Fix

The staging Free Server explicitly negotiates continuous handoff. During target
warm-up, the owning source Zone continues normal authoritative frame validation,
position checkpoints, movement acknowledgements and coin processing. The client
keeps predicting and sends movement and pickups to that source, including after
the provisional target socket opens.

At cutover, a private source request joins the same queue as movement and
checkpoints, then seals further source writes and captures the latest validated
position, velocity, jump latch, accepted sequence and remaining clock budget.
GameRoom atomically commits the existing ownership transfer, checkpoint and
fresh economy state. Target authority restores this server-owned motion rather
than resetting it. The client reconciles the accepted sequence and retains and
resends only the unacknowledged frames with their original sequence numbers.

Asynchronous source cleanup is fenced by the exact handoff ticket, so delayed
cleanup cannot evict a player who has returned to the same Zone under the same
session. Provisional target snapshots cannot overwrite the source's live world
state; fresh commit snapshots apply after a validated ownership acknowledgement.
Cancellation reconciles the latest source pose without restoring an old border
anchor or refunding simulation credit. Ambiguous ownership or expired transfers
fail closed.

A rapid-reversal browser test also found a cancellation timing defect: advancing
the motion clock without integrating input discarded the time backing one
pending frame. Continuous cancellation now clears retained credit while keeping
the last actual integration clock. Newly elapsed time can pay for pending input
once, and accepted sequences still cannot be replayed. Legacy rollback behavior
is unchanged.

The Zone architecture, authoritative collision and speed limits, clock budget,
replay protection, single-owner session checks and transactional coin rewards
remain enabled. Continuous mode requires staging configuration and explicit
negotiation. Legacy behavior remains covered by unchanged tests. No new
Cloudflare binding, namespace or migration is required.

## Local verification

- Full `npm test`: 403 active behavior/security tests and 120 unchanged
  checkpoint/static tests passed, with no failures or skips. Both unchanged
  legacy multiplayer scenarios also passed. This includes 33 new client,
  server and protocol regressions.
- Browser checks: 5 new Zone scenarios, 6 existing gameplay scenarios,
  11 staging compatibility scenarios and 8 default-client scenarios passed.
  Actual generated client, Three.js/WebGL and bundled Worker/Durable Objects
  run against isolated synthetic identity, transport and SQLite fixtures.
- A 2,033.3 ms target warm-up produced 0 ms visible movement pause. The browser
  measured local authoritative cutover at 19.4 ms. Twelve server-side repeated
  cutovers accepted all 60 movement frames; their final full-suite maximum
  local cutover was 6.54 ms. These are local measurements, not Cloudflare
  network-latency guarantees.
- Forward motion, turns, seven rapid warm-up reversals, held jumping,
  coin pickup before/after crossing, global removal, 60-second respawn,
  the 200-coin limit, unique ownership and position continuity passed.
- Rejected/ambiguous commits, expired targets/tickets, stale messages,
  account changes, replay, source cleanup and cancellation-budget tests passed.
- JavaScript/Python syntax, generated-client consistency, structural and
  Firebase configuration checks, credential scan, whitespace checks and
  pinned Wrangler 4.149.0 staging dry-run passed.

One earlier full run hit an existing unmodified synthetic fixture timing race:
its two `Date.now()` reads sometimes make an exact-duration interval differ by
one millisecond. The complete unchanged suite passed on rerun. No assertion,
payment implementation or production configuration was changed for that result.

## Mobile retest

1. Refresh the staging page, sign in and enter the Free Server.
2. Hold the movement joystick continuously across several Zone boundaries.
3. Turn during a crossing, then cross the same boundary back and forth rapidly.
4. Jump just before and during a crossing; check that movement and the jump
   continue without a pause, snap or extra jump.
5. Collect coins immediately before and after a crossing. With a second player,
   confirm each coin disappears for both players and awards only once.
6. Wait 60 seconds for a collected coin to respawn, then collect it again.

Expected: smooth movement, continuous authoritative position, no duplicate
players and unchanged coin behavior. Live mobile verification remains necessary
because local transport fixtures cannot reproduce every device and network.
Do not proceed to VIP or payment testing as part of this fix.
