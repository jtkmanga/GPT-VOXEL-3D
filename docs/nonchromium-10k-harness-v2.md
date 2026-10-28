# Non-Chromium WebSocket 10K Harness V2

## What is actually proven

The offline **local WebSocket** run creates 10,000 real TCP/WebSocket client connections to a mock Node.js server on `127.0.0.1`. No Chromium instances, Cloudflare requests, Firebase identities or purchases are involved. This verifies the **load generator**, NOT the real Cloudflare game.

The CI baseline on October 28, 2026 admitted **10,000/10,000 simultaneously connected local sockets** across the harness's 100-zone mapping and observed **230,236 movement ACKs / 230,236 sends, zero errors**. Subsequent changes explicitly record peak authenticated concurrency and ACK latency, which must pass again before merging.

## Files

- `scripts/load/live-10k-v2.cjs`: pooled 40ms scheduler, protocol-6 Firebase-authenticated WS simulation, 10K zone distribution, welcome/ACK RTT and connection/failure reports.
- `scripts/load/loopback-v2-smoke.cjs`: 250 and 10,000 **real local sockets** against a mock authority. No external network.
- `.github/workflows/nonchromium-10k-v2.yml`: offline CI on push; live Staging ONLY on explicit manual dispatch, with quota and cost gates.
- `scripts/load/firebase-load-users.cjs`: existing synthetic Firebase user preparation and cleanup, used only for explicitly approved live Staging runs.

## Important: no Free-tier 10K live run

Cloudflare's current Durable Objects Free limit is 100,000 requests per day (daily reset at 00:00 UTC). **Incoming WebSocket messages count**. A 10K × 5Hz × 60-second movement test alone generates 3 million messages, plus ramp/handshakes/coordinator overhead. The V2 conservative model estimates 16.66 million Durable Objects requests if ramping at 100 connections/sec and holding 60s.

Running this against Free would exhaust the project's request allowance and may disrupt actual game players. The workflow therefore imposes a conservative 75,000-request projected cap and checks daily account usage first, failing closed if the query is unavailable. Neither GitHub pushes nor offline smoke tests send Cloudflare gameplay traffic.

Documentation: https://developers.cloudflare.com/durable-objects/platform/pricing/

## Running the checks from a phone (after merging)

Open GitHub > jtkmanga/GPT-VOXEL-3D > Actions > **Non-Chromium 10K Harness V2**. Normal pushes automatically rerun only the offline tests. Inspect the `nonchromium-v2-local-generator` artifact for sanitized metrics.

For a **small live Staging test** only when credentials and quota have been verified: use **Run workflow**, select `run_mode=staging-live`, `players=100`, `duration_sec=30`, `move_hz=1`, `confirm=RUN-STAGING-100`. The job checks credentials, daily quota, target safety and a projected-usage budget **before** creating Firebase load identities. Cleanup is always attempted.

**For 1,000+ or 10,000 live connections**, first confirm Cloudflare Workers Paid status and any spending limits outside this workflow, and explicitly authorize costs. The workflow requires a separate confirmation string and preconfigured `CLOUDFLARE_DO_PAID_CONFIRMED=true` **only after independent verification**. The existing connector cannot read the billing subscription without an additional Billing Read scope. Do not infer Paid tier from Worker availability.

## Release gates

- The 10,000-connection mock test must report `stats.peakWelcomed=10000`, complete local ACKs and `result.passed=true`.
- Live Staging ramp must explicitly check performance at 100, 500, 1,000, 5,000 and 10,000 using separate tests only when the plan and budgets permit.
- A full 10K **live** proof must include >=10,000 concurrent authenticated connections, scorecards on welcome/ACK percentiles, error/close categories and evidence of Cloudflare-side capacity/quotas.
- No live Production load test is authorized by this workflow. It never runs payment or economy mutations.

All report artifacts exclude Firebase tokens and provider secrets.