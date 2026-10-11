# P3 server-authoritative movement and regression boundaries

This phase intentionally replaces the P0/P1/P2 client-authored movement
coordinates with server-integrated input. It does not change coin slots, coin
respawn, Lucky Box count/cooldown, rewards, persisted scores, leaderboard values,
payment amounts, Firebase identity or Durable Object bindings.

## Input and simulation authority

Normal movement sends the existing `move` discriminator with
`{ input: { x, z, jump }, seq }`. Axes are finite, individually bounded to
`[-1, 1]`, and their combined magnitude is at most one. `jump` is Boolean and
the sequence is a nonnegative safe integer. Client-authored position, rotation,
velocity and elapsed time are not movement authority. Existing coordinate-only
movement frames remain negative security fixtures.

The shared movement kernel provides the control physics used for prediction.
The Worker chooses elapsed server time, actual world collision geometry and
verified speed entitlement. It enforces bounds, collision and input ordering;
the client uses the server acknowledgement to reconcile prediction. Existing
200 ms network cadence is retained. A server transfer ticket fixes the handoff
anchor, and a reconnect resumes persisted authoritative coordinates.

## Keeping prior behavior regressions meaningful

All P0 and P2 runtime suites execute the active Worker bundle. They are not
rerouted to older source, and no assertion is disabled or skipped. Their normal
movement packet fixtures now use the real intent protocol:

- `h.moveTo` encodes a physically reachable test target into analog input using
  the actual shared prediction kernel and the current server fixture velocity
  and clock. It sends only intent and sequence. It refuses targets outside the
  real input/speed envelope or blocked by actual world geometry. The actual
  Worker independently applies security, ownership, timing and collision checks.
- Original normal x/z targets and nearby/distant fanout counts remain asserted.
  A tolerance below `1e-9` accounts only for floating point integration, replacing
  exact integer equality without admitting a meaningful position error.
- Rotation expectations now come from predicted normal input or the accepted
  authoritative anchor, rather than trusting a client-authored `r: 0`. Position,
  identity and ownership continuity remain asserted across resume and restart.
- The movement flood uses valid idle intents with increasing sequence IDs so
  that it still proves the packet budget, rather than passing because obsolete
  coordinate frames fail schema validation. Duplicate/stale/out-of-order tests
  likewise send actual valid intent with the original sequence patterns.
- Malformed JSON, invalid coordinates, oversized input, UID/entitlement/score
  spoofing and other attack fixtures remain actual negative runtime tests.

The P0 handoff test previously requested `x: 2` after a ticket anchored at
`x: 1`, and asserted that the target accepted that client coordinate. The user
explicitly superseded this authority in P3 by requiring input-only movement and
no reconnect/handoff teleport. The active regression now sends that same
displacement as an attack, asserts rejection and continued source ownership,
then resumes the exact ticket anchor and asserts all four coordinates, the
closed source socket and the sole persisted target owner. Original player
identity, one-use ticket, replay and expiry assertions remain.

The two unchanged historical WebSocket smoke programs express small normal
control targets in the old transport. Their explicit offline driver encodes
only finite, bounded normal steps into real directional intent; it never sets
server position, velocity, collision geometry or time. Impossible or malformed
frames are forwarded unchanged for real validation. Every original handoff and
border-visibility assertion still executes against the active Worker.

## Phase-bound source proofs

P1's complete unchanged extraction/equivalence proof runs against Git checkpoint
`10dfaf0aff07d2896c50af06d88502166b16fe9e`. P2's complete unchanged nine-test
source-preservation proof runs against checkpoint
`e7ce2674f66f8d7c7f22efb669bd506e5359bceb`. Each proof explicitly enumerates its
own phase's permitted source changes; applying that allowlist to the approved
P3 movement implementation would incorrectly forbid the work itself. These
tests are preserved in full and run on fresh `git archive` trees. Active P3
source-preservation checks and all active runtime/security regressions verify
the current phase. These checkpoints are rebuilt Git history, not recovered
original-task files.

Git metadata is explicitly rooted to each archived test worktree while running
these read-only proofs. Otherwise relative `git ls-tree` pathspecs inside an
archive nested under `work/` would be interpreted against the enclosing checkout
prefix and return the wrong file inventory.

## Component validation

Before the complete phase gate, the regression adaptation was verified with:

- 10 active P0 runtime tests and 26 active P2 security tests: 36 passed, zero
  failed, zero skipped.
- Both unchanged offline legacy WebSocket smoke programs: passed.
- Eight unchanged pinned P1 source tests and nine unchanged pinned P2 source
  tests: 17 passed, zero failed, zero skipped.

This is a component result, not a production deployment or a scalability claim.
The complete phase gate must also cover the new P3 tests, remaining regressions,
static/generated-client checks, syntax, both diff checks, browser loading,
secret checks and Wrangler dry-run before commit and push.

## Completed local hard gate

The full P3 gate passed 147 tests, zero failures and zero skips: 137 Node
behavior/source cases, two unchanged legacy WebSocket smoke programs and eight
isolated Chromium browser cases. All 43 legacy assertions, static/generated
client checks, 75 JavaScript syntax units, unstaged/staged whitespace checks,
secret/config scan and Wrangler bundle dry-run passed. Read-only review found no
unrelated economy, payment or Firebase/session changes. These are local results;
there was no production deployment or 10,000-concurrent verification.
