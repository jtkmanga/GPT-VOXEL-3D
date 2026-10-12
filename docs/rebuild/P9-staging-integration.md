# P9 staging integration

P9 continues verified P8 `04327fd32047068ba194c5132a32da34cadf5b58` on
`rebuild-p0-p8`. Production `wrangler.jsonc`, the default generated client and
the authoritative authentication/session/movement/world/economy/VIP modules
remain byte-for-byte unchanged from P8. Every original P0–P8 behavioral test
remains unchanged and runs against the active code. No external resource,
production deployment, Firebase database, DNS route or payment is modified.

## Prepared architecture

The staging build serves its generated mobile/browser client through `ASSETS`
on the same HTTPS Worker origin used by `/play` and `/entitlements`. `ROOM` and
`ZONE` bind locally to the selected staging Worker's new Durable Object
namespace; there are no foreign `script_name` bindings, namespace IDs or routes.
The explicit SQLite class migrations remain `v1`/`v2-zone-room`, scoped to this
new Worker. Identical internal world names are isolated by the separate Worker
namespace; they never identify a production namespace by themselves.

`wrangler.staging.jsonc` is a disabled scaffold, not a deployed environment.
Its planned base name is not asserted to exist or be available externally.
Required origin/Firebase settings are empty. Configured preparation requires a
user-approved name `gpt-voxel-3d-staging-<suffix>` and its exact
`https://<worker-name>.<account-workers-subdomain>.workers.dev` origin.

The trusted staging boundary requires coherent `APP_ENV`, `PAYMENT_MODE`,
Worker name/origin, allowed origin, Firebase project/public configuration and
auth mode before serving assets or routing to storage. Missing settings,
unknown environment values, known production Firebase identifiers or mixed
project/origin settings fail closed. Removing `APP_ENV` while staging selectors
remain cannot fall back to the legacy deployment; a named staging host also
fails closed if all staging selectors are deleted. Private endpoints never enter
Durable Objects from public HTTP/WebSocket routing.

Build/configuration checks reject production routes/accounts, foreign object
bindings, private fields, symlink/hardlink output escapes and contaminated asset
directories. Only generated `index.html` may enter the asset directory, and its
bytes must match the selected public configuration and current source. No
privileged server binding or credential may enter it. The public Firebase API
key is allowed only when it exactly matches that validated staging manifest.
Preparation does not delete or replace stray user files; it refuses them.

## Authentication, persistence and gameplay

The configured staging browser uses Google/Firebase popup or redirect login and
forwards the SDK ID token to the Worker. The server verifies RSA signature,
issuer, audience/project, UID and expiry before authoritative session binding.
It never accepts a browser UID or session owner as identity. Reconnect rotates
the generation and preserves durable player identity; stale sockets, tickets,
expired tokens and saves retain P0–P8 fences.

Firebase is used for identity only in this staging client. Direct Firebase
game-data access is disabled; server-approved player checkpoints, rewards,
coins, Lucky Box and VIP state remain in Durable Object SQLite. Tests cover new
and returning users, retained-socket/constructor recovery, duplicate and failed
saves, retry, stale revisions, malformed state and economy overwrite attempts.

Free remains available without VIP, with the exact product text
`Free Server ฟรีไม่จำกัด` and subtext `ไม่จำกัดผู้เล่น`. This label does not
assert unlimited infrastructure capacity. Movement, proximity/name visibility,
shared coins, one Lucky Box, its collection-start four-hour cooldown and
leaderboards retain their authoritative behavior.

VIP retains 50 THB per 30-day month and at most 100 concurrent players. Staging
uses only the existing provider-neutral signed event boundary. Activation,
expiry, revocation, version/replay fences, rollback, duplicate delivery,
reconnect, concurrent capacity, release and 101st rejection are exercised with
deterministic test events. Every purchase/QR/slip action is disabled in the
staging client; `/verify-slip` is disabled before any provider fetch even if
legacy payment bindings are accidentally present. No real charge occurs.

## Automated browser scope

The default P0–P8 generated client and eight Chromium cases remain unchanged.
Eleven additional staging cases run the generated client with real local
Three.js/WebGL in Android viewport/touch/user-agent emulation. HTTPS staging,
Firebase SDK and WebSocket transport use isolated deterministic fixtures.
Cases cover popup/redirect, same-origin WSS selection, Free/VIP scope,
network interruption/reconnect, stale old socket, reload, foreground refresh,
BFCache-style lifecycle events, account/epoch fencing, payment disablement,
unconfigured/copy-to-wrong-origin rejection and blocked external traffic.

This is not physical Android testing, real Google sign-in, an actual staging
deployment or real WebSocket/Cloudflare recovery validation. SDK errors are
sanitized before client handlers can log token material.

## Reproduce the code-side gate

```sh
npm run check:client
npm run staging:check
npm run staging:prepare
node scripts/rebuild/check-staging.cjs --config work/staging/prepared/wrangler.jsonc --allow-unconfigured --require-assets
npm run staging:dry-run
node scripts/rebuild/gate-phase.cjs P9
```

`--allow-unconfigured` validates an explicitly disabled scaffold; it never
authorizes gameplay or deployment. Configured manifests must pass without it.
The complete gate runs all P0–P9 tests, legacy assertions and browser cases,
static/generated-client/syntax/full-and-staged-diff/secret checks, both Wrangler
bundle dry-runs, staging structural and generated-asset checks. P8's committed
load evidence is checked against its genuine archived P8 source. It is not
relabeled as a P9 load result; real capacity belongs to later P10 validation.

## External configuration boundary and safe next step

No staging Cloudflare/Firebase identity, public project configuration or sandbox
provider is available in this managed environment. The code-side gate uses
fixtures and a disabled scaffold; absent real credentials do not fail that gate.
There is no actual staging URL to open on a phone yet.

The user must select/verify the following outside this rebuild:

| Category | Required configuration and verification |
|---|---|
| Cloudflare | User-owned staging account/profile and its workers.dev subdomain; an approved unused `gpt-voxel-3d-staging-<suffix>` name. Verify the name does not host any production resource. Use a staging-scoped credential through the environment's secure mechanism, not source or chat. No routes/custom-domain/DNS changes are prepared. |
| Firebase | A distinct staging project whose ID identifies staging; its registered Web app's public `apiKey`, `authDomain`, `projectId`, `appId`, optionally matching `messagingSenderId`. Do not reuse any production project, key or Web-app identifier. |
| Google auth | Enable Google in the staging Firebase project, configure support/consent/test users as applicable, and authorize the selected staging Worker hostname in Firebase Auth. Configure the staging project's OAuth redirect handler where required. Choose `popup` or `redirect` locally and validate real Android behavior later. |
| Entitlement signing | A fresh staging-only `PAYMENT_WEBHOOK_SECRET` of at least 32 UTF-8 bytes supplied using secure server-secret provisioning. Never place it in the public manifest, Wrangler vars, assets, logs, documentation, Git or chat. A real sandbox provider adapter/signature translation still needs provider selection and sandbox credentials; none is fabricated. |
| Network/testing | Actual deployed Worker access to Google's public token certificates and the configured Firebase client services; a permitted test environment for external integration. The current managed environment has no Cloudflare/Firebase identity and restricted outbound access. |

First create a local ignored public manifest at
`work/staging/public-manifest.json` using values from the approved staging
resources. Its exact schema is:

```json
{
  "environment": "staging",
  "workerName": "<approved-gpt-voxel-3d-staging-name>",
  "workerOrigin": "<actual-HTTPS-workers.dev-origin-for-that-name>",
  "firebase": {
    "apiKey": "<public-staging-Web-app-API-key>",
    "authDomain": "<staging-project-id>.firebaseapp.com",
    "projectId": "<staging-project-id>",
    "appId": "<public-staging-Web-app-ID>"
  },
  "authMode": "popup"
}
```

These placeholders deliberately cannot pass configured validation. No real
values are invented. With the actual public values locally supplied:

```sh
node scripts/rebuild/prepare-staging.cjs --config work/staging/public-manifest.json
node scripts/rebuild/check-staging.cjs --config work/staging/prepared/wrangler.jsonc --require-assets
npm run staging:dry-run
```

Those commands only prepare/check/bundle locally. Stop there until external
resource ownership and isolation are proven and the required user-owned staging
configuration is supplied. Only after that verified staging deployment should a
fresh staging signing secret be provisioned through a secure Worker-secret
mechanism and the actual HTTPS URL tested on the user's Android phone. Firebase
Admin/private credentials and production payment credentials are not required
for the implemented identity/provider-neutral boundary.

Operational limitations from P8 still apply: real token revocation/account
disable policy, real Cloudflare restart/regional/network behavior, append-only
receipt growth and bounded delayed passive eviction during an unavailable
remote RPC require external/operational validation. No production readiness or
physical concurrency claim is made by P9.
