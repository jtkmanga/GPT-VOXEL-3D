# Bounded incremental credential audit

Use Python 3 and Git. No extra packages, network or credentials are needed.
First read the audit record and fetch/inventory authorized refs separately.
Pass full commit IDs; repeat `--include` for every branch/PR tip in scope and
`--exclude` for each previously audited tip with retained evidence:

```sh
python scripts/rebuild/audit-git-secrets.py --include FULL_CURRENT_COMMIT_ID --exclude FULL_AUDITED_COMMIT_ID
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests/rebuild -p test_audit_git_secrets.py -v
```

Exit 0 means no pattern matches/gaps within the selected increment; 1 means
candidates requiring review; 2 means incomplete coverage or invalid input.
Do not describe exit 0 as proof the repository is safe. Findings identify object
IDs, paths and lines, not values or first-introduction commits. Include the
source tip in the review report. Do not use or rotate discovered credentials.
Firebase web configuration is distinct from privileged credential candidates.
Synthetic markers are not automatically exempted: review candidates privately.

This tool scans committed blobs/messages reachable from explicit commit tips.
It does not discover refs, scan dirty/untracked files, verify a previous audit,
or inspect remote accounts, releases, Actions logs or unreachable objects.
Excluded tips are a trust boundary: use only evidence-backed exclusions.
Run the existing check-secrets.cjs plus private diff review for uncommitted work.
New patterns do not retroactively cover excluded objects.

ZIP files are inspected in memory without extraction. Defaults: 20 MB cumulative
input/decompressed bytes, 2,000 members, four archive levels. Limits, unreadable
ZIPs and unsupported archive extensions produce gaps. Other encodings/formats
and unrecognized credential patterns may evade detection. Never commit raw logs
or matching values; sanitize unusual filenames manually before publication.
The Python tests are explicit and are not yet part of npm test.
