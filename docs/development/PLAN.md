# Development plan

Continue the existing rebuild, not a new game. Base: rebuild-p0-p8 at
0737017248bbc07e78749b297c384c0b1eceb1d8. Production main was observed at
f98aa9a044616b1b965b889cf0c02a0d3b041f65.

1. DONE: inventory existing branches, preserve rebuild work, create isolated development branch, reproduce local baseline, add verification runner and durable progress record.
2. DONE (local scope): D002 reviewed handoff/reconnect authority, ran 66 distinct targeted regressions including coin/Lucky Box and added two combined cutover/reconnect cases. No reproducible runtime defect found. Live integration remains a separate gate.
3. BLOCKED (D003; local client checks passed): Verify the generated staging client and existing browser scenarios where the browser tooling permits. Keep browser and server-fixture results distinct.
4. Read-only inventory of existing Cloudflare/Firebase staging after authorized access becomes available; compare deployed revision and isolation. Do not invent resources or assume older deployment notes are current.
5. Live staging integration on verified isolated resources, subject to owner confirmation for external changes. Check real Google sign-in, two-player movement, reconnect, rewards, name visibility and mobile controls.
6. VIP/payment lifecycle work stays disabled until sandbox merchant lifecycle requirements are verified; never spend money. Capacity validation requires a separate approved test target and budget. No 10,000-player production claim from local fixtures.
7. Present evidence and remaining risks for explicit production release authorization. Passing tests alone is not deployment authorization.

## Scheduled iteration

Read current GitHub branch HEAD, AGENTS.md, STATE.md and PLAN.md. Choose one
unfinished local code/test task. If another run has advanced HEAD, discard stale
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

## Safe work while external gates are blocked

Per owner instruction, keep the hourly task enabled; a blocked subtask does not
pause the project. Skip unchanged external blockers and select a bounded local
item. Never substitute local results for live gates above.

- DONE S002: incrementally inspect the previously excluded advertised PR #1 refs and new documentation objects; record scope in SECRET_AUDIT.md.
- DONE S003: reproducible bounded Git/ZIP audit tool with 10 synthetic regression tests; see AUDIT_TOOL.md for usage and limits.
- DONE D004: two exact-expiry VIP resume/fresh-login denial regressions with/without coordinator restart; 42 P7 tests passed locally. Real sandbox lifecycle remains a separate gate.
- DONE D005: combined lost-ACK/reconnect/restart/respawn coin regression; 29 economy tests passed locally.
- DONE D006: reproduced and fixed remote labels visible through map geometry; regression and full local npm test passed. Browser/mobile validation remains pending.
- DONE D007: reusable per-frame nearby shortlist, wall/tree and cleanup regressions; 22 client checks and full npm test passed. Operation counts only, not mobile FPS.
- NEXT D008: compare shortlisted and exhaustive occlusion for range boundaries, large/scaled geometry and generated-map seeds; fix reproduced false negatives.
