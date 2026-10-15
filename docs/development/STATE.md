# Current development state

Updated: 2026-10-15 (Asia/Bangkok).
Branch: `development/voxel-continuous`.
Starting source commit: `2ab4b0b3deeaad5b8ebdba991ae048daff125e37`.
Task: D012 — reset interrupted input on blur and hidden document.
Status: completed; external D003 gates remain blocked.

## D012 completed (2026-10-15)

- Reproduced held movement/jump and camera gestures surviving window blur or document hiding: two new behavioral tests failed before the fix. Existing touch cancellation correctly ignores unrelated fingers and releases its owning joystick.
- Added resetInterruptedInput within setupControls in src/client/controls.js, registered for blur and hidden visibilitychange. Clears keyboard/joystick input, touch/mouse camera ownership and unsent jump intent/held flags; leaves authoritative physics and already-sent frames intact. Regenerated index.html.
- Added input-lifecycle.test.cjs (3 regressions): interruption, stale follow-up moves, fresh gesture recovery and touch ownership. The first full run found that the P0 document fixture lacked addEventListener; extended it with the existing eventTarget implementation, preserving every assertion. Targeted P0/input suite passed 7/7, zero failures/skips.
- Full npm test passed after the fixture fix. check-static.cjs, check-syntax.cjs (138 files), build-client.cjs --check, check-secrets.cjs (157 files), git diff --check passed. Node commands use NODE_PATH=/workspace/scratch/e72adbdaf5bc/voxel-dev/node_modules.
- Resumed the uncommitted D012 work after rechecking public visibility and unchanged HEAD/refs; did not repeat a completed task. Incremental scan at this source inspected 17 objects (1 commit, 7 trees, 9 blobs), no new archives/gaps. Matches were unchanged Firebase public config and a pre-existing synthetic handoff token; prior scope limits remain.
- This completes focus-loss handling only. Menu interruption is the next bounded task; real browser/app-switch and mobile touch validation remain pending. No production/account/deployment changes.

## D011 completed (2026-10-15)

- Reproduced missing nested chest disposal during replacement and retained chest objects after menu return. Added clearLuckyBoxMesh to secure-menu-economy.js: traverse chest descendants, deduplicate geometry/materials, preserve retained scene owners, dispose unused resources and clear the box reference. Called from secure spawn replacement, menu return and world.js map initialization. Regenerated index.html.
- Extended static-map-lifecycle.test.cjs with three chest replacements, repeated menu cleanup, fresh hidden/inactive box state, and retained shared-resource protection. Lifecycle/P8 client suite: 15 passed, zero failed/skipped, including unchanged countdown/authoritative-state checks.
- Full-suite runs exposed missing dependencies in isolated handoff fixtures. Updated handoff-invariant.cjs to load the actual cleanup helper when present in the tested checkpoint and initialize luckyBox=null; staging-client-fixture.cjs now initializes the same world state. No assertions weakened or skipped. Historical checkpoints without the helper remain supported.
- Full npm test passed after fixture fixes. Static, syntax, generated-client, current-file secrets and whitespace checks passed. Node commands use NODE_PATH=/workspace/scratch/e72adbdaf5bc/voxel-dev/node_modules.
- Incremental audit: 14 objects (1 commit, 7 trees, 6 blobs) after 6f7da69; two detections of one unchanged public Firebase web assignment, no new archives/gaps or confirmed privileged credentials. Other advertised refs unchanged; prior audit limitations remain.
- These are local resource lifecycle/logic checks, not measured browser GPU memory, physical-mobile, live staging or capacity evidence. External blockers unchanged. No production/account/deployment changes.

## D010 completed (2026-10-15)

- Reproduced missing coin geometry/material disposal through the authored rebuildServerStaticMap path: expected one disposal event but observed zero. The second new test initially also failed because the cleanup entry point did not yet exist.
- Added clearCoinMeshes in src/client/world.js and used it before spawning the new map batch; regenerated index.html. Deduplicates shared geometry/materials and preserves resources referenced by retained scene descendants. Snapshot handlers remain unchanged because they mutate existing coin meshes instead of replacing them.
- Extended tests/rebuild/static-map-lifecycle.test.cjs with three repeated map rebuilds, 200 unique coin IDs, detached old meshes, shared-resource disposal once, new mesh ownership, repeated cleanup, snapshot identity/visibility/position updates and retained shared owners. Lifecycle/P8 client suites: 13 passed, zero failures/skips.
- Full npm test passed on this modified source. check-static.cjs, check-syntax.cjs (137 files), build-client.cjs --check, check-secrets.cjs (156 files) and git diff --check passed. Node commands used NODE_PATH=/workspace/scratch/e72adbdaf5bc/voxel-dev/node_modules.
- Incremental audit: starting source minus 44ae105 contains 14 objects (1 commit, 7 trees, 6 blobs), no new archive members/gaps. Two detections on the same unchanged public Firebase assignment were reviewed privately; no confirmed new privileged credential. Other refs unchanged; previous audit limits remain.
- Local Three.js lifecycle evidence only, not actual GPU memory measurements, mobile stability or live multiplayer evidence. No production, deployment, account, payment or resource provisioning changes.

## D009 completed (2026-10-15)

- Reproduced missing resource disposal in clearStaticMapObjects: both new lifecycle tests failed before the fix. Removing scene objects alone did not dispatch geometry/material disposal.
- Updated src/client/world.js to deduplicate removed geometries/materials, preserve resources referenced anywhere in the retained scene, and dispose remaining resources once. Supports shared materials and material arrays; existing map/occluder/collision-array cleanup remains. Regenerated index.html.
- Added tests/rebuild/static-map-lifecycle.test.cjs: three generated-map build/cleanup cycles, duplicate entries, repeated empty cleanup, shared resources retained under a scene group, and untouched ground resources. Targeted lifecycle/P6/P8 suite passed 26/26, zero failures/skips.
- Full npm test passed on the modified source. check-static.cjs, check-syntax.cjs (137 files), build-client.cjs --check, check-secrets.cjs (156 files) and git diff --check passed. Commands used NODE_PATH=/workspace/scratch/e72adbdaf5bc/voxel-dev/node_modules. The earlier full-suite process result was unavailable after interruption; reran it instead of assuming success.
- Incremental credential audit from 250005d to starting source: 10 objects (1 commit, 5 trees, 4 blobs), one unchanged synthetic test-token candidate, no new archive members/gaps. All other advertised refs unchanged. No confirmed new privileged credential; prior bounded audit limitations remain.
- Evidence establishes local Three.js disposal lifecycle, not measured GPU memory recovery or mobile stability. Static map meshes are flat and untextured; this change does not claim general texture/group ownership management. No production/account/deployment changes. External gates remain pending.

## D008 completed (2026-10-15)

- Added two regressions to tests/rebuild/p6-client.test.cjs, with an independent exhaustive raycast oracle (no shortlist). The first covers 27.999/28/28.001 distance, a large nonuniformly scaled wall whose center is beyond the query radius, rotation and geometry beyond the target. The second runs the authored map generator with three deterministic seeds and compares 192 sampled camera/target pairs across its geometry, requiring both blocked and clear outcomes.
- No disagreement or runtime defect reproduced. Gameplay source and generated client remain unchanged. Mutation check temporarily removed the object-radius contribution from shortlist selection; the new scaled-wall case failed as expected, then the original source was restored. No weakened assertions or committed mutation.
- NODE_PATH=/workspace/scratch/e72adbdaf5bc/voxel-dev/node_modules node --test tests/rebuild/p6-client.test.cjs tests/rebuild/p8-client.test.cjs: 24 passed, zero failures/skips. node --check tests/rebuild/p6-client.test.cjs, check-secrets.cjs and git diff --check passed. Full npm test was not rerun for this test-only change; prior D007 full-suite evidence remains attached to its source revision.
- Incremental scan: 15 objects (1 commit, 7 trees, 7 blobs), no new archive members/gaps. Three candidates reviewed as unchanged Firebase public web configuration (two matches on one assignment) and an unchanged synthetic token fixture; no confirmed privileged credential. Other advertised refs unchanged. Prior coverage limitations remain.
- This is local Node VM/Three.js geometry evidence, not browser rendering, mobile FPS, live security or capacity evidence. External blockers unchanged; no production, payment, account or deployment action.

## D007 completed (2026-10-15)

- Added a lazy, reusable per-frame shortlist in wheel-frame.js and reset it alongside static map cleanup in world.js; regenerated index.html. All static geometry (including windows and tree leaves) remains eligible. A camera-centered sphere enclosing every in-range label conservatively rejects distant geometry using transformed bounding spheres before exact segment raycasts.
- Added two behavioral regressions in p6-client.test.cjs. For 20 visible labels and one distant object: one world-matrix update and zero raycasts per frame; moving the object into the sightline yields one update and 20 raycasts with every label hidden. Invisible objects leave the shortlist; real map cleanup clears retained references. Tree-sized geometry blocks and removal restores names. Existing D006 moving-wall/behind-target checks remain passing.
- NODE_PATH pointing at the existing voxel-dev/node_modules: node --test tests/rebuild/p6-client.test.cjs tests/rebuild/p8-client.test.cjs passed 22/22, zero failures/skips. npm test passed including historical and legacy suites. check-static.cjs, check-syntax.cjs, build-client.cjs --check, check-secrets.cjs and git diff --check passed.
- Incremental secret audit of starting source minus 6ea18e9 inspected 14 objects; three candidates reviewed as unchanged Firebase public configuration (two detections of the same assignment) and an unchanged synthetic test token. No new archives/gaps or confirmed privileged credentials. Other advertised refs unchanged. Prior audit limits remain.
- This reduces repeated geometry traversal; worst-case nearby geometry still requires exact per-label tests. Local operation counts are not browser/mobile FPS or live capacity evidence. No production/account/deployment changes. External D003 gates remain blocked.

## D006 completed (2026-10-15)

- Reproduced a client defect: a nearby remote nameplate remained visible through an opaque wall. Existing code checked gameplay/pause, distance and projected screen bounds but not occlusion. New real Three.js geometry regression failed before the fix (block instead of none).
- Added camera-to-label ray intersection against visible static map geometry, limited to the segment before the remote label and only after distance/frustum checks. Local label styling and menu/pause behavior are unchanged. Regenerated index.html from source.
- Regression checks wall occlusion, recovery when the wall moves aside, and visibility when geometry lies behind the target. Existing plain-white/transparent-style, gameplay-only, range and markup-escaping assertions remain intact.
- P6/P8 client suites: 20 passed, zero failed/skipped. Full npm test passed including historical and legacy suites. check-static.cjs, check-syntax.cjs and build-client.cjs --check passed. check-secrets.cjs and git diff --check passed before publication.
- Initial build failed because this isolated checkout had no local acorn dependency; reran successfully with the existing NODE_PATH dependency directory. No packages or cloud resources were created.
- Incremental audit: current source minus 4441489f2b35e36217a8bc7a7a32f0569a3554c3, 10 objects (1 commit/5 trees/4 blobs), zero findings/gaps/new archive members; other advertised refs unchanged. Existing public Firebase configuration is unchanged. Prior audit limits remain.
- Local VM/Three.js tests establish logic only, not rendered browser/mobile evidence. Per-label map intersection work requires mobile performance assessment; D007 will bound this work locally before live checks. No production/deployment/account changes.

## D005 completed (2026-10-15)

- Reviewed existing coin replay and restart coverage. Added one combined bundled-Worker regression to tests/rebuild/p4-economy.test.cjs for a discarded post-commit acknowledgment, disconnect, coordinator restart, ticket resume, exact respawn boundary and old request replay.
- Assertions verify restored score, unchanged coin row/action count after replay, exactly 200 unique coin identities, and successful collection by another UID using the same request ID with one new receipt and a fresh 60-second cooldown. No runtime defect was reproduced; gameplay implementation is unchanged.
- `NODE_PATH=/workspace/scratch/e72adbdaf5bc/voxel-dev/node_modules node --test tests/rebuild/p4-economy.test.cjs`: 29 passed, 0 failed/skipped. All evidence is local SQLite/transport/identity fixtures; ACK loss is simulated by discarding the received messages, not an actual network outage.
- Incremental secret scan from 9a45c879f81a106ca6fbf8a34fe105f42bb3c237 to starting source: 10 new objects, no archive members/gaps; one reviewed pre-existing synthetic signing fixture in p7-vip.test.cjs:12, no confirmed privileged credential. Other refs unchanged. Prior scan limitations remain.
- check-secrets.cjs, node --check on changed test and git diff --check passed. No production/account/deploy/payment changes. External gates remain blocked; continue safe local work.

## D004 completed (2026-10-15)

- Reviewed current VIP entitlement/seat/reconnect enforcement and existing P7 tests. No runtime defect reproduced in this scope.
- Added two bundled-Worker regressions in tests/rebuild/p7-vip.test.cjs: disconnect with a saved ticket, verify entitlement active 1 ms before expiry, advance to exact expiry, optionally restart both coordinators, reject both resume-ticket and fresh VIP login, assert zero occupied seats, and allow the same identity into Free.
- `NODE_PATH=/workspace/scratch/e72adbdaf5bc/voxel-dev/node_modules node --test tests/rebuild/p7-vip.test.cjs tests/rebuild/p7-client.test.cjs`: 42 passed, 0 failed/skipped. Uses synthetic identity, in-memory storage/transport and fabricated signed events; no provider calls or real payment adapter activation.
- Incremental credential audit included 9a45c879f81a106ca6fbf8a34fe105f42bb3c237 and excluded 7b7b64b4a7802d8ac80c743407cc458589c0c748: 14 new objects (1 commit, 7 trees, 6 blobs), no findings/gaps/new archives. Other advertised refs unchanged. Prior audit limitations remain.
- check-secrets.cjs, node --check on changed test and git diff --check passed before publication.
- No gameplay implementation, production configuration, account permission or payment behavior was changed. Live/browser/mobile/capacity gates remain unverified.

## S003 completed (2026-10-15)

- Added scripts/rebuild/audit-git-secrets.py, a read-only standard-library tool using explicit included and previously audited excluded commit IDs. It never fetches, extracts archives or uses discovered credentials.
- Findings omit matched values; Firebase public web configuration is labeled separately from credential candidates. ZIP recursion has cumulative byte/member/depth limits. Invalid/unsupported archives and shallow history fail closed. Excluded objects still require prior evidence; pattern scanning cannot certify absence of secrets.
- Added tests/rebuild/test_audit_git_secrets.py: 10 synthetic regressions passed with zero skips. Covers redaction, classification, nested ZIP, resource limits, unsupported/corrupt archives, environment/header candidates, incremental exclusion and nonzero exit on findings.
- Command: PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/rebuild -p test_audit_git_secrets.py -v.
- Incremental real-repository run: include starting source, exclude bf8992ccafa386879b942789ea665f7d996c38b3; 7 new objects (1 commit, 3 trees, 3 blobs), zero findings/gaps/new archive members. Other refs unchanged from S002.
- Existing check-secrets.cjs passed after replacing a literal synthetic private-key marker with runtime construction and removing generated Python caches. Assertions and detections remain unchanged. git diff --check passed.
- Only audit tooling/tests/docs changed; no gameplay/browser/live staging/capacity test claim. External blockers unchanged; scheduled work remains enabled.

## S002 completed (2026-10-14)

- Read current public visibility, HEAD, instructions and audit before work.
- Fetched advertised PR #1 refs and current branches; inspected only 8 objects outside the previous audited graph (2 commits, 4 trees, 2 blobs).
- Custom pattern scan: zero findings, zero new archive members, zero archive gaps. Existing Firebase public web configuration classification remains unchanged; account restrictions remain unverified.
- Recorded exact scope and PR SHA in SECRET_AUDIT.md. No gameplay change or runtime test claim for this documentation/audit task.
- Validation: fetched refs matched GitHub inventory; scan completed successfully. Updated documents reviewed for values and whitespace before publication.
- Owner's updated continuation rule supersedes the earlier pause recommendation. No new task, resource, payment, merge or deployment.

## D003 assessment (2026-10-14)

- Source: 093adf096e9f58007fce61f5dd2746612d7f4b25; GitHub remains public. Other branch heads are unchanged from S001.
- `NODE_PATH=/workspace/scratch/e72adbdaf5bc/voxel-dev/node_modules node --test tests/rebuild/p9-client.test.cjs`: 11 passed, 0 failed/skipped. Covers generated staging syntax/configuration isolation, disabled payments/auth scaffold and token/lifecycle guards. These are local Node tests, NOT a browser or live staging pass.
- Existing `staging-zone-transition-browser.py` launches its own Chromium, installs fixtures/routes and advances application state through evaluate. The permitted Cloud Browser API has no equivalent browser launch, routing or mutable evaluation surface. Running the standalone Python browser controller is outside this run's permitted UI tooling. No assertion was removed or replaced.
- Read-only Cloudflare navigation reached `https://dash.cloudflare.com/login`; no authenticated account/environment inventory is available. No credentials entered or permissions changed.
- Incremental secret scan from S001 baseline to current HEAD inspected 17 new Git objects, no new archive members, no archive gaps. One assignment candidate is an existing synthetic server-test fixture; no confirmed new privileged credential. S001 exclusions still apply.
- D003 remains incomplete. No deployment, production change, payment or resource creation occurred.

## Latest completed iteration

D002: local staging handoff/reconnect regression audit, completed.
Starting source: 0e3fcd1746cd0c55f011a2b8fda58d86a82e5284.

- Reviewed existing source/destination authority and persisted reconnect path.
- Ran 40 existing staging client/server, cancellation-budget and coin regressions: all passed.
- Added two regressions to staging-zone-transition-server.test.cjs for reconnect after a committed continuous crossing, with and without coordinator restart. They assert destination pose/revision and player ID preservation, session rotation, nonmutating wrong-zone redirects, consumed-ticket rejection and one active owner.
- Full affected server test file: 23 passed, 0 failed/skipped.
- P6 identity plus P8 Lucky Box suites: 24 passed, 0 failed/skipped.
- Across these runs: 66 distinct targeted cases passed (overlapping server cases are not counted twice).
- Existing credential/config scanner and diff whitespace validation passed. No new credentials or privileged browser bindings.
- No reproducible runtime defect was found in this scoped audit; no gameplay implementation was changed. The two new cases close a combined cutover/reconnect coverage gap.
- All results use local transport/identity/storage fixtures; they do not establish real cloud recovery, browser behavior or capacity. No deploy, production change, account change or main merge.
- S001 audit is committed in SECRET_AUDIT.md. Its source/ref baseline remains applicable; subsequent changes are documentation and synthetic tests only, scanned before publication.

## Observed

- Existing main, phase4a-vps and rebuild-p0-p8 branches were inspected. The rebuild contains modular client/server code, isolated staging tooling and existing regression tests; selected as the development base.
- Existing workflow only auto-triggers for its own workflow-file changes on rebuild-p0-p8. No workflow was added or triggered; no deployment command was run.
- Historical notes mention deployed staging, while the committed configuration is a disabled scaffold. Actual account environment state remains unverified.
- GitHub is connected. Codex Cloud is not required for this workflow. No Cloudflare/Firebase mutation or production change occurred.

## Prior D001 verification (retained evidence)

- `npm ci --ignore-scripts --no-audit --no-fund`: passed (42 packages).
- `npm test`: passed, including active behavior/security suites, unchanged historical checkpoint assertions and both legacy multiplayer scenarios.
- `npm run check:client`, `npm run check:syntax`, `npm run check:static`, `npm run staging:check`, `node scripts/rebuild/check-secrets.cjs`: passed.
- Added local `verify-development.cjs`: fixed verification steps, branch guard, per-step logs, timeout/failure handling, source commit and dirty-state report. No deployment path.
- `node --test tests/rebuild/development-runner.test.cjs`: 5 passed, 0 failed; covers complete success, nonzero exit, signal, timeout and unknown exit.
- `node --check scripts/rebuild/verify-development.cjs` and `git diff --check`: passed.
- End-to-end `node scripts/rebuild/verify-development.cjs`: all six steps passed on the modified checkout (dirty=true), completed at 2026-10-14T07:39:37Z. Active suite now includes the five runner tests in addition to the 489 baseline active tests.
- A GitHub-backed hourly scheduled task was created and enabled. It reads current HEAD and these records before each bounded iteration, uses an expected-head lease and suppresses repeat notifications for unchanged blockers. Future execution/tools/model availability are not yet proven by a completed scheduled run.
- Browser, real Google login, deployed staging and physical mobile tests were not run in this iteration. No capacity or production readiness claim.

## Next bounded task

D013: audit menu/pause interruption of held movement and jump intent; ensure resume requires fresh input where appropriate. Reuse input-reset behavior, preserve authoritative movement/prediction, and verify real menu entry points in local behavioral tests. Live mobile validation remains pending.

Deferred D003: verify generated staging client and existing browser scenarios with the
available permitted browser tooling. Check tooling availability first. Preserve
all existing assertions; do not replace real browser evidence with static tests.
If browser execution is unavailable, record the exact limitation and proceed
only to other local work or authorized read-only staging inspection.

## External blockers / owner actions

Cloudflare sign-in is required before read-only account inspection can continue. Browser regression execution additionally requires an approved browser environment supporting the existing harness. Skip these blocked subtasks and continue safe local work per the owner's updated instruction; keep the existing hourly task enabled. Firebase API restrictions, Security Rules and App Check have not been inspected in the account; this remains a release-review requirement. Live infrastructure access,
staging mutations, merchant sandbox activation and production deployment remain
separate authorization boundaries. Scheduled task model selection is not exposed
by the automation tool; GPT-6 Astra Medium cannot be guaranteed for future runs.
