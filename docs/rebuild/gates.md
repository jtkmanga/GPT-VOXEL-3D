# Rebuild phase gates

This track starts at main `f98aa9a044616b1b965b889cf0c02a0d3b041f65`.
It is a new rebuild and makes no claim to recover lost original P0–P3 source.

Initial safety check completed before source edits:

- `git fetch origin`: exit 0.
- `git rev-parse origin/main`: exact approved SHA above.
- `git status --short`: empty.
- `git branch -a`: local `work`, `origin/main`, `origin/HEAD -> origin/main`.
- `git log -5 --oneline`: `f98aa9a`, `62e554d`, `769bd18`, `325ff26`, `25062cb`.
- Created `rebuild-p0-p8` from verified `origin/main`.
- Pushed unchanged branch successfully, without force.
- `git ls-remote origin refs/heads/rebuild-p0-p8`: exact approved SHA.

Every phase follows IMPLEMENT → TEST → REVIEW DIFF → COMMIT → PUSH → VERIFY
REMOTE → NEXT PHASE. Failure at any step stops the track. No failing assertion
may be disabled, no phase skipped, and no reset/force push may conceal a problem.

`npm run gate:test` runs regression/new tests, static checks, JavaScript syntax,
`git diff --check`, then Wrangler's **dry run**. Test processes stop the runner on
their first failed command. Test runner never invokes archived load generators.
The two original WebSocket smoke scripts execute unchanged through a local test
transport with synthetic auth and actual active Worker handlers. The three
original static suites receive the active `index.html`/`worker.js` explicitly.
The smooth-handoff suite's brittle one-argument resume-call regex is replaced by
observable client lifecycle tests using the actual open/resume/ACK/error handlers
and secure movement override. They assert close ordering, single client gameplay
sender, fail-closed rollback, and inactive late-ACK filtering. They do not establish
server-exclusive ownership; the baseline lacks a durable cross-zone owner epoch.
Additional Node tests execute active code with a fake server clock and SQLite.
This covers local logic; it does not replace real Durable Object/mobile evidence.

After successful tests, review the complete staged diff. Commit with the phase's
specified subject, require empty `git status --short`, push only `rebuild-p0-p8`,
then require `git ls-remote` branch SHA to equal `git rev-parse HEAD`. Retain each
checkpoint's exact commands, exit codes, test totals and remote SHA in the task
evidence. Do not start subsequent implementation before that equality check.

Prohibited throughout: main merge/force push, production deployment/publication,
production secret changes, embedded credentials, real payment/charges, client
authority over movement/economy/entitlement, and deletion of regressions to pass.
P8 load must remain safe and local. Production, paid infrastructure, third-party
load traffic or abuse/rate-limit risk requires STOP before that experiment.

Final verification must include the remote main SHA, all phase checkpoint SHAs,
test outcomes and limitations. A local simulation alone never establishes
production readiness or 10,000 concurrent support. Stop after the final report;
review and launch authorization are separate user decisions.
