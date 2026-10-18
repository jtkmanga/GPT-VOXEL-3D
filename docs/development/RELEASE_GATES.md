# Release gate ledger

Assessed 2026-10-18 (Asia/Bangkok), source
2892fb0af2eea7bb692e228fc685e085e5494d74. Status: NOT READY.
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
