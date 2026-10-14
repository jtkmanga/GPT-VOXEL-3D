# Current development state

Updated: 2026-10-15 (Asia/Bangkok).
Branch: `development/voxel-continuous`.
Starting source commit: `250005dce44741de6e2a4587d40c903c8f662978`.
Task: D008 — validate shortlist equivalence against exhaustive occlusion.
Status: completed; external D003 gates remain blocked.

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

D009: audit static-map resource lifetime during repeated rebuilds. Check whether removed building/window/tree meshes release owned geometries and shared materials exactly once without disposing resources still used by the retained scene; reproduce and fix any leak with lifecycle regressions. Live browser/mobile memory evidence remains separate.

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
