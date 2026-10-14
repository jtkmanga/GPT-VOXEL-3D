# S001: public repository credential audit

Date: 2026-10-14. Source: development/voxel-continuous at
5b49b8c013e556d768537fc7be7c046a88239507. GitHub visibility: public.

## Scope and method

A non-shallow fetch contained 96 reachable commits, 663 Git objects and 340
unique file blobs. All reachable blobs plus commit/tag messages were scanned
locally; 62 ZIP member versions were scanned in memory, including nested archive
handling. No archive read/size/depth gap was reported. The scan included known
provider-token formats, private-key markers, credential assignments, unquoted
environment credentials, literal Authorization credentials and credential file
names. Matching values were never printed, persisted in reports or sent to a
provider. This was a bounded custom pattern audit, not proof of absence of all
secrets (encoded/unrecognized credentials can evade patterns).

Fetched refs:
- main: f98aa9a044616b1b965b889cf0c02a0d3b041f65
- development/voxel-continuous: 5b49b8c013e556d768537fc7be7c046a88239507
- rebuild-p0-p8: 0737017248bbc07e78749b297c384c0b1eceb1d8
- phase4a-vps: 171a3a6c83ca1871819a9be9a683419fa2bea877

## Findings (values intentionally omitted)

One distinct Firebase Web API key was found in current client configuration and
historical file versions. Representative locations:

| Ref/version | Location | Classification |
|---|---|---|
| development at 5b49b8c | src/client/auth-state.js:4; index.html:632 | Firebase Web client configuration |
| main at f98aa9a | index.html:509 | Same Firebase Web client configuration |
| retained client versions | index_phase2c1.html:509; index_phase2c1_1_smooth.html:509; index_phase2c2_final.html:509; index_phase2c2_multiplayer_fix.html:509 | Same public configuration |
| ZIP retained in both main and development | phase4d3e-patch.zip!index.vps-test-v2.html:509 | Same public configuration |
| development tooling/tests | scripts/rebuild/build-staging-client.cjs:86; src/shared/staging.mjs:23; tests/rebuild/p9-client.test.cjs:72 | References used to reject production configuration in staging |

Historical client blobs also contain this key, for example
655fb321b261f600d852aeb77b743cba9029ca42 (index.html:632) and
acd870737d9a748daab6807e7a11f1b4bfab4848 (index.html:509).
These are blob IDs, not claimed first-introduction commits.

No match for a private-key block, Ably full key, GitHub token, Google OAuth
client secret, AWS access key, Stripe live secret, Slack token or literal JWT
was found by these patterns. Credential assignment candidates otherwise
corresponded to synthetic fixtures/placeholders. Four Authorization matches
were synthetic test strings in p9-browser.py, p9-integration.test.cjs,
staging-gameplay-browser.py and staging-zone-transition-browser.py.
No confirmed privileged Cloudflare/Firebase credential was identified by this
scan. Environment binding names alone are not embedded credential values.

## Remaining boundary

Firebase documents that its Web API keys generally identify a project rather
than authorize database access. This does not establish that this particular
key has appropriate restrictions, Security Rules or App Check:
https://firebase.google.com/docs/projects/api-keys

Those account settings remain unverified and must be reviewed before release.
No key was tested, revoked or rotated; no history was rewritten; no repository
visibility or account permissions changed. No privileged-leak remediation is
authorized by this report. Continue isolated local development only.

Excluded: unreachable/deleted Git objects not advertised by fetched refs,
GitHub pull-request-only refs, external forks/caches, release assets, Actions
logs/artifacts, account-side secrets and live database permissions. No claim
about those surfaces is made. Future runs should compare fetched refs to this
baseline, scan newly reachable objects and changed archives, and avoid repeating
this same full audit without a concrete coverage reason.
