# Live 10K WebSocket load test (no Chromium)

This harness is the live-network complement to the existing P8 local synthetic load evidence. It does not claim browser rendering performance.

## What it tests

The live harness creates unique temporary Firebase identities with the Admin SDK, exchanges custom tokens for ID tokens, opens authenticated protocol-6 WebSockets, distributes players evenly across all 100 Free Server zones, and sends current movement packets using `input + frames + seq` at 5 Hz. Temporary Firebase users are deleted in an `always()` cleanup step.

At 10,000 players the deterministic distribution is 100 players per zone, below the current 120-player Zone soft cap.

## Required GitHub environment secrets

The workflow never commits or uploads service-account credentials. Add the appropriate Firebase service-account JSON only as an environment/repository secret:

- `FIREBASE_LOADTEST_SERVICE_ACCOUNT_JSON_STAGING`
- `FIREBASE_LOADTEST_SERVICE_ACCOUNT_JSON_PRODUCTION`

The service account must belong to the exact target Firebase project and have permission to import/delete Authentication users and mint custom tokens. The script refuses a project mismatch.

## Run policy

Use the workflow manually and ramp in order: 100, 1,000, 5,000, then 10,000. The confirmation text must exactly match the selected target and player count, for example `RUN-STAGING-100` or `RUN-PRODUCTION-10000`.

A run passes only when at least 99.5% of clients receive `welcome`, at least 95% of sent movement packets receive self acknowledgements, counted runtime errors are zero, no unintended Zone handoff occurs, and the generator itself remains healthy.

The JSON artifact is sanitized and contains aggregate metrics only. The temporary token manifest is never uploaded.
