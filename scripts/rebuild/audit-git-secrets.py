"""Read-only bounded Git/ZIP pattern audit; outputs locations, never match values.
No fetching or credential validation. Excluded tips must have prior audit evidence.
"""
import argparse
import io
import json
import re
import subprocess
import zipfile
import zlib
from pathlib import Path

patterns={
'Firebase web API key':r'AIza[0-9A-Za-z_-]{35}',
'Ably full API key':r'(?<![\w])[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{6}:[A-Za-z0-9+/=_-]{20,}',
'GitHub token':r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})',
'Private key material':r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
'AWS access key':r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
'Google OAuth secret':r'GOCSPX-[A-Za-z0-9_-]{20,}',
'Stripe secret':r'\b(?:sk|rk)_live_[A-Za-z0-9]{16,}',
'Slack token':r'\bxox[baprs]-[A-Za-z0-9-]{20,}',
'JWT literal':r'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}',
'Credential assignment candidate':r'''(?i)(?:["']?(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_KEY|FIREBASE_SECRET|FIREBASE_DATABASE_SECRET|FIREBASE_TOKEN|ABLY_API_KEY|SLIP2GO_API_SECRET|PAYMENT_WEBHOOK_SECRET|client_secret|private_key|api_secret|apiKey|api_key|access_token|auth_token|password|secret|token)["']?\s*[:=]\s*["'])([^"'\r\n]{12,})["']'''
}

PATTERNS = {name: re.compile(pattern) for name, pattern in patterns.items()}
PATTERNS["Unquoted credential assignment"] = re.compile(
    r"(?im)^\s*(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_KEY|FIREBASE_SECRET|FIREBASE_DATABASE_SECRET|FIREBASE_TOKEN|ABLY_API_KEY)\s*=\s*[^\s\"']{12,}")
PATTERNS["Authorization credential"] = re.compile(
    r"(?i)authorization[\"']?\s*[:=]\s*[\"'](?:Bearer|Basic)\s+[^\"'\r\n]{12,}")


def safe_location(value):
    for pattern in PATTERNS.values():
        value = pattern.sub("[REDACTED]", value)
    return value


class Scanner:
    def __init__(self, max_bytes=20_000_000, max_members=2000, max_depth=4):
        self.remaining = max_bytes
        self.max_members = max_members
        self.max_depth = max_depth
        self.members = 0
        self.findings = []
        self.gaps = []

    def gap(self, path, oid, reason):
        self.gaps.append(dict(path=safe_location(path), object=oid, reason=reason))

    def scan(self, data, path, oid, depth=0, charged=False):
        if not charged:
            if len(data) > self.remaining:
                self.gap(path, oid, "byte budget exceeded")
                return
            self.remaining -= len(data)
        is_zip = zipfile.is_zipfile(io.BytesIO(data))
        if is_zip:
            if depth >= self.max_depth:
                self.gap(path, oid, "archive depth exceeded")
                return
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    for info in archive.infolist():
                        if info.is_dir():
                            continue
                        location = path + "!" + info.filename
                        if self.members >= self.max_members:
                            self.gap(path, oid, "archive member budget exceeded")
                            break
                        self.members += 1
                        if info.file_size > self.remaining:
                            self.gap(location, oid, "byte budget exceeded")
                            continue
                        # Stream with a cap; never trust metadata or extract files.
                        with archive.open(info) as member:
                            payload = member.read(self.remaining + 1)
                        self.scan(payload, location, oid, depth + 1)
            except (OSError, ValueError, RuntimeError, NotImplementedError, EOFError, zlib.error, zipfile.BadZipFile):
                self.gap(path, oid, "archive unreadable")
            return
        if data.startswith(b"PK\x03\x04") or path.lower().endswith(".zip"):
            self.gap(path, oid, "invalid ZIP archive")
        if path.lower().endswith((".gz", ".tar", ".tgz", ".7z", ".rar", ".xz", ".bz2")):
            self.gap(path, oid, "unsupported archive format")
        text = data.decode("utf-8", errors="replace")
        for kind, pattern in PATTERNS.items():
            for match in pattern.finditer(text):
                self.findings.append(dict(type=kind, path=safe_location(path),
                    line=text.count("\n", 0, match.start()) + 1, object=oid,
                    classification="public-web-configuration-review" if kind == "Firebase web API key"
                    else "credential-candidate-review"))


def git(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    if result.returncode:
        # Git errors may include raw paths or object contents: never echo stderr.
        raise ValueError("Git operation failed; inspect repository access privately")
    return result.stdout


def audit(repo, include, exclude):
    for oid in include + exclude:
        if not re.fullmatch(r"[0-9a-f]{40}", oid):
            raise ValueError("Full SHA-1 commit IDs required")
        if git(repo, "cat-file", "-t", oid).strip() != b"commit":
            raise ValueError("Expected a commit object")
    if git(repo, "rev-parse", "--is-shallow-repository").strip() != b"false":
        raise ValueError("Shallow history is not supported")
    args = ["rev-list", "--objects", *include]
    if exclude:
        args += ["--not", *exclude]
    entries = git(repo, *args).decode().splitlines()
    scanner = Scanner()
    counts = {}
    for entry in entries:
        oid, _, location = entry.partition(" ")
        kind = git(repo, "cat-file", "-t", oid).strip().decode()
        counts[kind] = counts.get(kind, 0) + 1
        if kind not in ("blob", "commit", "tag"):
            continue
        size = int(git(repo, "cat-file", "-s", oid))
        location = location or "(commit/tag message)"
        if size > scanner.remaining:
            scanner.gap(location, oid, "byte budget exceeded")
            continue
        scanner.scan(git(repo, "cat-file", "-p", oid), location, oid)
    return dict(schema=1, includedTips=include, excludedAuditedTips=exclude,
        objects=len(entries), types=counts, archiveMembers=scanner.members,
        findings=scanner.findings, gaps=scanner.gaps,
        scope="reachable objects from explicit tips minus previously audited tips; committed data only",
        limitations=["Pattern detection is not proof of absence", "Exclusions require prior audit evidence",
            "No remote ref discovery, working-tree scan, account checks or credential use",
            "ZIP only; other archive formats reported as gaps", "Object IDs identify blobs/messages, not first-introduction commits"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--include", action="append", required=True)
    parser.add_argument("--exclude", action="append", default=[])
    args = parser.parse_args()
    try:
        report = audit(Path(args.repo), args.include, args.exclude)
    except (ValueError, OSError):
        print(json.dumps({"error": "Audit incomplete: invalid revision, missing Git access or shallow history"}))
        return 2
    print(json.dumps(report, indent=2))
    return 2 if report["gaps"] else 1 if report["findings"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
