# P8 final verification with external browser evidence

Verified on 2026-10-12, continuing the existing P0–P9 history. The verification
base is `3b0ae0a9b36973e0b9d5d9ee34824bc9484133f4` on `rebuild-p0-p8`.
Main remains `f98aa9a044616b1b965b889cf0c02a0d3b041f65`.
The two user-authored commits since `b1e9e6dd2ccf70b44d86d9833b142e375282ed69`
only add/configure `.github/workflows/p8-browser-gate.yml`.

## External original browser HARD GATE

- Repository: `jtkmanga/GPT-VOXEL-3D`; branch: `rebuild-p0-p8`.
- Workflow: **P8 Browser Gate**.
- Run: **Modify P8 Browser Gate workflow for Playwright setup #1**.
- [Run 38261418941](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/38261418941).
- [Job 114852591759](https://github.com/jtkmanga/GPT-VOXEL-3D/actions/runs/38261418941/job/114852591759).
- Checked-out SHA: `3b0ae0a9b36973e0b9d5d9ee34824bc9484133f4`.
- Original command: `python tests/rebuild/p1-browser.py`.
- GitHub job and original-browser step: completed successfully.
- Job logs contain eight `PASS P1 browser:` cases and exactly
  `P1 browser cases: 8 passed / 0 failed / 0 skipped`.
- Observed CI tools: Node `24.21.0`, Python `3.12.15`, Playwright `1.62.0`,
  Chrome for Testing `151.0.7922.34`, exposed as `/usr/bin/chromium`.
- Original browser-file SHA-256:
  `91851b1956ae626f70b9fb6150c06165db1daf73c6194a5527cd2f8378dfe59b`.
- Application `src` Git tree at the Actions checkpoint:
  `e840c9768f41e332ce1ec40dd21b2aa0c91542c6`.

The GitHub run page, job/step metadata and job logs were inspected independently
of the user-provided result. The original browser test remains byte-identical to
the P8 checkpoint `04327fd32047068ba194c5132a32da34cadf5b58`. It uses real
Chromium/Playwright, loopback HTTP and real Three.js r128/SwiftShader WebGL.
Its existing Firebase/CDN fixtures and network isolation are unchanged.

This is external execution evidence. No local browser execution or local browser
success is claimed. The previously recorded Codex TCP/Chromium Unix-socket EPERM
setup failures are retained as environment failures, not relabeled as passes.
No test was removed, skipped, weakened, replaced or given altered expectations.

Before and after the final verification commit, compare its application scope
with the successful Actions checkpoint:

```sh
git diff --exit-code 3b0ae0a9b36973e0b9d5d9ee34824bc9484133f4 -- index.html worker.js src tests package.json package-lock.json wrangler.jsonc .github/workflows/p8-browser-gate.yml
```

An empty diff proves that the external browser result applies to the unchanged
client/test source in the final checkpoint. Documentation and verification
transport changes do not change that tested application scope.

## Complete remaining gate results

All commands below ran successfully against the active application source.
The full regression preserves historical phase proofs and runs all active
P0–P9 behavioral/security suites; required tests have no failures or skips.

| Gate | Command | Result |
|---|---|---|
| Full regression | `GIT_OPTIONAL_LOCKS=0 node --require ./scripts/rebuild/verification-stdio.cjs scripts/rebuild/run-tests.cjs` | 470 Node tests, 2 unchanged legacy scripts; 0 failures/skips/cancellations/todo |
| Legacy/static assertions | Included in full regression | 43 passed |
| Static | `npm run check:static` | PASS |
| Generated client | `npm run check:client` | PASS |
| JavaScript syntax | `npm run check:syntax` | 118 units passed |
| Complete diff | `node scripts/rebuild/check-diff.cjs` and `git diff --check` | PASS |
| Staged diff | `git diff --cached --check` | PASS |
| Secret/config | `node scripts/rebuild/check-secrets.cjs` | PASS; production config unchanged, no privileged browser bindings |
| Wrangler bundle | `WRANGLER_SEND_METRICS=false npm run bundle:dry-run` | PASS; `--dry-run: exiting now.` |
| Current-source load evidence | `node scripts/rebuild/load-evidence.cjs docs/rebuild/P8-final-load-results.json` | PASS; highest completed 10,000 synthetic sessions |
| Historical P8 evidence | `node scripts/rebuild/check-p8-evidence.cjs` | PASS against original P8 Git archive |
| Original Chromium browser | External job above | 8 passed / 0 failed / 0 skipped |

Combined test count: **480 passed / 0 failed / 0 skipped**: 470 Node tests,
2 legacy scripts and 8 external browser cases. The 43 legacy assertions are
reported separately and are not added again to this case count.

Additional existing staging checks passed:

```sh
node scripts/rebuild/check-staging-firebase.cjs --config work/staging/firebase-public.json
node scripts/rebuild/check-staging.cjs --config work/staging/prepared-candidate/wrangler.jsonc --require-assets
```

These establish public Firebase syntax/isolation and structural staging
isolation; they do not establish live sign-in or external resource ownership.
Local execution logs are retained under ignored `work/gates/P8-final/`.

## Current-source synthetic load evidence

`P8-final-load-results.json` preserves the previously completed local report
without rewriting its measured commit, timestamps, command or observations.
Its recorded measurement commit is `b1e9e6dd2ccf70b44d86d9833b142e375282ed69`.
The report's Worker/shared source SHA-256 matches the unchanged current runtime:

`8a4880d597ca331a57e3f7ef642e5afa803eb75a7bdd1ee29d14c6e0926a36fc`.

| Synthetic sessions | Admitted | Movement ACKs | Updates/s | Movement p95 ms | Sampled peak RSS MiB |
|---:|---:|---:|---:|---:|---:|
| 100 | 100 | 300/300 | 1203.748 | 18.703 | 110.289 |
| 1,000 | 1,000 | 3,000/3,000 | 1650.803 | 17.903 | 240.555 |
| 10,000 | 10,000 | 30,000/30,000 | 234.671 | 167.745 | 654.449 |

All levels completed with zero detected errors, timeouts, closed sessions,
visibility/state consistency violations or external network requests. This is
an in-process local synthetic Worker/SQLite session test with simulated
transport. It is not evidence of 10,000 real production connections. The
original `P8-load-results.json` remains unchanged and is separately checked
against its genuine P8 source archive.

## Verification tooling and future reruns

`verification-stdio.cjs` is an opt-in managed-environment compatibility preload:
it transports exact subprocess input/output bytes while retaining native exit
codes, errors, signals, limits and Node's normal test-process isolation. No
application module imports it. `gate-phase.cjs` adds only a P8 fresh-load-report
selection option, preserving the original strict fingerprint and load checks.
The original browser command and its required eight-case assertion are intact.
Six separate compatibility probes passed: binary stdin round-trip, exact output
and exit 7, missing executable (`ENOENT`), output limit (`ENOBUFS`), timeout
(`ETIMEDOUT`), and `execFileSync` propagation of exit 7. These tooling probes
are separate from the 480 regression/browser case total.

This record combines genuinely successful local gates with verified external
browser execution. It does not fabricate the all-local runner's summary or
make that runner silently bypass the browser command. In a socket-capable
environment, the complete all-local runner can still run the original browser
test and every other gate:

```sh
mkdir -p work/load
cp docs/rebuild/P8-final-load-results.json work/load/p8-final-evidence.json
node scripts/rebuild/gate-phase.cjs P8 --load-report work/load/p8-final-evidence.json
```

If Worker/shared source changes, generate new load evidence rather than reuse
this report. If tested browser/client source changes, obtain a fresh original
browser result rather than reuse this Actions run.

## Safety and remaining external validation

P8 release-candidate verification is complete for this unchanged application
scope. Existing P0–P9 checkpoints are preserved. No main merge, production
deployment/publication, Cloudflare resource operation or real payment occurred.
Wrangler ran only its local bundle dry-run. No production secrets were used.

Real Firebase/Google login, isolated staging Worker/Durable Object deployment,
Cloudflare storage/network recovery, Android device behavior, provider sandbox
integration and real network capacity still require staging validation. VIP
checkout remains disabled; no production readiness or real-player capacity
claim follows from these gates. The next safe step is a read-only staging
preflight that confirms account ownership, the unused isolated Worker name and
staging bindings before requesting separate deployment authorization.
