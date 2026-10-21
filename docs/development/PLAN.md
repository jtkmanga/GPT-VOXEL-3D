# Development plan

D053 (2026-10-22): read-only Cloudflare revalidation after Deploy Staging #11
shows the new live revision receiving 100% of staging traffic while staging
identity, App Check, provider-neutral-test payment mode and ROOM/ZONE ownership
remain intact. Keep the Cloudflare deployed-revision/isolation sub-gates PASS on
the refresh deployment. Continue with Firebase API restrictions and session
revocation when owner-authorized account access is available; do not repeat this
inventory unless the staging deployment or bindings change again.

D052 (2026-10-21): live staging token refresh is now evidenced on a physical
Android device. P8 #6 and P9 #7 passed for the staging refresh-evidence source,
Deploy Staging #11 succeeded, and owner video after deployment showed the live
game still active with the staging banner reporting AUTH REFRESHED #2. Treat the
Google/session token-refresh sub-gate as PASS. Remaining Google/session work is
actual account/session revocation evidence; continue multiplayer/mobile,
payment-sandbox and authorized-capacity gates in parallel where safe.

D051 (2026-10-21): read-only Cloudflare account inventory verified the deployed
staging revision and complete ROOM/ZONE namespace isolation across every Worker
script in the account. Current staging identity/origin, App Check binding,
popup auth and non-production payment mode are coherent. Treat the Cloudflare
deployed-revision and Durable Object isolation sub-gates as complete unless
bindings or deployment change. Firebase API restrictions and later live gates
remain open.

D050 (2026-10-21): staging App Check is now integrated in source eb6f7dc,
P9 #6 passed, and Deploy Staging #10 succeeded. Owner evidence shows the staging
Web app registered with reCAPTCHA Enterprise/Fraud Defense and Authentication
enforcement enabled. Post-enforcement physical Android Chrome evidence shows
Google sign-in returning to staging and gameplay succeeding twice. Treat App Check
registration/enforcement plus basic live sign-in compatibility as complete for
staging. Still require live token refresh/revocation evidence, remaining account
isolation/security reconciliation, multiplayer/mobile multi-session evidence,
payment sandbox lifecycle and authorized capacity before Final Review.

D049 (2026-10-21): P9 Staging Browser Gate #5 passed at 7e6d63e
(run 39525636857). Both public-staging-read-only and staging-browser-fixtures
succeeded; the earlier GitHub-Actions /health 403 blocker is closed. Do not
repeat P9 unless a later change affects this gate. This does not substitute for
account-only isolation/App Check/API restrictions, real Google/session,
live multiplayer/physical mobile, payment sandbox or authorized capacity evidence.

D043: existing P9 browser scenarios passed 11/11 in GitHub run 39185662751 at
001cc26. Browser fixture coverage is verified; public staging health job failed.
Investigate only sanitized public diagnostics; real login/mobile/payment/capacity
and account-only isolation/security remain separate open gates.

D042 owner steering (2026-10-19): stop Cloudflare Cloud Browser login attempts
and repeated login prompts. Use development-only P9 GitHub Actions and existing
public staging endpoints. Account-only inspection remains a recorded blocker,
not a reason to stop other gates. P9 CI result pending; no live evidence implied.

Continue the existing rebuild, not a new game. Base: rebuild-p0-p8 at
0737017248bbc07e78749b297c384c0b1eceb1d8. Production main was observed at
f98aa9a044616b1b965b889cf0c02a0d3b041f65.

1. DONE: inventory existing branches, preserve rebuild work, create isolated development branch, reproduce local baseline, add verification runner and durable progress record.
2. DONE (local scope): D002 reviewed handoff/reconnect authority, ran 66 distinct targeted regressions including coin/Lucky Box and added two combined cutover/reconnect cases. No reproducible runtime defect found. Live integration remains a separate gate.
3. DONE (D049/D050): P8 and current-source P9 browser CI passed. Keep fixtures, live authentication and physical-device evidence distinct; do not repeat without relevant source/config changes.
4. PARTIAL (D053): Cloudflare deployed revision and ROOM/ZONE isolation revalidated read-only after Deploy Staging #11. Firebase App Check enforcement passed in D050; Firebase API restrictions remain open.
5. Live staging integration on verified isolated resources, subject to owner confirmation for external changes. Check real Google sign-in, two-player movement, reconnect, rewards, name visibility and mobile controls.
6. VIP/payment lifecycle work stays disabled until sandbox merchant lifecycle requirements are verified; never spend money. Capacity validation requires a separate approved test target and budget. No 10,000-player production claim from local fixtures.
7. Present evidence and remaining risks for explicit production release authorization. Passing tests alone is not deployment authorization.

## Scheduled iteration

Read current GitHub branch HEAD, AGENTS.md, STATE.md and PLAN.md. Choose one
unfinished Release Gate task in the priority order below. If another run has advanced HEAD, discard stale
assumptions and reconcile. Publish a tested change plus updated STATE.md in a
single commit using an expected-head lease. Do not keep committing identical
status updates when blocked. Do not repeat a completed task unless changed code
requires regression verification. A rejected lease must never be force-bypassed.

`node scripts/rebuild/verify-development.cjs` runs the existing local suites and
structural checks, stops on failure and writes private logs plus a JSON report
to a new temporary directory. Its report identifies the source commit and dirty
working-tree state. It does not run browser checks, deploy, verify live staging,
or certify production readiness. Review logs privately; commit only sanitized
results. Temporary logs are not durable evidence until summarized in GitHub.

## Final Review stop condition

Stop code changes only when current-source evidence covers all required local,
browser, real staging, security, multiplayer/mobile, payment sandbox and capacity
gates from the plan and no unresolved blocker remains. Set READY_FOR_FINAL_REVIEW
and pause the scheduled task; owner authorization is still required for merge
and production deployment. An unavailable test or fixture-only substitute is
not a pass. Secret/account remediation never proceeds without owner approval.

Security audit S001 was completed before D002; see SECRET_AUDIT.md. Reuse its
scanned refs/object baseline for incremental audits, while preserving its limits.

## Release Gates first (owner instruction, 2026-10-18)

Preserve unfinished correct edits and settle running checks before changing focus.
Gate order: browser; read-only Cloudflare/Firebase isolation and security settings;
real Google login/staging; multiplayer/mobile; VIP/payment sandbox; authorized
incremental capacity; final security/release review. See RELEASE_GATES.md for
current evidence and concrete blockers. A blocked gate does not stop other safe
gates. Local tests are justified only by gate requirements, reproduced defects,
or exhaustion of safe gate work; do not manufacture test-only activity.
Do not create resources, deploy, enable payment or load an unapproved target.

## Safe work while external gates are blocked

Per owner instruction, keep the hourly task enabled; a blocked subtask does not
pause the project. Skip unchanged external blockers and inspect the next safe
Release Gate first. Never substitute local results for live gates above.

- DONE S002: incrementally inspect the previously excluded advertised PR #1 refs and new documentation objects; record scope in SECRET_AUDIT.md.
- DONE S003: reproducible bounded Git/ZIP audit tool with 10 synthetic regression tests; see AUDIT_TOOL.md for usage and limits.
- DONE D004: two exact-expiry VIP resume/fresh-login denial regressions with/without coordinator restart; 42 P7 tests passed locally. Real sandbox lifecycle remains a separate gate.
- DONE D005: combined lost-ACK/reconnect/restart/respawn coin regression; 29 economy tests passed locally.
- DONE D006: reproduced and fixed remote labels visible through map geometry; regression and full local npm test passed. Browser/mobile validation remains pending.
- DONE D007: reusable per-frame nearby shortlist, wall/tree and cleanup regressions; 22 client checks and full npm test passed. Operation counts only, not mobile FPS.
- DONE D008: exhaustive-ray equivalence at range boundaries and transformed geometry plus 192 generated-map comparisons; 24 client checks passed, no defect reproduced.
- DONE D009: reproduced and fixed missing static-map disposal; unique-resource/retained-scene lifecycle tests and full local suite passed.
- DONE D010: fixed shared coin-batch disposal on map rebuild; snapshot meshes stay reused. Lifecycle/P8 checks and full local suite passed.
- DONE D011: fixed nested Lucky Box resource cleanup on replacement/map initialization/menu return; local lifecycle and countdown checks pass.
- DONE D012 (focus-loss scope): reset keyboard/joystick/jump/camera input on blur/hidden document; touch ownership preserved. Local regressions and full suite passed.
- DONE D013: reset input at menu/pause/exit entry points and reject paused/new autorepeat gestures; local regressions and full suite passed.
- DONE D014: three interruption/prediction/packet/reconciliation regressions; 31 targeted tests passed, no runtime defect reproduced.
- DONE D015: GameRoom/ZoneRoom pause and delayed genuine ACK regressions; 33 targeted tests passed. Synthetic transport only.
- DONE D016: hidden touch jump guarded; four keyboard/touch-to-authority regressions, 37 targeted tests and full local suite passed.
- DONE D017: touch-origin mousedown duplicate filtered; hybrid mouse/fresh touch fallback regressions, 39 targeted tests and full local suite passed. Browser emission/compatibility remains unverified.
- D018 ASSESSED, browser execution BLOCKED: Playwright installed locally; Chromium and headless-shell archive downloads failed after retries. No browser run/pass. Reattempt when artifacts become available.
- DONE D019: combined lost claim/reward ACK, reconnect/restart and next-cycle replay regression; 19 local P8 tests passed, runtime unchanged.
- DONE D020: fixed stale timeout releasing a retry with the same action ID using per-attempt identity; 21 targeted checks and full local suite passed.
- DONE D021: invalidate stale wheel animation and hide/reset wheel on menu return; 13 targeted tests and full local suite passed.
- DONE D022 (pending spin scope): two local resume/snapshot/modal/retry regressions passed; runtime unchanged. Socket authentication and live transport are not covered by these fixtures.
- DONE D023: replay unresolved own claim after resumed unexpired claimed snapshot; two client regressions, 25 targeted checks and full suite passed. Server authorization remains required.
- DONE D024: two client-to-bundled-Worker recovery scenarios verify owned replay and competing-claim denial without changing box state or score; 18 targeted tests passed.
- DONE D025: explicit correlated expiry rejection exposes return-to-play without reward; 19 targeted tests and full suite passed.
- DONE D026: correlated late expiry handled independently of pending attempt, preserving newer/rewarded actions; 21 targeted tests and full suite passed.
- DONE D027: genuine Worker expiry delivered after client timeout enables neutral exit with unchanged score/cooldown; 14 targeted tests passed, runtime unchanged.
- DONE D028: browser interpreter environment is missing; fixed open shop surviving menu return with regression and full local suite.
- DONE D029: restored isolated Playwright; headless-shell archive still fails. Added reconnect-backoff menu cancellation regression, 19 local tests passed.
- DONE D030: menu exit during reconnect authentication rejects late open/welcome and cleans resources; 20 local session tests passed, runtime unchanged.
- DONE D031: all three failed reconnect attempts return to menu, retain resume-only authentication and release timers; 21 local session tests passed.
- DONE D032: stale callbacks from authenticated and pending sockets cannot mutate a replacement session; 22 local session tests passed.
- DONE D033: late refresh success/failure cannot affect a same-UID replacement session; 24 local session tests passed.
- DONE D034: browser interpreter unavailable; missing refresh ACK/policy-close client regression and separate Worker security suite pass (51 tests). Browser gate remains blocked.
- DONE D035: lost client refresh request, genuine ZoneRoom expiry rejection and client teardown integrated locally; 26 client tests passed.
- DONE D036: accepted refresh/withheld ACK preserves renewed Worker expiry; late/duplicate ACK restores one timer. 27 local client tests passed.
- DONE D037: expired delayed/duplicate ACK cannot override genuine Worker policy closure; 28 local client tests passed.
- DONE D038: full local verification on D037 source: 552 active tests, historical/legacy suites, static/generated/syntax/config checks and 10 audit-tool tests passed. Browser prerequisites unavailable; no browser run.
- D039: Release Gate triage and browser tooling recovery; see current STATE.md and RELEASE_GATES.md. Earlier speculative auth-clock regression is deferred under the new gate-first priority.
- DONE D040 (assessment only): reconciled owner screenshots and staging storage architecture; 42 existing local P9 tests pass. App Check, deployed source/namespace mapping and API restrictions remain unresolved. No Firebase database creation is justified solely to inspect Rules; see RELEASE_GATES.md. Browser download remains blocked.
