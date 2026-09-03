"""Tests runtime — sauvegarde PostgreSQL 002 Slack-Grok (atomique, 0600, reprise)."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ANSIBLE_DIR = Path(__file__).resolve().parent
FIXTURES = ANSIBLE_DIR / "test-fixtures" / "slack-grok-pg-backup-002"
RESUME_PLAYBOOK = FIXTURES / "runtime-playbook.yml"
TASKS_FILE = ANSIBLE_DIR / "tasks" / "slack_grok_pg_backup_002.yml"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _mtime_ns(path: Path) -> int:
    return path.stat().st_mtime_ns


class SlackGrokPgBackup002RuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("ansible-playbook") is None:
            raise unittest.SkipTest("ansible-playbook indisponible")
        if not TASKS_FILE.is_file():
            raise unittest.SkipTest("tasks slack_grok_pg_backup_002.yml manquant")

    def _run(
        self,
        workspace: Path,
        *,
        require_root_owner: bool = False,
    ) -> subprocess.CompletedProcess[str]:
        report = workspace / "runtime-report.txt"
        env = {
            **os.environ,
            "ANSIBLE_STDOUT_CALLBACK": "default",
            "ANSIBLE_RETRY_FILES_ENABLED": "false",
        }
        return subprocess.run(
            [
                "ansible-playbook",
                str(RESUME_PLAYBOOK),
                "-e",
                f"repo_root={workspace / 'repo'}",
                "-e",
                f"rollback_pg_backup_dir={workspace / 'bundle' / 'pg-backup'}",
                "-e",
                f"runtime_report_path={report}",
                "-e",
                "slack_grok_pg_dump_mode=fixture",
                "-e",
                f"slack_grok_require_root_owner={str(require_root_owner).lower()}",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=180,
            env=env,
            cwd=str(ANSIBLE_DIR),
        )

    def _combined(self, result: subprocess.CompletedProcess[str]) -> str:
        return f"{result.stdout}\n{result.stderr}"

    def test_initial_creates_pointer_0600_regular_non_symlink_confined(self) -> None:
        with tempfile.TemporaryDirectory(prefix="slack-grok-pg002-init-") as tmp:
            workspace = Path(tmp)
            (workspace / "repo").mkdir()
            result = self._run(workspace)
            combined = self._combined(result)
            self.assertEqual(result.returncode, 0, combined)
            self.assertIn("pg_backup_002=ok", combined)
            self.assertNotIn(str(workspace / "bundle" / "pg-backup"), combined)

            pointer = workspace / "bundle" / "pg-backup" / "latest-002.path"
            self.assertTrue(pointer.is_file())
            self.assertFalse(pointer.is_symlink())
            self.assertEqual(pointer.stat().st_mode & 0o777, 0o600)
            self.assertEqual(pointer.read_text(encoding="utf-8").count("\n"), 1)

            dump_path = Path(pointer.read_text(encoding="utf-8").strip())
            self.assertTrue(dump_path.is_file())
            self.assertFalse(dump_path.is_symlink())
            self.assertGreater(dump_path.stat().st_size, 0)
            self.assertEqual(dump_path.stat().st_mode & 0o777, 0o600)
            self.assertTrue(str(dump_path).startswith(str(workspace / "bundle" / "pg-backup")))
            self.assertIn("pre-002-", dump_path.name)

            report = (workspace / "runtime-report.txt").read_text(encoding="utf-8")
            self.assertIn("reuse_pg_backup_002=false", report)
            self.assertIn("detect=absent", report)

    def test_resume_reuses_dump_without_replacement(self) -> None:
        with tempfile.TemporaryDirectory(prefix="slack-grok-pg002-resume-") as tmp:
            workspace = Path(tmp)
            (workspace / "repo").mkdir()
            first = self._run(workspace)
            self.assertEqual(first.returncode, 0, self._combined(first))

            pointer = workspace / "bundle" / "pg-backup" / "latest-002.path"
            before = {
                "pointer_sha": _sha256(pointer),
                "pointer_mtime": _mtime_ns(pointer),
                "dump_count": len(list((workspace / "bundle" / "pg-backup").glob("pre-002-*.dump"))),
                "dump_sha": _sha256(Path(pointer.read_text(encoding="utf-8").strip())),
            }

            second = self._run(workspace)
            combined = self._combined(second)
            self.assertEqual(second.returncode, 0, combined)
            self.assertIn("reuse_pg_backup_002=true", combined)
            self.assertNotIn("pg_backup_002=ok", combined)
            self.assertNotIn(str(pointer), combined)

            after_dumps = list((workspace / "bundle" / "pg-backup").glob("pre-002-*.dump"))
            self.assertEqual(len(after_dumps), before["dump_count"])
            self.assertEqual(_sha256(pointer), before["pointer_sha"])
            self.assertEqual(_mtime_ns(pointer), before["pointer_mtime"])
            self.assertEqual(
                _sha256(Path(pointer.read_text(encoding="utf-8").strip())),
                before["dump_sha"],
            )

            report = (workspace / "runtime-report.txt").read_text(encoding="utf-8")
            self.assertIn("reuse_pg_backup_002=true", report)
            self.assertIn("detect=complete", report)

    def test_invalid_pointer_symlink_rejected_without_path_leak(self) -> None:
        with tempfile.TemporaryDirectory(prefix="slack-grok-pg002-symlink-") as tmp:
            workspace = Path(tmp)
            (workspace / "repo").mkdir()
            pg = workspace / "bundle" / "pg-backup"
            pg.mkdir(parents=True)
            dump = pg / "pre-002-seed.dump"
            dump.write_text("seed\n", encoding="utf-8")
            dump.chmod(0o600)
            pointer = pg / "latest-002.path"
            pointer.symlink_to(dump)

            result = self._run(workspace)
            combined = self._combined(result)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid_pg_backup_pointer", combined)
            self.assertNotIn(str(pointer), combined)
            self.assertNotIn(str(dump), combined)

    def test_external_dump_path_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="slack-grok-pg002-ext-") as tmp:
            workspace = Path(tmp)
            (workspace / "repo").mkdir()
            pg = workspace / "bundle" / "pg-backup"
            pg.mkdir(parents=True)
            external = workspace / "outside.dump"
            external.write_text("external\n", encoding="utf-8")
            external.chmod(0o600)
            pointer = pg / "latest-002.path"
            pointer.write_text(f"{external}\n", encoding="utf-8")
            pointer.chmod(0o600)

            result = self._run(workspace)
            combined = self._combined(result)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid_pg_backup_pointer", combined)
            self.assertNotIn(str(external), combined)
            self.assertNotIn(str(pointer), combined)

    def test_empty_dump_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="slack-grok-pg002-empty-") as tmp:
            workspace = Path(tmp)
            (workspace / "repo").mkdir()
            pg = workspace / "bundle" / "pg-backup"
            pg.mkdir(parents=True)
            empty = pg / "pre-002-empty.dump"
            empty.write_text("", encoding="utf-8")
            empty.chmod(0o600)
            pointer = pg / "latest-002.path"
            pointer.write_text(f"{empty}\n", encoding="utf-8")
            pointer.chmod(0o600)

            result = self._run(workspace)
            combined = self._combined(result)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("invalid_pg_backup_pointer", combined)
            self.assertNotIn(str(empty), combined)


if __name__ == "__main__":
    unittest.main()
