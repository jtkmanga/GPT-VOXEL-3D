"""Synthetic-only regressions for bounded secret auditing."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import zipfile

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/rebuild/audit-git-secrets.py'
spec = importlib.util.spec_from_file_location('audit', SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
TOKEN = 'ghp_' + 'S' * 36  # fabricated marker, never used with a provider
WEB_KEY = 'AIza' + 'W' * 35


def archive(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as out:
        for name, data in entries:
            out.writestr(name, data)
    return buffer.getvalue()


class ScanTests(unittest.TestCase):
    def test_output_redacts_values_and_locations(self):
        scanner = audit.Scanner()
        scanner.scan(('one\n' + TOKEN).encode(), TOKEN + '.txt', 'a' * 40)
        self.assertEqual(scanner.findings[0]['line'], 2)
        self.assertEqual(scanner.findings[0]['type'], 'GitHub token')
        self.assertNotIn(TOKEN, json.dumps(scanner.findings))

    def test_web_configuration_separate_from_private_credentials(self):
        scanner = audit.Scanner()
        scanner.scan((WEB_KEY + '\n-----BEGIN ' + 'PRIVATE KEY-----').encode(), 'config', 'a' * 40)
        self.assertEqual({f['classification'] for f in scanner.findings},
                         {'public-web-configuration-review', 'credential-candidate-review'})
        self.assertNotIn(WEB_KEY, json.dumps(scanner.findings))

    def test_nested_zip_scans_without_extraction(self):
        scanner = audit.Scanner()
        scanner.scan(archive([('nested.zip', archive([('../../key.txt', TOKEN)]))]), 'outer.zip', 'a' * 40)
        self.assertEqual(scanner.members, 2)
        self.assertEqual(scanner.findings[0]['path'], 'outer.zip!nested.zip!../../key.txt')
        self.assertEqual(scanner.gaps, [])

    def test_depth_and_member_limits_are_gaps(self):
        nested = archive([('inner.zip', archive([('key', TOKEN)]))])
        scanner = audit.Scanner(max_depth=1)
        scanner.scan(nested, 'outer.zip', 'a' * 40)
        self.assertEqual(scanner.gaps[0]['reason'], 'archive depth exceeded')
        scanner = audit.Scanner(max_members=1)
        scanner.scan(archive([('one', ''), ('two', TOKEN)]), 'outer.zip', 'a' * 40)
        self.assertEqual(scanner.gaps[0]['reason'], 'archive member budget exceeded')

    def test_expansion_and_total_byte_limits(self):
        scanner = audit.Scanner(max_bytes=1024)
        scanner.scan(archive([('large', b'x' * 5000)]), 'outer.zip', 'a' * 40)
        self.assertEqual(scanner.gaps[0]['reason'], 'byte budget exceeded')
        scanner = audit.Scanner(max_bytes=10)
        scanner.scan(b'x' * 6, 'one', 'a' * 40)
        scanner.scan(b'x' * 6, 'two', 'b' * 40)
        self.assertEqual(len(scanner.gaps), 1)

    def test_invalid_and_unsupported_archive_gaps(self):
        scanner = audit.Scanner()
        scanner.scan(b'PK\x03\x04broken', 'broken.zip', 'a' * 40)
        scanner.scan(b'unknown', 'archive.7z', 'b' * 40)
        self.assertEqual(len(scanner.gaps), 2)

    def test_environment_and_authorization_detection(self):
        scanner = audit.Scanner()
        scanner.scan(('CF_API_TOKEN=' + 'S' * 30 + '\nAuthorization: "Bearer ' + 'Q' * 30 + '"').encode(), 'config', 'a' * 40)
        self.assertEqual({f['type'] for f in scanner.findings},
                         {'Unquoted credential assignment', 'Authorization credential'})


class GitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Synthetic Test')
        self.git('config', 'user.email', 'test@example.invalid')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args], stderr=subprocess.DEVNULL).decode().strip()

    def commit(self, text):
        (self.repo / 'file.txt').write_text(text)
        self.git('add', 'file.txt')
        self.git('commit', '-qm', 'synthetic fixture')
        return self.git('rev-parse', 'HEAD')

    def test_increment_excludes_old_objects_and_same_tip_is_empty(self):
        first = self.commit(TOKEN)
        second = self.commit('clean replacement')
        report = audit.audit(self.repo, [second], [first])
        self.assertEqual(report['findings'], [])
        self.assertEqual(report['types']['blob'], 1)
        self.assertEqual(audit.audit(self.repo, [second], [second])['objects'], 0)
        self.assertTrue(audit.audit(self.repo, [second], [])['findings'])

    def test_cli_findings_exit_nonzero_without_values(self):
        head = self.commit(TOKEN)
        result = subprocess.run(['python', str(SCRIPT), '--repo', str(self.repo), '--include', head], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertTrue(json.loads(result.stdout)['findings'])

    def test_invalid_revision_and_shallow_history_fail_closed(self):
        head = self.commit('clean')
        with self.assertRaises(ValueError):
            audit.audit(self.repo, ['--all'], [])
        (self.repo / '.git/shallow').write_text(head + '\n')
        with self.assertRaises(ValueError):
            audit.audit(self.repo, [head], [])


if __name__ == '__main__':
    unittest.main()
