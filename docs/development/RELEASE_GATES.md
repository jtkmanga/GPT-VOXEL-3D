# Release gate ledger

## D042 update — 2026-10-19

P9 workflow added for development only; unchanged browser scenarios, no secrets
or deployment. Await actual CI outcome before claiming browser success. Fixture
auth/transport and mobile emulation do not close live gates. Owner has stopped
Cloudflare Cloud Browser login attempts; do not retry this blocker. Public
staging `/health` and `/staging-config` reads returned HTTP errors from the local
execution environment; this does not prove the service is down. Account-only
namespace isolation, deployed-source mapping, API restrictions and App Check
remain unverified. No public endpoint result substitutes for those settings.

## D041 update — 2026-10-19

Verified [GitHub run 39177769472](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39177769472),
job 117823884798, source fbd7f601be4aba01e1ec747cfd1c6be9de440c3a:
Chromium installation and `python tests/rebuild/p1-browser.py` succeeded.
This supersedes the P8 installation blocker below. Source review confirms real
keyboard assertions remain with synthetic active-game setup and cleanup.
The workflow does not run `tests/rebuild/p9-browser.py`; generated staging browser
coverage remains pending. Firebase/transport fixtures are not live login,
multiplayer, payment, physical mobile or capacity evidence. Artifact contents
were not retrieved; no per-case count is claimed from job metadata.
Cloudflare read-only recheck still reaches `/login`; no authenticated inventory.
No callable Firebase/Cloudflare connector tools are exposed in this session.
Gates 2–7 retain D040 prerequisites. Overall NOT READY. Next safe browser task:
P9 scenarios, without repeating completed P8 recovery. Historical ledger follows.

Assessed 2026-10-18 (Asia/Bangkok), source
fb179fb92ff1b491528c102beb6235ab6c12a09a. Status: NOT READY.
This ledger is a readiness assessment, not a pass certificate.

| Gate | Current evidence and blocker | Safe continuation / owner prerequisite |
|---|---|---|
| 1 Browser | D038 current-source local suite passes, but is not browser evidence. D039 restored isolated Playwright 1.64.0; browser installation outcome recorded in STATE.md. No current-source browser pass. | Run existing scenarios unchanged only after a working browser is available. Emulated mobile/fixture authentication remain separate from physical/live tests. |
| 2 Cloudflare/Firebase | Fresh Cloudflare navigation redirects to sign-in; no account resource inventory obtained. Firebase plugin found but not installed/connected. Committed staging config is a disabled scaffold; structural check passes, not live isolation. | Owner-authorized account access is needed to read deployed revision, namespace isolation, Firebase Rules, API restrictions and App Check. Firebase connection suggested; never send private credentials in chat/Git. |
| 3 Google/staging | No currently verified staging target/project pair or authorized live account session. Earlier deployment notes are historical only. | Establish gate 2 evidence and approved test identities/target, then real sign-in and token/session/revocation checks. No production credential testing. |
| 4 Multiplayer/mobile | No verified live target, two authorized test sessions or physical mobile evidence. | After gate 2/3, test movement, reconnect, zones, coins, chest, leaderboard, line-of-sight names and mobile controls. Local fixtures do not close this gate. |
| 5 VIP/payment sandbox | Prepared 2C2P adapter remains disabled; merchant capabilities, renewal/cancellation/refund policy and actual sandbox lifecycle are unverified. | Dedicated sandbox merchant, secure credential provisioning and explicit sandbox activation/transaction approval required. Do not set verification flags merely to unblock tests; no real charge. |
| 6 Capacity | Historical 10,000-session local simulation is not live CCU evidence. No verified approved load target/budget/stop thresholds. | Owner approval for isolated target and bounded load; inspect server/network/database before each increment. No production traffic or paid resources. |
| 7 Final security/release | Incremental Git audit and source checks available; live auth/rules/payment/authority/operational evidence incomplete. | Reconcile source/deployed revisions with all gates, resolve blockers, then final review. No READY_FOR_FINAL_REVIEW yet. |

Gate 5 details: docs/rebuild/2c2p-sandbox-preparation.md. Its historical
browser/deployed-staging statements are not new verification of this source.
Gate 6 details: docs/rebuild/P8-release-candidate.md; source-specific synthetic
measurements must not be relabeled current cloud capacity.

No account settings, permissions, resources, payment flags or production changed.
Do not repeat unchanged ledger commits. Continue only when new evidence, access,
tooling recovery or a gate-relevant defect warrants work; retain the existing task.

## D040: owner-supplied console evidence, 2026-10-18

Evidence below was visually inspected in owner screenshots from Android Chrome
(09:42–10:15 Asia/Bangkok). It is not direct agent account access, an exported
deployment manifest, or proof that the deployed artifact matches this source.
Do not publish original screenshots, account identifiers, emails or key values.

- Cloudflare staging worker settings show APP_ENV staging, payment mode
  provider-neutral-test, popup authentication, coherent staging origins and a
  staging Firebase project/public web configuration. ROOM and ZONE Durable Object
  bindings exist, but their target namespace identity/isolation was not visible.
- Deployment screenshot shows active version prefix 908ab1dd, manual deployment,
  100% traffic and a relative age of four days. No Git SHA/artifact correspondence
  is established. Observability is disabled; do not enable it implicitly.
- Firebase staging screenshots show Google provider Enabled and the staging
  workers.dev hostname in Authorized domains. These are configuration evidence,
  not a complete live OAuth/session/revocation test.
- Both Realtime Database and Firestore show their create-database landing pages.
  No existing database Rules were available in this project's screenshots.
  A Rules screenshot from the separate Lucky Game project is explicitly excluded
  from staging evidence. Do not create a database or copy those rules to fill a gate.
- The staging web app shows App Check Register with no attestation provider;
  Authentication shows Unenforced. Other listed APIs request app registration;
  this does not establish that those services are provisioned. API-key restrictions
  remain unverified. App Check integration/enforcement remains an unresolved item.
- Phone screenshots show the staging banner, apparent signed-in UI and rendered
  mobile gameplay/controls. They do not prove movement/reconnect/zone transitions,
  reward authority, multi-user consistency, VIP lifecycle or capacity.

Source reconciliation: scripts/rebuild/build-staging-client.cjs replaces the
legacy Firebase configuration, initializes Firebase Auth conditionally and replaces
database.ref with a throwing guard. src/client/staging-runtime.js supplies the
staging runtime; src/worker/game-room.mjs uses ctx.storage.sql and transactional
Durable Object storage. The legacy authored client has Firebase database code;
it must not be confused with the generated staging artifact. Missing Firebase
databases alone are therefore not a reason to provision new resources. Confirm
deployed artifact correspondence and actual storage bindings before closing the
Rules/isolation portion of gate 2. No claim about production configuration follows.

Gates 2–4 now have partial owner-supplied evidence, superseding the table's earlier
absence of any target/project/mobile observations. All seven gates remain open.
Next: authorized read-only deployed revision/namespace and API restriction checks;
browser recovery; then approved real identity and multiplayer tests. Gates 5/6
still require their existing sandbox/target/budget prerequisites.
