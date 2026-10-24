# S001: public repository credential audit

## D072 reviewed incremental history — 2026-10-23

Reviewed 8a333eb..1ace8fd: 18 development commits covering staging-only
Firebase/App Check diagnostics, 2C2P sandbox harness updates, provider redirect
handling, and hosted-payment diagnostics. The only scanner candidates were
synthetic test fixtures or identifier-suffix false positives; no private/admin
credential, debug-token value, payment secret, or account token was introduced.
Gate 7 baseline advances to this reviewed source. Credential-key matching was
also tightened to whole identifiers so names such as paymentToken are not
misclassified while exact credential assignments remain fail-closed.

## D071 reviewed incremental history — 2026-10-23

Reviewed 77772db..8a333eb: 10 commits covering staging-only
App Check request verification, synthetic App Check/Firebase test fixtures,
Gate 5 workflow dispatch wiring, and the owner-approved one-shot sandbox trigger.
No private/admin credential, payment secret, debug-token value, or account token
was introduced. Public/synthetic Firebase values remain test/client fixtures.
Gate 7 audit baseline advances to this reviewed source; scanner patterns,
coverage checks, and fail-on-new-finding behavior remain unchanged.

## D070 publication audit

Reviewed 675d854..77772dbde9ca6144c536477e59553ea16b19b39e: 13 objects, no archives or gaps.
Six candidates are unchanged public Firebase configuration and synthetic test
configuration, including the new synthetic App Check fixture. No private
credential identified. Gate 7 baseline advances to this reviewed commit;
new findings still fail closed.

## D070 reviewed incremental history — 2026-10-23

Reviewed 8231d5e..675d854: 72 objects (9 commits, 37 trees, 26 blobs),
zero archive members and zero coverage gaps. All 10 scanner candidates were
inspected at their exact blob/line locations. Seven are dynamic JavaScript
construction using json.dumps(debug_token), not a stored token, in historical
Gate 5/6 browser scripts. Three are synthetic P9 fixture configuration/token
values (p9-browser.py lines 23, 52, 79). No private credential was identified.
The Gate 7 reviewed baseline advances to 675d854; patterns and fail-on-new-finding
behavior remain unchanged. Current-file checks remain required. No credentials
used and no account changes. Prior scanner scope limitations remain.


## D068 increment — 2026-10-22

Public source 8231d5e51830d038dbaa60e4a819a2785a051e61 minus audited
f596d4acfa86e1004db2c57926a071b5b3330e32: 15 objects (1 commit, 5 trees,
9 blobs), no archive members and no coverage gaps. Eleven candidates were
reviewed privately by location: the regenerated client contains the unchanged
public Firebase web configuration, while the remaining assignments are
synthetic App Check, authentication and payment fixtures. No privileged or
usable provider credential was found, printed or used. The Gate 7 incremental
audit baseline advances to this reviewed commit; future runs still fail on any
new candidate or coverage gap.

## D067 increment — 2026-10-22

Public source f596d4acfa86e1004db2c57926a071b5b3330e32 minus audited
99d8c2ec9db4f3cfb16e9fe9f6fe2a4c54eed430: 226 objects (39 commits, 131
trees, 56 blobs), no archive members and no coverage gaps. Eighteen assignment
candidates were reviewed privately by location: they are CI secret-variable use,
synthetic test credentials, synthetic public App Check configuration and local
2C2P fixtures; no usable provider credential was found. No candidate value was
used against a provider or copied into this record. Current-file secret/config
scan passed 172 rebuild/source files with production configuration unchanged.
The bounded-pattern and excluded-tip limitations below remain applicable.

## D064 increment — 2026-10-22

Public source 99d8c2ec9db4f3cfb16e9fe9f6fe2a4c54eed430 minus audited
742d6d0d3b57df9679841ae3cf0fa222bbadf221: 14 objects (2 commits, 6 trees,
6 blobs), no findings, archive members or coverage gaps. Current secret/config
scan passed 164 rebuild/source files with production configuration unchanged.
Read-only Cloudflare inspection recorded binding names/types only; no binding
values, account identifiers or credentials were committed or used. Existing
bounded-pattern, committed-object and account-setting limitations remain.

## D062 increment — 2026-10-22

Public source f9786c433d1804cb8198ee2a7c9258cca2ff4c16 minus audited
c807b56c0e05e15d78916cad4e6f64e1a71fc168: 61 objects (9 commits, 31 trees,
21 blobs), no archive members or coverage gaps. Scanner findings in
tests/rebuild/p2-client.test.cjs were privately reviewed as synthetic
resume/handoff/session fixtures. Findings in tests/rebuild/p9-client.test.cjs
were the intended public Firebase Web client configuration and synthetic test
assignments. No private or admin credential was identified or used. The current
secret/config scan passed 164 rebuild/source files with production configuration
unchanged. Existing bounded-pattern, committed-object and account-setting
limitations remain.

## D056 increment — 2026-10-22

Public source 9cacec40c1425a8c3c3720484b49a608948bc87d minus audited
a038daa29b8d1b7cb38b8379e12fe652c7b4e483: 30 objects (4 commits, 14 trees,
12 blobs), no archive members or coverage gaps. Scanner findings in
tests/rebuild/p9-client.test.cjs were privately reviewed as unchanged synthetic
fixture assignments and the intended public Firebase Web client configuration;
the source diff introduces no credential material. No private/admin credential
was identified or used. Current scan of 164 rebuild/source files passed with
production configuration unchanged. Existing scope, bounded-pattern and
account-setting limitations remain.

## D053 increment — 2026-10-22

b392580bbae6d5683ccabb3a818dd203acf786ca minus audited
e92be976697c15dfb6edc8a6f58077afd0609296: 21 objects (3 commits, 11 trees,
7 blobs), no archive members or coverage gaps. Matches were privately reviewed:
the P9 browser session values are synthetic fixtures, and the Firebase Web key
matches are test/public client configuration. No private/admin credential was
identified or used. Current scan of 164 rebuild/source files passed. Existing
scope, bounded-pattern and account-setting limitations remain.

## D051 increment — 2026-10-21

d45608de7ebd2f555b0586f5ee28416c9a2917d8 minus audited
99dd18e7e7a393003c743d3af8a26fa659b51c90: 28 objects (2 commits, 13 trees,
13 blobs), no archive members or coverage gaps. Matches were privately reviewed:
the Firebase Web key occurrences are the same intended public client
configuration, while assignment/authorization matches are synthetic P9 fixture
values. No private/admin credential was identified. API restriction status is
an account-setting gate and is not inferred from this review. Current scan of
164 rebuild/source files passed. Existing scope and pattern limitations remain.


## D044 increment — 2026-10-19

fb3bea56a6f1f2f943e591d69a6a05b2ac4cbd20 minus audited 001cc266fa5d183ff9a268ec947a64f12ecf57ec:
11 objects (1 commit, 5 trees, 5 blobs); zero findings/archive members/gaps.
Other refs unchanged; previous scope/pattern/account-setting limitations remain.

## D043 increment — 2026-10-19

001cc266fa5d183ff9a268ec947a64f12ecf57ec minus audited eaf86dffe69ddf8f625a48bc98a0a3129715daa7:
11 objects (1 commit, 5 trees, 5 blobs), no findings/archive members/gaps.
No secret values used or logged; earlier scope and account-setting limits remain.

## D042 increment — 2026-10-19

Public eaf86dffe69ddf8f625a48bc98a0a3129715daa7 minus audited fbd7f601be4aba01e1ec747cfd1c6be9de440c3a:
8 objects (1 commit, 3 trees, 4 blobs), no findings/archive members/gaps. Other
advertised refs unchanged. Current scan including new workflow: 162 files passed.
No provider secrets requested or used. Public Firebase config remains distinct
from private credentials. Prior bounded-pattern/account/scope limits remain.

## D041 increment — 2026-10-19

Public source fbd7f601be4aba01e1ec747cfd1c6be9de440c3a minus previously
audited 8c209ec95c6c63acb67dcc64d5909db069fdfb76: 25 objects (5 commits,
15 trees, 5 blobs), zero findings/archive members/gaps. Other advertised refs
unchanged. Current-file scanner passed 161 files. Previous bounded-pattern and
scope limitations remain; account settings unverified. Firebase public web
configuration remains distinct from private/admin/database credentials. No
credential values printed or used. No account or production changes.

## D040 increment — 2026-10-18

Reused the completed scan of fb179fb92ff1b491528c102beb6235ab6c12a09a minus
2892fb0af2eea7bb692e228fc685e085e5494d74: 8 objects (1 commit, 3 trees,
4 blobs), zero findings/archive members/gaps. Fresh advertised refs are unchanged;
no full-history scan repeated. Prior reachable-history/archive baseline and all
exclusions/pattern limitations remain. Current-file scanner passed. Owner console
screenshots are private evidence, not repository content: only sanitized setting
observations are recorded. Firebase public web configuration is distinct from
private/admin/database credentials; no credential values copied or used.
API restrictions and account-side security remain unverified; not a safety certificate.

## D039 increment — 2026-10-18

Public source 2892fb0af2eea7bb692e228fc685e085e5494d74 minus audited
35c104f7ab37757b2dbee4b136fa6ab60b02f28a: 7 objects (1 commit, 3 trees,
3 blobs), zero findings/archive members/gaps. All other advertised refs unchanged.
Current scan passed (161 files after ledger addition); prior current/historical archive coverage reused.
Firebase public web configuration remains distinct from private/admin/database
credentials. No credential use or account action. Prior scope/pattern limitations
and unverified account restrictions remain; not a global security certification.

## D038 increment — 2026-10-18

Public source 35c104f7ab37757b2dbee4b136fa6ab60b02f28a minus audited
f4993e559bf90f7a7ad91ba8612086e230e74f20: 10 objects (1 commit, 5 trees,
4 blobs), no archive members/gaps; other advertised refs unchanged.
Scanner exit 1 reviewed: nine assignment candidates in tests/rebuild/p2-client.test.cjs
at lines 65, 107, 169, 183, 185, 493, 674, 678 and 751, blob
043b8422790fac866cc0cbfbc5e95c8d49823d28, are unchanged synthetic fixtures,
privately compared against the audited parent. Current-file scan passed (160 files);
audit-tool regression suite passed 10 tests. Existing current/historical archives
reuse prior bounded coverage. Firebase public web configuration remains distinct
from private/admin/database credentials. No discovered credential values printed
or used; no account actions. Prior scope/pattern/account limitations remain.

## D037 increment — 2026-10-18

Public source f4993e559bf90f7a7ad91ba8612086e230e74f20 minus audited
3e7deacd42d1db1db270699912f8dba3e2aaf7e7: 10 objects (1 commit, 5 trees,
4 blobs), no archive members/gaps; other advertised refs unchanged.
Nine assignment candidates in tests/rebuild/p2-client.test.cjs at lines
65, 107, 169, 183, 185, 450, 631, 635 and 708, blob
91ddeb7886c0424c2318f9f845fe2cf653a4b998, are unchanged synthetic fixtures,
privately compared against the audited parent. Current-file scan passed.
No discovered credentials used/disclosed; tests generate synthetic tokens only.
Firebase public configuration is distinct from private/admin/database credentials.
Prior archive coverage, scope/pattern limitations and account limits remain.

## D036 increment — 2026-10-16

Public source 3e7deacd42d1db1db270699912f8dba3e2aaf7e7 minus audited
c67005bfeaca21b31be5089f9d55caf7c870c1ff: 10 objects (1 commit, 5 trees,
4 blobs), no archive members/gaps; other advertised refs unchanged.
Nine assignment candidates in tests/rebuild/p2-client.test.cjs at lines
65, 107, 169, 183, 185, 400, 581, 585 and 658, blob
ebfa952d2928baa5b9b4279ef5f0d9cd0f6f1446, are unchanged synthetic fixtures,
privately compared against the audited parent. Current-file scan passed.
No discovered credentials used/disclosed; tests generate synthetic tokens only.
Firebase public web configuration is distinct from private/admin/database
credentials. Prior archive coverage and scope/pattern/account limits remain.

## D035 increment — 2026-10-16

Public source c67005bfeaca21b31be5089f9d55caf7c870c1ff minus audited
345fe7d9cb0671cac05d40fb97e17aeeb7923ef0: 10 objects (1 commit, 5 trees,
4 blobs), no archive members/gaps; other advertised refs unchanged.
Nine assignment candidates in tests/rebuild/p2-client.test.cjs at lines
65, 107, 169, 183, 185, 354, 535, 539 and 612, blob
1019798e8b83971cf434dae3c0bdbfce8a998d89, are unchanged synthetic fixtures,
privately compared against the audited parent. Current-file scan passed.
No discovered credentials used/disclosed; integration uses generated synthetic
test tokens only. Firebase public configuration is not private/admin/database
credentials. Prior archive coverage, scope/pattern/account limits remain.

## D034 increment — 2026-10-16

Public source 345fe7d9cb0671cac05d40fb97e17aeeb7923ef0 minus audited
965f57e2d16ccfd8e08327cdfbc797786821fbcc: 10 objects (1 commit, 5 trees,
4 blobs), no archive members/gaps; other advertised refs unchanged.
Nine assignment candidates in tests/rebuild/p2-client.test.cjs at lines
65, 107, 169, 183, 185, 332, 513, 517 and 590, blob
c55a3f03533fc2b23adb2e99ab6edcb526582297, are unchanged synthetic fixtures,
privately compared against the audited parent. Current-file scan passed.
No values disclosed/used. Firebase public web configuration remains distinct
from private/admin/database credentials. Prior archive coverage, scope/pattern
limitations and unverified account settings remain unchanged.

## D033 increment — 2026-10-16

Public source 965f57e2d16ccfd8e08327cdfbc797786821fbcc minus audited
a0b1ddfd08e182bc5e63cffb0bde715376b1d5db: 10 objects (1 commit, 5 trees,
4 blobs), no archive members/gaps; other advertised refs unchanged.
Nine assignment candidates in tests/rebuild/p2-client.test.cjs at lines
65, 107, 169, 183, 185, 299, 480, 484 and 557, blob
400bf46c9fcc576420cd50127a9e1c2906ba464b, are unchanged synthetic fixtures,
privately compared against the audited parent. Current-file scan passed.
No values disclosed/used. Firebase public web configuration remains distinct
from private/admin/database credentials. Prior archive coverage, scope/pattern
limitations and unverified account settings remain unchanged.

## D032 increment — 2026-10-16

Public source a0b1ddfd08e182bc5e63cffb0bde715376b1d5db minus audited
5f30df901f28212f6a12c998ff9812f9df27f88b: 10 objects (1 commit, 5 trees,
4 blobs), no archive members/gaps; other advertised refs unchanged.
Nine assignment candidates in tests/rebuild/p2-client.test.cjs at lines
65, 107, 169, 183, 185, 299, 437, 441 and 514, blob
4dec8fb70ce34aa4ce879063ed891f49316c459d, are unchanged synthetic fixtures,
privately compared against the audited parent. Current-file scan passed.
No values disclosed/used. Firebase public web configuration remains distinct
from private/admin/database credentials. Prior archive coverage, scope/pattern
limitations and unverified account settings remain unchanged.

## D031 increment — 2026-10-16

Public source 5f30df901f28212f6a12c998ff9812f9df27f88b minus audited
b5eb2345e00f17943fb42b5c87c5f4b313a622e4: 10 objects (1 commit, 5 trees,
4 blobs), no archive members/gaps; other advertised refs unchanged.
Nine assignment candidates in tests/rebuild/p2-client.test.cjs at lines
65, 107, 169, 183, 185, 299, 400, 404 and 477, blob
77d48d1766eed8514eb8c0fb3b1a8b005d21c3e4, are unchanged synthetic fixtures,
privately compared with the audited parent. Current-file scan passed.
No values disclosed/used. Firebase public web configuration is distinct from
private/admin/database credentials; prior archive coverage, pattern/scope
limits and unverified account settings remain unchanged.

## D030 increment — 2026-10-16

Public source b5eb2345e00f17943fb42b5c87c5f4b313a622e4 minus audited
1bc889a03a5f881b525cb1d43303c3350db5252b: 10 objects (1 commit, 5 trees,
4 blobs), no archive members/gaps; other advertised refs unchanged.
Nine assignment candidates in tests/rebuild/p2-client.test.cjs at lines
65, 107, 169, 183, 185, 299, 371, 375 and 448, blob
2b28047a704200936d10d7d3fed841c16ddb7683, are unchanged synthetic fixtures,
privately compared against the audited parent. Current-file scan passed.
No values disclosed/used. Existing Firebase public web configuration remains
distinct from private/admin/database credentials. Previous archive coverage,
scope/pattern limitations and unverified account settings remain unchanged.

## D029 increment — 2026-10-16

Public source 1bc889a03a5f881b525cb1d43303c3350db5252b minus audited
efc7f624de28fc3456e07ea34f8e22a00b0ab153: 14 objects (1 commit, 7 trees,
6 blobs), no archive members/gaps; other advertised refs unchanged.
Scanner exit 1 reviewed: two index.html:632 matches, blob
f6cc5d6661f634a5d07dc6db6e039a96597387cb, are unchanged Firebase public web
configuration, privately compared, not private/admin/database credentials.
Current-file scan passed. No values printed or used. Prior archive coverage,
scope/pattern/account-setting limitations remain unchanged.

## D028 increment — 2026-10-16

Public source efc7f624de28fc3456e07ea34f8e22a00b0ab153 minus audited
1099aef1d86648f138e2c2123462cda529d229a8: 10 objects (1 commit, 5 trees,
4 blobs), no findings/archive members/gaps. Other advertised refs unchanged.
Current-file scan passed; unchanged public Firebase web configuration is not
private/admin/database credentials. No credential use/account changes. Existing
archive coverage and prior pattern/scope/account-setting limits remain.

## D027 increment — 2026-10-16

Public source 1099aef1d86648f138e2c2123462cda529d229a8 minus audited
d191ba8a6b26e5941462cffb35161877d50a6538: 14 objects (1 commit, 7 trees,
6 blobs), no archive members/gaps; other advertised refs unchanged.
Scanner exit 1 reviewed: two matches at index.html:632, blob
56d8bc262bec57a6751ef44da6fd4a7824ed3e79, identify unchanged Firebase public
web configuration, privately compared, not private/admin/database credentials.
Current-file scan passed; no values printed or used. Previous archive coverage,
scope/pattern and unverified account-setting limits remain unchanged.

## D026 increment — 2026-10-16

Public source d191ba8a6b26e5941462cffb35161877d50a6538 minus audited
f946bee2b6f47af9adec685e94367d6b2290b807: 15 objects (1 commit, 7 trees,
7 blobs), no archive members/gaps; other advertised refs unchanged.
Scanner exit 1 reviewed: two matches at index.html:632, blob
1d94aeaba2bbc71a436c65f79cee5c6cb90d0e95, are unchanged Firebase public web
configuration, privately compared, not private/admin/database credentials.
Current-file scan passed. No values printed or used; previous archive coverage,
scope/pattern and unverified account-setting limitations remain.

## D025 increment — 2026-10-16

Public source f946bee2b6f47af9adec685e94367d6b2290b807 minus audited
370e6d1906cdbfc2790f853f22d8441534f249c6: 10 objects (1 commit, 5 trees,
4 blobs), no findings/new archive members/gaps. Rechecked unchanged refs before
resuming D025; reused the completed incremental scan. Current-file scan passed.
Existing Firebase public web configuration remains distinct from private/admin/
database credentials. No credential use/account action; prior archive coverage,
scope/pattern limitations and unverified account settings remain.

## D024 increment — 2026-10-16

Public source 370e6d1906cdbfc2790f853f22d8441534f249c6 minus audited
4f0726ab6f8722fbbdcab15bbfdc1581504aafd8: 15 objects (1 commit, 7 trees,
7 blobs), no archive members/gaps; other advertised refs unchanged.
Scanner exit 1 reviewed: two index.html:632 matches, blob
1dfa80f6e404981ffee59da6d3ae72bf9d6f792c, identify unchanged Firebase public
web configuration, not private/admin/database credentials. Assignment candidate
at tests/rebuild/luckybox-retry.test.cjs:88, blob
4e9eb39be184895ee291c571f28865d94fc5b42c, is the unchanged synthetic resume
fixture. Compared privately against prior audited source; no values printed or
used. Current-file scan passed. Prior archives/scope/pattern/account limits remain.

## D023 increment — 2026-10-16

Public source 4f0726ab6f8722fbbdcab15bbfdc1581504aafd8 minus audited
77c23b6ae94316e7d6f2cbea40e7166d65d98ca7: 10 objects (1 commit, 5 trees,
4 blobs), no archive members/gaps; other advertised refs unchanged.
Scanner exit 1 reviewed: tests/rebuild/luckybox-retry.test.cjs:42, blob
9151200e1e2025f112d24864d622d6e89f5014ae, is the fabricated resume-token
fixture introduced by D022, not a provider credential. No value printed or used.
Current-file scan passed; Firebase public web configuration unchanged and distinct
from private/admin/database credentials. Prior archive coverage and bounded-pattern,
scope and account-setting limits remain. No account actions taken.

## D022 increment — 2026-10-16

Public source 77c23b6ae94316e7d6f2cbea40e7166d65d98ca7 minus audited
0be32d8a4464a4f904ae71182504d0fa12e49db4: 15 objects (1 commit, 7 trees,
7 blobs), no new archive members/gaps. Other advertised refs unchanged.
Scanner exit 1 reviewed: two matches at index.html:632, blob
966c7b836903665a907ef0a8fe077661ee8db6b2, are unchanged Firebase public web
configuration, compared privately against audited source; not private/admin/
database credentials. Current-file scan passed. No values printed or used.
Existing archive coverage and all previous scope/pattern/account limits remain.

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

## S002 incremental extension — 2026-10-14

Source: bf8992ccafa386879b942789ea665f7d996c38b3.
Fetched branch refs plus advertised PR #1 head (171a3a6c83ca1871819a9be9a683419fa2bea877)
and merge (17c9dbf5a5f13f9ce83a1944f4d63f3593131288). Branch heads are unchanged
except development as recorded above. No tag ref was returned by the refs inventory.
The PR head was already covered by phase4a-vps; the synthetic merge was not.

Compared the fetched object graph against the previous audited branch tips,
including development at 093adf096e9f58007fce61f5dd2746612d7f4b25.
Inspected 8 additional objects: 2 commits, 4 trees and 2 blobs. Scanned both blobs
and commit messages with the retained custom provider/assignment patterns.
No matches, new archives or archive-read gaps occurred in this increment.
Existing current blobs/archives reuse S001 coverage rather than a repeated full scan.
This closes the known PR #1 reachable-object exclusion only; all other S001
limitations remain. Pattern coverage is bounded, not a guarantee of no secrets.
No credentials were used and no account or production state was changed.

## S003 tooling and increment — 2026-10-15

Source: 7b7b64b4a7802d8ac80c743407cc458589c0c748; visibility public.
The new reproducible audit tool scanned the 7 objects added after bf8992c:
1 commit, 3 trees, 3 blobs. No findings, archive members or gaps in this increment.
All other advertised refs match S002. Prior current-file/archive coverage is reused,
not repeated. New tool tests use fabricated markers only. See AUDIT_TOOL.md.
This does not extend prior pattern coverage retroactively or verify live account
restrictions; S001/S002 limitations remain.

## D004 incremental audit — 2026-10-15

Public development source 9a45c879f81a106ca6fbf8a34fe105f42bb3c237 compared with
7b7b64b4a7802d8ac80c743407cc458589c0c748: 14 new objects (1 commit, 7 trees,
6 blobs), zero pattern findings/gaps/archive members. Other advertised refs
match S002. Existing current blobs and archives reuse prior evidence. Working
changes contain synthetic test identifiers only and passed check-secrets.cjs.
Account-side restrictions and all previous scan limitations remain unverified.

## D005 incremental audit — 2026-10-15

Public source 4441489f2b35e36217a8bc7a7a32f0569a3554c3 minus audited
9a45c879f81a106ca6fbf8a34fe105f42bb3c237: 10 objects (1 commit, 5 trees,
4 blobs), no new archive members or coverage gaps. One credential-assignment
candidate at tests/rebuild/p7-vip.test.cjs:12, blob
e05b47ec2e4ee993c5caeebb788d858c7220c9e8, is the existing synthetic signing
fixture used by local tests; no value is reproduced here. Scanner exit 1 requires
this review and is not silently treated as a clean scan. No confirmed privileged
credential. Other refs unchanged; prior coverage/limitations remain applicable.

## D006 increment — 2026-10-15

Public source 6ea18e9a976a70d3911129b915509e8406db8934 minus audited
4441489f2b35e36217a8bc7a7a32f0569a3554c3: 10 objects (1 commit, 5 trees,
4 blobs), no findings/gaps/new archives. Other advertised refs unchanged.
Current changed files passed the existing configuration/credential scanner;
generated client retains its previously classified Firebase web configuration.
No credential was used. Previous exclusions and pattern limitations remain.

## D007 increment — 2026-10-15

Public source c73504c97d13b4c22d63f2c5cd0974f9f40b0c94 minus audited
6ea18e9a976a70d3911129b915509e8406db8934: 14 objects (1 commit, 7 trees,
6 blobs), zero new archive members/gaps. Other advertised refs unchanged.
Scanner exit 1: Firebase web API key and assignment detections at index.html:632,
blob 10b1baf0a00963d29cae5eb942c2c87e48b95300, are the unchanged public
web configuration, not Firebase private/admin/database credentials. Assignment
candidate at tests/rebuild/p6-client.test.cjs:102, blob
8aa2f9bb82c38953e02a2b0d941efc656b5ddf8d, is an unchanged synthetic test
token. Compared assignments privately with the prior audited source; no values
printed or used. Current changed files pass check-secrets.cjs. No confirmed new
privileged credential; existing account-setting and pattern limitations remain.

## D008 increment — 2026-10-15

Public source 250005dce44741de6e2a4587d40c903c8f662978 minus audited
c73504c97d13b4c22d63f2c5cd0974f9f40b0c94: 15 objects (1 commit, 7 trees,
7 blobs), no new archive members/gaps; all other advertised refs unchanged.
Scanner exit 1 was reviewed: index.html:632, blob
86130b08cc2e1122efa302fdf0919d5f167ae5ba, contains two detections of the
unchanged Firebase public web configuration assignment, not private/admin/database
credentials. tests/rebuild/p6-client.test.cjs:102, blob
5d7a157e2719119bbbb4ca8c22cd5142920b7be4, is an unchanged synthetic token
fixture. Compared privately against the prior audited source without printing
values. Current changed files pass check-secrets.cjs. No confirmed new privileged
credential; no credential use or account actions. Prior scan exclusions and
account-setting limitations remain.

## D009 increment — 2026-10-15

Public source 44ae105e99cf0a57bdb9b4d2d8aa0edd942d85d7 minus audited
250005dce44741de6e2a4587d40c903c8f662978: 10 objects (1 commit, 5 trees,
4 blobs), no new archive members/gaps. Other advertised refs unchanged.
Scanner exit 1: assignment candidate at tests/rebuild/p6-client.test.cjs:102,
blob 6911a7da9df2783435df04c5c9bed3ef60b473c7, is an unchanged synthetic
test token, privately compared against prior audited source. No value printed
or used. Current-file configuration/credential scan passed; public Firebase web
configuration remains unchanged, distinct from private/admin credentials.
No confirmed new privileged credential. Existing pattern, scope and account-side
verification limitations still apply.

## D010 increment — 2026-10-15

Public source 6f7da691452e86dfe23debbd0fee61a552d1250c minus audited
44ae105e99cf0a57bdb9b4d2d8aa0edd942d85d7: 14 objects (1 commit, 7 trees,
6 blobs), no new archive members/gaps. Other advertised refs unchanged.
Scanner exit 1 candidates: Firebase web API key and assignment at index.html:632,
blob 43411b08c8e6dafa3a7e8a95de786aa3c85f56d6. Both identify the same unchanged
public Firebase web configuration, privately compared with prior audited source;
not private/admin/database credentials. Values were not printed or used.
Current files passed check-secrets.cjs. No confirmed new privileged credential;
prior scan scope/pattern and account-setting limitations remain.

## D011 increment — 2026-10-15

Public source 91351e1ca9cecc8d999c3667c03f78317ffa3642 minus audited
6f7da691452e86dfe23debbd0fee61a552d1250c: 14 objects (1 commit, 7 trees,
6 blobs), no new archive members/gaps. All other advertised refs unchanged.
Scanner exit 1: two detections at index.html:632, blob
1e345bb4da1e835dd6d5731a2efb021b5566a8ad, identify the same unchanged Firebase
public web assignment, verified privately against prior source. No private/admin
credential identified; no values printed or used. Current-file scan passed.
No confirmed new privileged credential; previous exclusions and bounded-pattern
limitations remain, including unverified account settings.

## D012 increment — 2026-10-15

Public source 2ab4b0b3deeaad5b8ebdba991ae048daff125e37 minus audited
91351e1ca9cecc8d999c3667c03f78317ffa3642: 17 objects (1 commit, 7 trees,
9 blobs), no new archive members/gaps. Rechecked refs before resuming work;
all unchanged. Scanner exit 1 reviewed: two detections of the same unchanged
Firebase public web assignment at index.html:632, blob
15f0863ef3a06cff727d8f2226f4ba294006f3e3; synthetic assignment at
tests/rebuild/handoff-invariant.cjs:91, blob
0ef81dd47b51e53b7df074ce44f2a8e0e8897f25. Compared privately with prior source;
no values printed or used. Public configuration is not a private/admin secret.
Current-file scan passed, no confirmed new privileged credential. Previous
pattern/scope limitations and unverified account settings remain.

## D013 increment — 2026-10-15

Public source d8076e2de798fce8845dc34003de21d7d6899ef1 minus audited
2ab4b0b3deeaad5b8ebdba991ae048daff125e37: 15 objects (1 commit, 7 trees,
7 blobs), no new archive members/gaps; other advertised refs unchanged.
Scanner exit 1: two detections of the unchanged Firebase public web assignment
at index.html:632, blob 1d4eb0072c71ceb244cd01538dc6abb1e59cca27.
Privately compared with prior source, values never printed or used. No private/admin
credential identified. Current-file scan passed. Previous exclusions, pattern
limitations and unverified account settings remain; no account actions taken.

## D014 increment — 2026-10-15

Public source 5b28809fb3e00873a500aaa639441d5b978c3360 minus audited
d8076e2de798fce8845dc34003de21d7d6899ef1: 17 objects (1 commit, 7 trees,
9 blobs), no new archive members/gaps. Other advertised refs unchanged.
Scanner exit 1 reviewed: two detections at index.html:632, blob
fbc9e9f6cf41d84f0138d181040bb0a2c30b272f, identify unchanged Firebase public
web configuration, compared privately with audited source. This is not a
private/admin/database credential. Values never printed or used. Current-file
scan passed. No confirmed new privileged credential; prior exclusions, bounded
pattern limits and unverified account settings still apply.

## D015 increment — 2026-10-15

Public source 27828474db2710c54346f2ec4e970421d33d942e minus audited
5b28809fb3e00873a500aaa639441d5b978c3360: 10 objects (1 commit, 5 trees,
4 blobs), zero findings/gaps/new archive members. Other advertised refs unchanged.
Current files pass check-secrets.cjs; unchanged current/historical archives reuse
prior bounded evidence. Firebase public web configuration remains distinct from
private/admin/database credentials. No credentials used or account changes made.
Prior exclusions, pattern limits and unverified account settings still apply.

## D016 increment — 2026-10-15

Public source 214fe2f8a859e5a2b2129a4dc53c06451ab9285c minus audited
27828474db2710c54346f2ec4e970421d33d942e: 10 objects (1 commit, 5 trees,
4 blobs), no findings/gaps/new archive members. Other advertised refs unchanged.
Current-file configuration/credential scan passed. Existing current/historical
archives reuse prior bounded evidence. Firebase public web configuration is
unchanged and distinct from private/admin/database secrets. No credential use
or account actions. Prior scope/pattern and account-verification limits remain.

## D017 increment — 2026-10-16

Public source 156e54c1afa154e094fe042ab6abd45ed8fe8a58 minus audited
214fe2f8a859e5a2b2129a4dc53c06451ab9285c: 15 objects (1 commit, 7 trees,
7 blobs), no new archive members/gaps. Other advertised refs unchanged.
Scanner exit 1 reviewed: two detections at index.html:632, blob
77ca9f12f031c2426e0bffbb67df81d510fc0efa, are unchanged Firebase public web
configuration, privately compared against audited source. Not private/admin/
database credentials. No values printed or used. Current-file scan passed;
prior scope/pattern/account-setting limitations remain.

## D018 increment — 2026-10-16

Public source b3721a52d51dd4ae75c121fb02cf23f6282e1256 minus audited
156e54c1afa154e094fe042ab6abd45ed8fe8a58: 14 objects (1 commit, 7 trees,
6 blobs), no new archive members/gaps. Other advertised refs unchanged.
Scanner exit 1 reviewed: two matches at index.html:632, blob
b51fa556f0a09f1f8dd11aa402c41f2fd5d5bfe0, are unchanged Firebase public web
configuration, compared privately. Not Firebase private/admin/database secrets.
No values printed or used. Existing archives reuse prior bounded evidence.
Current-file scan passed; previous exclusions/pattern/account limits remain.

## D019 increment — 2026-10-16

Public source 9512dd83ef09a7d00c846089350e86ced42a126d minus audited
b3721a52d51dd4ae75c121fb02cf23f6282e1256: 7 objects (1 commit, 3 trees,
3 blobs), zero findings/gaps/new archive members. Other advertised refs unchanged.
Current-file scan passed; existing current/historical archives reuse prior bounded
evidence. Firebase public web configuration remains unchanged, distinct from
private/admin/database credentials. No credential use or account actions.
Previous exclusions, pattern limits and unverified account settings remain.

## D020 increment — 2026-10-16

Public source 8ec69d788757a068b030636b2944a1ffa63f230f minus audited
9512dd83ef09a7d00c846089350e86ced42a126d: 10 objects (1 commit, 5 trees,
4 blobs), no findings/gaps/new archive members. Other advertised refs unchanged.
Current-file scan passed. Existing current/historical archives reuse prior bounded
evidence. Unchanged Firebase public web configuration is not a private/admin/
database credential. No credentials used; prior scope/pattern/account limits remain.

## D021 increment — 2026-10-16

Public source 0be32d8a4464a4f904ae71182504d0fa12e49db4 minus audited
8ec69d788757a068b030636b2944a1ffa63f230f: 14 objects (1 commit, 7 trees,
6 blobs), no archive members/gaps. Other advertised refs unchanged.
Scanner exit 1 reviewed: two matches at index.html:632, blob
3116ea09737037e2190b4adb91b65991f6efd463, identify unchanged Firebase public
web configuration (privately compared), not private/admin/database credentials.
Current-file scan passed; no values printed or used. Existing archive coverage
and previous scope/pattern/account limits remain unchanged.

## D073 reviewed production-prep increment — 2026-10-24

Reviewed commits 0e03ae3..91c2ae1 after the last passing Gate 7 baseline.
The increment contains production-readiness scaffolding, a fail-closed legacy
payment-mode guard, staging-selector separation, and synthetic payment-test
fixtures. Pattern review of every commit diff found no Firebase key, GitHub
token, private key, provider credential, merchant credential, or account secret.

The only credential-pattern candidates came from historical intermediate blobs
where the synthetic harness assigned deliberately fabricated values to
`SLIP2GO_API_SECRET` and `PAYMENT_WEBHOOK_SECRET`. Those values were test-only,
were never provider credentials, and the current harness constructs the same
synthetic fixtures without credential-shaped literal assignments. No secret
value is recorded in this review.

This reviewed increment may be used as the next exclusion baseline for the
bounded committed-history scanner. Future commits remain fail-closed and are
scanned normally.
