# Release gate ledger

## D062 disabled-user sign-in denial PASS; active-session revocation still open — 2026-10-22

Physical mobile Firebase Console evidence shows a staging test user marked
Disabled. A following Android Chrome staging capture attempts Google sign-in and
does not establish an authenticated game session; the client remains on the
unauthenticated staging menu.

Disabled-user sign-in denial: **PASS**.

This does not yet satisfy the active-session revocation criterion because the
recording did not begin with that identity already authenticated in gameplay.
Remaining Gate 3 live proof:
1. re-enable the staging test user;
2. sign in and enter Free Server;
3. disable the same user out-of-band from Firebase Console;
4. return to the still-active game so staging forces token refresh;
5. verify fail-closed/return-to-menu behavior;
6. re-enable the user after the test.

Do not record or commit account identifiers, tokens, passwords or OTPs.

## D061 Gate 4 Multiplayer/Mobile PASS — 2026-10-22

A ~25-second physical Android split-screen staging recording closes the final
line-of-sight requirement. Both sessions are simultaneously live near the same
tree. The remote player name is visible when unobstructed, disappears when the
tree trunk blocks the viewing line, and returns when the player clears the
obstruction.

Together with D057-D060, current live evidence covers:
- two distinct concurrent live Free Server sessions;
- bidirectional/remote player movement observation;
- physical mobile controls;
- live zone ownership handoff without gameplay loss;
- nearby-only name behavior and explicit tree LOS occlusion;
- coin-derived score plus real-time leaderboard propagation across sessions;
- Lucky Box claim/countdown consistency across sessions;
- clean exit/re-entry with peer session preserved;
- owner-approved network-loss policy of fail-closed plus manual server re-entry.

**Release Gate 4 Multiplayer/Mobile: PASS.**

Automatic reconnect is not required by the owner-approved product behavior.
Do not reopen this gate unless multiplayer/mobile source or relevant staging
configuration changes.

## D060 owner-approved network-loss/manual-reentry PASS — 2026-10-22

Post-Deploy-Staging-#14 physical Android split-screen evidence reproduces a real
network interruption. The affected game session fails closed, displays the Game
Server disconnected message, and returns to server selection instead of
continuing with stale game authority.

The owner explicitly accepts manual server re-entry after network loss; automatic
reconnect is not a release requirement. D058 separately proves clean exit and
re-entry to Free Server while the other live session remains active and shared
state remains coherent.

For Gate 4, network recovery is therefore PASS with the owner-approved policy:
**transport loss -> fail closed -> manual server re-entry**. Do not reopen this
sub-gate merely because automatic reconnect is absent.

[P8 Browser Gate #9](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39784840161)
also completed successfully on reconnect source e29e724. Explicit LOS occlusion
behind a wall/tree remains the final open Gate 4 live-evidence item.

## D059 remote movement PASS; live reconnect retest pending — 2026-10-22

A ~127-second physical Android split-screen recording provides explicit
two-session movement evidence: the peer avatar changes position/disappears in
the opposite live session as the other account is controlled. Remote movement
observation: PASS.

The same recording performs a real mobile-network interruption from Android
quick settings. It exposed a client retry-window defect: the previous three
resume attempts covered only ~1.75 seconds, after which the client displayed
the Game Server disconnected alert and required manual re-entry. Therefore that
capture is a valid defect reproduction, not a reconnect PASS.

Source e29e7241e20926fc17ec5832503000c92c2c2923 expands bounded reconnect to
six resume-only attempts totaling about 11.75 seconds. It preserves the original
resume ticket requirement, identity/server/zone fencing and policy-rejection
fail-closed behavior. Source 908864f1ea13acc6b27f8280bdf7263a05ab7c9b extends
staging auto-deploy to this shared client source.
[Deploy Staging Worker #14](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39784978282)
succeeded.

Source 3190954f1758bf25beb4da6fed735111b6e9d342 adds the actual
p2-client reconnect/session tests to P9.
[P9 Staging Browser Gate #11](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39785157294)
completed successfully; its reconnect/session unit step passed before the
existing staging browser fixtures and public probes also passed.

Reconnect remains open until a post-Deploy-#14 physical network-toggle capture
shows automatic recovery without manual server re-entry. Explicit LOS occlusion
behind a wall/tree also remains open.

## D058 concurrent split-screen state consistency — 2026-10-22

A ~70-second physical Android split-screen recording keeps two live staging Free
Server sessions visible at the same time with distinct player identities.

Observed cross-session consistency:
- both sessions show the same real-time leaderboard;
- JTK changes 12 -> 13 and both leaderboards reflect 13;
- หนึ่ง changes 11 -> 13 and both leaderboards reflect 13;
- Lucky Box countdown matches across both views at the same moments and continues
  decrementing consistently.

The left session also intentionally exits to server selection and later re-enters
Free Server while the right session remains live. This is a clean re-entry pass,
not network-reconnect evidence.

Gate 4 therefore has strong live evidence for concurrent sessions, mobile
controls, proximity name behavior (D057), coin/score + leaderboard propagation,
Lucky Box state and clean re-entry. Remaining live evidence: explicit remote
movement observed from the other session, explicit LOS occlusion behind
wall/tree, and transport/network reconnect recovery.

[P8 Browser Gate #8](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39780764343)
also completed successfully for source 9ddd04a after D057; Deploy Staging #13
and P9 #9 were already PASS.

## D057 Gate 4 partial live mobile/multiplayer evidence — 2026-10-22

A 79-second physical Android Chrome recording on live staging shows:
- continuous mobile joystick/gameplay;
- another live remote avatar in the same world;
- the remote name hidden at distance, visible as "jid" when nearby, then hidden
  again after separation;
- score changing 10 -> 11 with the same real-time leaderboard entry changing
  10 -> 11;
- Lucky Box state changing from ready to a 03:59:59 countdown and continuing to
  decrement.

These observations are live Gate 4 evidence for physical mobile controls,
nearby-player rendering/proximity name behavior, coin/leaderboard state, and
Lucky Box countdown. They do not yet prove bidirectional movement from two
separately observed accounts, explicit wall/tree LOS occlusion, network
reconnect, or cross-session item-state equality.

The video also found a staging-only evidence UI false positive: a normal
"Session ownership transferred" close from the old socket after a successful
zone handoff could display SESSION REVOKED after handoff state cleared while the
game correctly continued. Source 9ddd04a135db41dbd5ce2cdeda944a96d2d54df4
removes that reason from revocation labeling. [Deploy Staging Worker #13](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39780764534)
and [P9 Staging Browser Gate #9](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39780764324)
pass. This correction does not invalidate D056, whose revocation evidence also
showed the active client being policy-closed and returned to menu.

## D056 live same-account session replacement/revocation PASS — 2026-10-22

Post-Deploy-Staging-#12 physical Android Chrome evidence shows the D055 live
takeover scenario succeeding: a second authorized staging session acquired
same-account game authority, and the superseded session was closed with policy
failure, returned to menu, and displayed
"STAGING · SESSION REVOKED · TEST PAYMENTS ONLY".

This proves the game server's durable single-owner session replacement and
fail-closed client behavior on real staging/mobile. Same-account server-session
revocation: PASS.

Scope: this is not Firebase Admin refresh-token revocation. Account-level
revocation/disabled-user behavior remains a separate Gate 3 item if required for
the full token/session-revocation requirement.

## D055 session replacement/revocation live-test path — 2026-10-22

Source 00900bd2364cde8727de1b0d9c396e90dc96a858 exposes a staging-only
"SESSION REVOKED" status when the server closes a superseded/no-longer-owned
session, while normal in-progress zone handoffs are excluded from that label.

[Deploy Staging Worker #12](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39776362055),
[P8 Browser Gate #7](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39776362306)
and [P9 Staging Browser Gate #8](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39776362212)
all completed successfully. Public staging probes in P9 also passed.

This is tooling/evidence readiness, not the live Gate 3 pass. The remaining
session-revocation proof is one physical/live same-account two-session takeover:
session B acquires authority and session A is retired/fails closed with the
staging revocation status. Firebase account-level refresh-token revocation remains
a distinct hardening concern and is not claimed by this test.

## D054 Gate 2 Cloudflare/Firebase staging security/isolation PASS — 2026-10-22

Owner Google Cloud/Firebase console evidence shows the staging Firebase Web API
key configured with Website application restrictions limited to the intended
staging workers.dev, firebaseapp.com and web.app origins, with API restrictions
enabled. Physical Android Chrome testing after the restriction continued to pass
Google sign-in and authenticated gameplay. Firebase Authorized Domains were also
limited to the expected staging domains plus Firebase's localhost default.

D050 separately proves App Check registration and Authentication Enforcement with
post-enforcement live login. D053 revalidated the current Deploy Staging #11
revision and isolated ROOM/ZONE Durable Object bindings through read-only
Cloudflare account inspection. Therefore the defined Gate 2 staging
security/isolation evidence is complete on the current deployment: PASS.

Scope note: this pass covers the release-gate requirements recorded for Firebase
account configuration and Cloudflare isolation. It does not claim that the custom
Cloudflare game backend itself verifies App Check tokens, and it does not close
Firebase account/token revocation. Those are separate hardening/session work.

## D053 post-deploy Cloudflare revalidation — 2026-10-22

Deploy Staging Worker #11 changed the live staging revision after D051, so the
affected Cloudflare evidence was rechecked through the authorized read-only API.
Deployment 6da96ec3-dc33-4924-980f-c98c688da3, created
2026-10-21T15:47:10.402247Z, routes 100% of staging traffic to version
38cf0acf-0f59-4a27-b297-088fe0acac9d.

Current settings still require the staging environment and expected staging
Worker name, retain the App Check binding and provider-neutral-test payment
mode, and bind ROOM and ZONE to two distinct namespaces owned by the staging
script. The account script inventory remains exactly the expected staging and
demo scripts. No resource, setting, route, payment mode or production system was
changed. Deployed revision and Cloudflare ROOM/ZONE isolation remain PASS on the
post-refresh deployment. Firebase API-key restrictions, account/session
revocation and later live gates remain separate open evidence.

## D052 live Firebase token refresh — 2026-10-21

Source 36f339f5063d94ed01b3b79abcef2075c685aa6f added staging-only refresh
evidence without exposing authentication material.
[P8 Browser Gate #6](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39628524322)
and [P9 Staging Browser Gate #7](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39628524469)
both passed. Source 6bfc898ce633ed401e4582198b044dd79c4d8f48 then deployed through
[Deploy Staging Worker #11](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39628769690),
which succeeded.

Post-deploy physical Android Chrome evidence showed authenticated gameplay still
active after foreground recovery while the staging banner displayed
"AUTH REFRESHED #2 · TEST PAYMENTS ONLY". This is live evidence that refreshed
Firebase authentication was accepted by the staging game socket and acknowledged
by the server at least twice in the captured session. No token/secret was exposed.
Google/session token refresh: PASS. Token/session revocation remains a separate
open sub-gate.

## D051 Cloudflare deployed revision and namespace isolation — 2026-10-21

Authorized read-only Cloudflare API inspection covered every Worker script in
the account. The account contains gpt-voxel-3d-staging-01 and
voxel-run-v2-demo. Each script binds GameRoom and ZoneRoom to namespaces owned
by that script, and all four namespace IDs are distinct. No script references
the other script's ROOM or ZONE namespace. The staging Worker settings identify
the expected staging origin/environment, contain the App Check binding, use
popup auth and retain provider-neutral-test payment mode.

The live staging deployment sends 100% to Cloudflare version
f6c63718-5dd8-4848-a1d2-9d344368b303. GitHub
[Deploy Staging Worker #10](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39612371440)
job 119264284523 passed the staging-isolation guard, deployed source eb6f7dc and
passed both public probes. Deployed revision and Cloudflare ROOM/ZONE isolation:
PASS. No account resource or setting was mutated during this inspection.

This does not verify Firebase API-key restrictions. Live refresh/logout/token
revocation, two-session multiplayer/physical mobile, payment sandbox lifecycle,
authorized capacity and final review also remain open.


## D050 App Check + live Google sign-in compatibility — 2026-10-21

Source eb6f7dc184e96eaad60c41ad4e9c9c1d0cd10a2d initialized Firebase App Check
for staging with reCAPTCHA Enterprise/Fraud Defense and automatic token refresh.
[P9 Staging Browser Gate #6](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39611885821)
passed, and [Deploy Staging Worker #10](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39612371440)
successfully deployed the same source.

Owner account evidence showed the staging Web app registered for App Check and
Authentication status Enforced. The captured metrics window showed 90% verified
and 10% unverified unknown-origin requests at that time. A post-enforcement
physical Android Chrome recording showed two Google sign-in flows completing,
returning to the staging origin, and authenticated gameplay loading successfully.
This is sufficient live evidence for staging App Check registration/enforcement
and basic Google-auth compatibility. It is not evidence of token revocation or
long-duration refresh behavior, and it does not classify the historical 10%
unknown-origin requests. Keep those as separate follow-up evidence. Do not mark
READY_FOR_FINAL_REVIEW yet.

## D049 P9 gate closed — 2026-10-21

[Run 39525636857](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39525636857),
source 7e6d63e1b2587be10d21400d81b7bf921c83a0a1, completed successfully.
Job 118979497328 (public-staging-read-only) passed both /health and
/staging-config. Job 118979497559 (staging-browser-fixtures) also passed and
produced the fixture evidence artifact. This supersedes the earlier P9 public
403 blocker in D044/D046. The request identity was aligned with the already
successful staging deploy probe; Worker origin/security policy was not relaxed.

Gate 1 browser/P9 public-probe scope is therefore complete on this source.
Remaining open evidence is account security/isolation including API restrictions
and App Check, real Google session/token/revocation behavior, live multiplayer
plus physical-mobile behavior, sandbox payment lifecycle, approved bounded
capacity/load, and the final security/release reconciliation. Do not mark
READY_FOR_FINAL_REVIEW yet.

## D044 public access evidence — 2026-10-19

[Run 39185788160](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39185788160),
source fb3bea56a6f1f2f943e591d69a6a05b2ac4cbd20, job 117847833258:
public `/health` returned HTTP 403 from GitHub Actions. `/staging-config` was not
attempted after failure. No response body/header values published. Exact account
rule/cause unknown; no outage/bot-detection claim. Owner-only endpoint-policy
diagnosis is blocked; no Cloud Browser login retries or access-control bypass.
Existing browser fixture pass is independent of this live-access failure.

## D043 verified result — 2026-10-19

[Run 39185662751](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/39185662751)
at 001cc266fa5d183ff9a268ec947a64f12ecf57ec: P9 browser job 117847453208
succeeded; decoded log reports 11 passed / 0 failed / 0 skipped. This closes the
existing P9 Chromium fixture execution gap. It is not live Google/mobile/payment
or capacity evidence. Public staging job 117847452901 failed at /health; overall
workflow failure must not obscure the separate successful browser job. Safe
HTTP status/type diagnostics added for the next run; live result still pending.

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
