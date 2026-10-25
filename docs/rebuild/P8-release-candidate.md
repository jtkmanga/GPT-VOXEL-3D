# P8 release-candidate validation

This phase continues verified P7 `5d5c7a499d872f1ca7ed9762860ceb4d887f0701`.
P0–P7 commits remain ancestors. Work stays on `rebuild-p0-p8`; main baseline
is `f98aa9a044616b1b965b889cf0c02a0d3b041f65`. No production deployment,
publication, payment, production secret, external load target or real merchant
integration is used.

## Lucky Box collection-time cooldown

The supplied P8 product rule starts the global four-hour cooldown at successful
collection, rather than at reward delivery. The same SQLite transaction locks
the collector's 90-second spin right, advances the spawn cycle, fixes the global
deadline and persists the claim receipt. `claim_cycle` preserves the collected
resource's reward uniqueness. Delayed spin cannot extend that deadline or
advance the spawn cycle again. Abandonment releases only spin ownership.

Coins retain their 200-resource maximum, shared authoritative positions,
one-minute respawn and resource-cycle reward receipts. They have no countdown
UI. Each Free/VIP world retains one logical Lucky Box, shared persisted spawn
coordinates and avoidance of current authoritative players at respawn.

The additive migration recognizes a pending P5 claim by its durable spin
deadline, infers collection time and fixes the original four-hour cooldown.
Repeated restart does not renew either deadline. Contradictory legacy state
fails closed. Already completed historical cooldowns remain intact. Claim/spin
storage failures roll back score, resource transitions and receipts together;
identical retries commit once.

Every prior P4 behavioral case remains active. The four affected timing
expectations are strengthened to the supplied collection-time product rule.
The complete unchanged original P4 economy/client suites additionally execute
against their genuine P4 Git tree. Phase-bound source-preservation proofs run
unchanged against their corresponding checkpoint; all behavioral/security
regressions also run against the active P8 code.

The client keeps the global four-hour timer visible during the shorter spin
right. Lower-cycle and conflicting same-cycle cooldown snapshots cannot move
the chest or reset the deadline. Device timer expiry alone cannot make it
collectible; an authoritative active snapshot is still required.

Client time uses a monotonic performance anchor after its first server sample.
Older or duplicate samples and device wall-clock jumps cannot rewind or advance
the countdown. Per-resource snapshot timestamps also reject an old same-cycle
cooldown after authoritative respawn. Coin activation uses the accepted clock.

## Security and recovery evidence

The actual bundled Worker, real RSA/HMAC verification and native SQLite are
tested with generated synthetic signing material and deny-by-default network
adapters. Tests cover authenticated UID/session ownership; expired/invalid
tokens; replaced/reconnected generations; stale/out-of-order packets and saves;
bounded movement intent and physics; proximity/zone fan-out; name sanitization,
escaping and world-only white nameplates; economy/reward replay receipts;
transaction failures; Free/VIP isolation; payment forgery and signed event
idempotency; revocation/expiry; 100 VIP seats, concurrent races and seat release.

P8 adds 64 deterministic malformed protocol attempts, binary/UTF-8 frame
rejection after reconstruction, 54 public attempts to reach private Durable
Object endpoints, 32 tampered signed provider bodies, retained-socket coordinator
and zone/VIP reconstruction, persistent movement recovery, coin receipts,
Lucky Box claim/cooldown recovery, and entitlement/seat recovery. Actual SQLite
triggers inject checkpoint, activation and revocation failures for atomic
rollback and exact retry checks. Client tests exercise generated request fields,
stale resource snapshots, UI scope, escaped names and forged local state without
granting authority to browser values.

Audit hardening rechecks token/lease expiry after delayed authority responses,
fences authentication refresh/new admission after asynchronous verification and
prevents a closed attachment from being restored. Free room visibility checks
its durable generation and current authentication. Expired Free/Zone transports
are reclaimed before they can exhaust an admission bound. Retired Free session
evictions are recorded transactionally with generation replacement and retried
by a durable alarm; explicit handoff-source eviction uses the same exact-owner
fence while preserving target acknowledgement before source close.

The secret/config check scans the complete committed rebuild and pending source,
not just a clean HEAD diff. It rejects credential patterns/files, changed
production Wrangler configuration and privileged server bindings in browser
source. Negative fixtures prove rejection without printing synthetic values.
The existing public Firebase browser API key is allowed only because it is
unchanged from main; it is not a privileged server credential.

## Reproducible local load validation

Run from this repository after installing the pinned development dependencies:

```sh
node --expose-gc scripts/rebuild/load-local.cjs --levels=100,1000,10000 --rounds=3 --batch=50 --max-runtime-seconds=1800 --out=work/load/p8-local.json
node scripts/rebuild/load-evidence.cjs work/load/p8-local.json
node scripts/rebuild/gate-phase.cjs P8
```

The load harness executes actual Worker routing, token signatures, durable
ownership/checkpoint SQL, protocol parsing, authored movement and visibility.
All admitted synthetic sessions stay simultaneously active across three movement
rounds. Players are distributed across the existing 100 zones; no attachment
position is manufactured by the load script. Every update must be acknowledged;
persisted and attachment positions must agree; reward/resource counts must not
change. The report measures admission/update processing, approximate transport-
free latency, fan-out/RPC/message/byte counts, errors, memory and CPU observations.
Its Worker/shared source SHA-256 must match the source under the final gate.

The upper run exposed unnecessary global leaderboard amplification: admission
sent the same top ten to every occupied zone for every newly registered player.
P8 suppresses identical admission broadcasts using a transient delivery cache.
Each welcome still reads the current authoritative board; changed ranked names,
economy updates and the first bootstrap after restart synchronize normally.
A regression exercises unranked joins, ranked name changes and restart delivery.

This is an in-process simulation with mocked WebSocket transport and local
SQLite. It creates no real TCP/WebSocket connections, no Cloudflare workload and
no production traffic. The clock offers 5 Hz synthetically; measured wall-clock
throughput is processing throughput, not proof of sustained 5 Hz real delivery.
Cloudflare isolate scheduling, cross-region RPC/network latency, hibernation,
billing limits, mobile rendering and real browser concurrency are not modeled.
Even a passing 10,000-session simulation does not demonstrate 10,000 real
concurrent production players or production readiness.

## Remaining external validation and operational limits

- A real payment provider adapter, merchant account, server-only credential
  provisioning and provider sandbox signature/lifecycle tests are still needed.
  VIP checkout remains disabled. The neutral product is 50 THB per 30-day month
  and supports one immutable subscription ID per UID; provider-specific
  subscription replacement/calendar billing needs an explicit integration.
- Real Firebase SDK/Google sign-in, revoked-token/disabled-account policy and
  deployed Firebase access rules require external validation. The server checks
  ID-token signature/claims/expiry; it does not perform per-packet account or
  token revocation lookups.
- Test restart reconstructs Durable Object classes over preserved local SQLite
  and retained socket attachments. Real process crash, Cloudflare storage
  durability, service outage, region failure and deployment migration recovery
  require a separately provisioned non-production environment.
- An unavailable inter-object RPC cannot instantly close a remote socket.
  Durable generation checks immediately reject its mutations; exact-generation
  eviction retries each second after recovery. Passive cached visibility can
  persist until delivery or the existing 120-second lease expires during a
  prolonged partition. The retry ledger survives constructor restart.
- Resource/payment receipts and retired session generations are retained to
  preserve replay fences. Their append-only growth needs operational monitoring
  and a retention/archive design that cannot permit duplicate rewards. No
  replay-protecting history is silently deleted during this rebuild.
- Free's requested unlimited product label is not a measured unlimited capacity
  guarantee. Existing per-zone/legacy transport bounds and central shared
  economy/leaderboard costs remain; concentrated joins and real network scale
  need additional controlled infrastructure tests.

The final gate runs the full P0–P8 suite, all 43 legacy assertions, isolated
Chromium, generated-client/static checks, all JS syntax units, full/staged diff
checks, secret/config scan, load-source evidence and Wrangler bundle dry-run.
Wrangler is never invoked for an actual deployment.

## Completed load measurements

| Synthetic sessions | Admitted | Movement ACKs | Admission seconds | Updates/s | Movement p95 ms | Sampled peak RSS MiB |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 100 | 300/300 | 0.332 | 1874.995 | 11.602 | 110.7 |
| 1,000 | 1,000 | 3,000/3,000 | 4.238 | 1756.760 | 16.250 | 239.5 |
| 10,000 | 10,000 | 30,000/30,000 | 626.550 | 230.041 | 171.305 | 641.9 |

All levels completed with zero detected errors, timeouts, closed sessions, visibility violations, state/save inconsistencies or external network requests. Detailed CPU/RPC/fan-out/byte counts and source fingerprint are committed in `P8-load-results.json`. These are synthetic local measurements; no real 10,000-player capacity claim is made.
