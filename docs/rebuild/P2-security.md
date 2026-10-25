# P2 auth, session and protocol security

This is the new rebuild track. It does not recover or identify any lost original
P0–P3 implementation. P2 changes authentication, session ownership and inbound
protocol enforcement. Movement integration, economy rules, world generation,
payment prices and zone geometry are retained for their respective later phases.

## Runtime authority

- `src/worker/firebase-auth.mjs` verifies Firebase RS256 signatures using the
  trusted Google certificate endpoint and checks project audience, issuer, UID,
  expiry and claim timing. Synthetic test keys are generated in memory; no
  production credential is required for local tests. Certificate fetches share
  an in-flight request and respect a bounded trusted-certificate cache.
- `src/worker/security.mjs` validates actual inbound frames before dispatch.
  Text frames are limited to 8,192 UTF-8 bytes. Authenticated identity, score,
  rewards and entitlements cannot be supplied as client-owned packet fields.
  Auth, movement, coin, box and handoff packet fields receive scalar/range
  checks. Malformed, unknown, binary and oversized messages close the connection;
  ordinary schema errors have a bounded three-strike policy.
- Socket packet buckets allow an initial 40 packets and refill at 20 per second.
  Authentication has a separate three-attempt bucket. The per-socket async queue
  is bounded to 64 pending frames and serializes verification and mutation.
- A new socket must authenticate within 10 seconds of its server-recorded
  acceptance time. Same-UID refresh retains the player/session identity and reads
  entitlements from backend state; a UID switch is rejected. Gameplay messages
  require unexpired verified authentication and a matching durable owner.
- `src/worker/sessions.mjs` stores one SQLite row per verified UID within the
  logical server. Session generations fence older sockets; replacement revokes
  the previous owner. Closing an older generation cannot release its successor.
  Database failures have no in-memory authorization fallback.
- Resume capabilities are random, short-lived, UID/owner-bound server tickets.
  Reconnect requires both a valid Firebase ID token and the current resume ticket,
  rotates the session generation/ticket and restores the persisted checkpoint.
  A ticket is never a substitute for identity verification. Handoff targets remain
  provisional until validated resume transfers ownership from the source.

## Client integration and compatibility

The existing 28 wire message types remain defined once in
`src/shared/protocol.mjs`. Existing `auth_refreshed`, `welcome` and
`handoff_resumed` messages carry server session/expiry metadata; no new message
type is introduced. Root `index.html` remains the generated classic-script
adapter. Root `worker.js`, Durable Object exports, bindings, migration tags,
public HTTP endpoints and `wrangler.jsonc` are unchanged.

Legacy GameRoom protocol version 4 and ZoneRoom version 6 are retained. P0/P1
clients that omit a protocol field are accepted deliberately; explicitly
incompatible versions are rejected. Optional sequence/request IDs suppress
replays when supplied. Compatibility does not make omitted sequence IDs a proof
of replay resistance; authoritative action validation remains necessary.

The client stores resume capabilities only in memory, scoped to the SDK UID and
zone. It schedules verified token refresh, updates server-authoritative session
metadata, and retries an unexpected disconnect only with a valid retained ticket.
Policy rejection fails closed. SDK account changes cancel reconnect, close the
previous account socket and clear previous entitlement UI state. A terminal
connection attempt cannot be revived by a late welcome.

## Regression evidence and phase-sensitive assertions

P1 was a behavior-preserving source extraction, so its exact executable-AST,
103-reference vocabulary and differential-runtime assertions intentionally prove
equality with P0. P2 introduces the explicitly requested security behavior; running
those equality assertions against P2 would demand removal of that security.

`scripts/rebuild/run-history.cjs` therefore executes the complete, unchanged P1
test file on a fresh Git archive of the real committed checkpoint
`10dfaf0aff07d2896c50af06d88502166b16fe9e`. It runs every one of that file's eight
tests, with its actual module graph and bundled runtime. The isolated tree is
generated under ignored `work/checkpoints/p1/` and discarded afterward. It is not
an alternate runtime implementation, fixture replacement or recovery source.

The active runner still executes P0 client/runtime/handoff regressions, legacy
smoke tests, current static contract checks and all new P2 tests against active
production modules. Generated-client, native-module, syntax, browser and Wrangler
dry-run gates separately check current files. Historical success cannot substitute
for active security or behavior tests. No assertion is removed or marked skipped.
`p2-source-preservation.test.cjs` additionally runs nine preservation proofs on
the active tree: original controls, world, economy/movement function bodies,
HTTP routes, schema initialization and client handlers match P1 except narrowly
enumerated security guards, session metadata and identity cleanup. The active
contract suite verifies the canonical 28-type vocabulary, native entrypoints,
production config and every close/error lifecycle. Historical AST equality is
additional evidence, rather than a replacement for these current-source proofs.
Gate counts and results are recorded by the checkpoint report after execution;
this document alone does not claim successful gates or load verification.

The original border-visibility smoke creates two independent player sockets using
one environment token. P0 allowed separate player IDs for that shared UID, which
conflicts with the explicitly required P2 single-owner policy. The offline adapter
therefore issues a distinct, genuinely RSA-signed synthetic Firebase identity for
each independent fixture socket. A handoff target instead reads the UID from the
actual persisted source ticket and retains that same player's identity. Refresh
retains the socket's synthetic UID. Only the exact synthetic environment token is
rewritten; unknown credentials and invalid tickets are not repaired. Both original
legacy files and all their assertions remain unchanged. The actual verifier,
durable owner and handoff code execute normally, and dedicated active P2 tests
continue to prove that a duplicate same-UID socket replaces its previous owner.

## Remaining verification and architecture limits

- Local Firebase tests execute the real signature verifier with real synthetic
  RSA signatures and a synthetic trusted-certificate response. Real Firebase
  project integration, certificate rotation and SDK behavior still need an
  authorized integration environment. ID-token signature verification does not
  consult Firebase account revocation/disabled-user state through an Admin API.
- The logical-server GameRoom coordinates durable session authority. Per-packet
  ownership/checkpoint calls are a potential global bottleneck; partitioned
  routing and scale evidence belong to subsequent phases. No 10,000-concurrent
  claim follows from local security tests.
- The initial authentication deadline uses in-process timers and rechecks server
  acceptance time on inbound/auth processing. Timer delivery during actual
  Durable Object hibernation/restart needs the later reliability work and a real
  runtime failure test. The local transport cannot certify Cloudflare scheduling.
- Clients omitting sequence IDs remain compatible. Durable idempotency of every
  economic action and server-authoritative movement are separate required work,
  rather than properties certified by this P2 parser.
- HTTP payment provider calls and entitlement issuance retain their existing
  behavior in P2. Payment sandbox integration, concurrent VIP admission and
  webhook hardening remain subsequent-phase requirements. Tests use mocks only.
- Rate limits are per socket. Cross-connection/IP abuse controls, broader HTTP
  request limits, observability, backup/recovery and operational rollback still
  require later hardening and release evidence.

## Local checkpoint evidence

The complete P2 gate passed: 102 tests, zero failed/skipped, 43 legacy static
assertions and 69 JavaScript syntax units. Static, generated-client, browser,
secret/config and whitespace checks passed. Wrangler completed only its dry-run
bundle (117.23 KiB, gzip 23.82 KiB). This includes eight historical P1 tests,
active runtime/security/preservation tests, both unchanged legacy smoke tests,
six strengthened handoff-window cases and eight real local Chromium cases.
These local results do not certify production services, devices or capacity.

No production deployment, publication, real payment, secret update or main-branch
merge is needed for these local gates.
