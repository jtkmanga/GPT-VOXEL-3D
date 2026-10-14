# Continuous development contract

- Work only on `development/voxel-continuous`; preserve existing main and rebuild branches.
- Read `docs/development/STATE.md` and `docs/development/PLAN.md` first. Fetch the latest branch head before each task and before publishing changes.
- Never deploy, merge into main, alter production, make payments, enable payment adapters, or change account permissions without the owner's explicit authorization.
- Do not create new infrastructure when existing staging may be reusable. Historical documentation is not proof of current live configuration.
- Keep secrets, credentials, personal data and raw logs out of this public repository. Use the existing credential scanner and review the diff.
- Run relevant behavioral tests. Never weaken assertions, skip failures, or describe mocked/local results as real cloud capacity or live authentication evidence.
- Record one bounded task, its starting commit, files changed, commands and outcomes, unresolved blockers and next task in STATE.md with each commit.
- Use a fast-forward update with an expected branch SHA. On a changed head, re-read and reconcile; never force-push over another run.
- Scheduled execution is bounded by the tools available in that run. Do not promise continuous compute or a particular model that the scheduler cannot select.
- Only notify the owner for required account/permission approval or an unresolved blocker. Never send external messages on their behalf.

- Before committing code, all applicable checks must pass. Failed changes stay local to development; never merge failing work.
- Check repository visibility and the sanitized secret-audit record. Scan newly reachable Git objects, current files and archives; never print credential values or try them against providers. Findings must identify only type and location. Pause before account-impacting rotation, revocation, history rewrite or permission changes.
- When every required plan gate is satisfied on the current source, mark READY_FOR_FINAL_REVIEW, stop editing code, notify the owner and pause the scheduled automation. Never merge or deploy without explicit approval.
