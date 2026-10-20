# Staging security review — 2026-10-20

Source: 4bb729b27a52c3ba9b8a76d6ad956a95d85781cd. Partial source review,
not final release approval. Owner owns P9 follow-up; do not rerun it here.

## Verified deployment evidence

GitHub run 39443514996, job 118699282415 passed staging structural isolation,
deployment and both public probes. Worker gpt-voxel-3d-staging-01 version
cd60e642-bce6-48ea-aa07-e4f26919e08c corresponds to that workflow's source.
This establishes deployment provenance, not account-wide namespace isolation.

## Source findings

- firebase-auth.mjs checks RS256 signatures using Google's certificates, project
  audience/issuer, subject, expiry, issued-at and authentication time. No Firebase
  disabled-account or token-revocation lookup is implemented in this verifier.
  Local session replacement/revocation is a different mechanism. The live gate
  must explicitly validate the required account revocation policy.
- room-security.mjs checks token expiry and authoritative session ownership,
  then rechecks expiry after awaited RPC before dispatch. Frame size and pending
  packet limits are enforced. Source inspection is not live abuse/load evidence.
- staging-boundary.mjs requires consistent staging origin/project and ROOM/ZONE
  bindings. Public health/config GET exceptions do not exempt protected routes.
- router.mjs disables real slip verification in staging. payment-events.mjs
  verifies bounded HMAC-signed events, timestamp age and exact product/price/
  currency/lifecycle schema. twoc2p-sandbox.mjs requires explicit sandbox gates.
  These controls do not establish merchant configuration or real sandbox success.

## Remaining evidence and dependencies

Local validation: `node --test tests/rebuild/p2-security.test.cjs
tests/rebuild/p8-security.test.cjs tests/rebuild/p7-vip.test.cjs` passed 65/65,
zero failures/skips. This supports the reviewed source controls only.

1. Account owner: read-only confirmation that ROOM/ZONE namespaces belong only
   to staging; Firebase API restrictions and App Check registration/enforcement.
   Do not provision Firebase databases just to obtain Rules: staging uses DO SQL.
2. Real Google/session gate: approved staging test identities, sign-in/out,
   refresh/expiry and disabled-account/revocation behavior. Do not publish tokens.
3. Multiplayer/mobile: after identity/isolation evidence, two real sessions and
   a physical phone covering movement, reconnect, zones, rewards and visibility.
4. VIP: approved sandbox merchant/lifecycle configuration; keep adapters disabled
   until prerequisites are satisfied. No real transactions.
5. Capacity: approved target, maximum load, budget and stop thresholds before
   traffic generation. No 10,000-player claim.

Final review remains blocked on those live results. No external settings,
payment flags or production resources changed by this review.
