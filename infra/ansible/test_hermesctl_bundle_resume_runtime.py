"""Tests runtime — reprise bundle hermesctl (absent / complet / partiel / legacy dist)."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ANSIBLE_DIR = Path(__file__).resolve().parent
FIXTURES = ANSIBLE_DIR / "test-fixtures" / "hermesctl-bundle-resume"
RESUME_PLAYBOOK = FIXTURES / "runtime-playbook.yml"
ROLLBACK_DIST_PLAYBOOK = FIXTURES / "runtime-rollback-dist.yml"
TASKS_FILE = ANSIBLE_DIR / "tasks" / "hermesctl_v1_rollback_bundle.yml"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _mtime_ns(path: Path) -> int:
    return path.stat().st_mtime_ns


class HermesctlBundleResumeRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("ansible-playbook") is None:
            raise unittest.SkipTest("ansible-playbook indisponible")
        if not TASKS_FILE.is_file():
            raise unittest.SkipTest("tasks hermesctl_v1_rollback_bundle.yml manquant")

    def _run_resume(self, workspace: Path) -> subprocess.CompletedProcess[str]:
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
                f"rollback_bundle_dir={workspace / 'bundle'}",
                "-e",
                f"rollback_scripts_dir={workspace / 'bundle' / 'scripts'}",
                "-e",
                f"rollback_api_src_dir={workspace / 'bundle' / 'app-src'}",
                "-e",
                f"rollback_dist_dir={workspace / 'bundle' / 'app-dist'}",
                "-e",
                f"rollback_compose_file={workspace / 'bundle' / 'compose.yml'}",
                "-e",
                f"rollback_pg_backup_dir={workspace / 'bundle' / 'pg-backup'}",
                "-e",
                f"runtime_report_path={report}",
                "-e",
                "hermesctl_pg_dump_mode=fixture",
                "-e",
                "hermesctl_require_root_owner=false",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=180,
            env=env,
            cwd=str(ANSIBLE_DIR),
        )

    def _seed_repo(self, workspace: Path, *, with_dist: bool) -> None:
        repo = workspace / "repo"
        (repo / "scripts").mkdir(parents=True)
        (repo / "scripts" / "cp-api.sh").write_text("#!/bin/sh\necho ok\n", encoding="utf-8")
        (repo / "app" / "src").mkdir(parents=True)
        (repo / "app" / "src" / "index.ts").write_text("export {}\n", encoding="utf-8")
        (repo / "compose.yml").write_text("services:\n  api:\n    image: test\n", encoding="utf-8")
        if with_dist:
            (repo / "app" / "dist").mkdir(parents=True)
            (repo / "app" / "dist" / "daemon.js").write_text("console.log(1)\n", encoding="utf-8")

    def _seed_complete_bundle(
        self,
        workspace: Path,
        *,
        dist_state: str = "absent",
    ) -> Path:
        """dist_state: absent | present | legacy (ni app-dist ni marqueur)."""
        bundle = workspace / "bundle"
        (bundle / "scripts").mkdir(parents=True)
        (bundle / "scripts" / "cp-api.sh").write_text("#!/bin/sh\nold\n", encoding="utf-8")
        (bundle / "app-src").mkdir(parents=True)
        (bundle / "app-src" / "index.ts").write_text("export const old = 1\n", encoding="utf-8")
        (bundle / "compose.yml").write_text("services:\n  api:\n    image: old\n", encoding="utf-8")
        pg = bundle / "pg-backup"
        pg.mkdir(parents=True)
        dump = pg / "pre-001-20260101000000.dump"
        dump.write_text("old-dump-content\n", encoding="utf-8")
        dump.chmod(0o600)
        pointer = pg / "latest-001.path"
        pointer.write_text(f"{dump}\n", encoding="utf-8")
        pointer.chmod(0o600)

        if dist_state == "absent":
            marker = bundle / "app-dist.absent"
            marker.write_text("app-dist-absent\n", encoding="utf-8")
            marker.chmod(0o600)
        elif dist_state == "present":
            dist = bundle / "app-dist"
            dist.mkdir(parents=True)
            (dist / "daemon.js").write_text("old-dist\n", encoding="utf-8")
        elif dist_state == "legacy":
            pass
        else:
            raise ValueError(f"dist_state inconnu: {dist_state}")
        return dump

    def test_bundle_absent_creates_backup_and_app_dist_absent_marker(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermesctl-bundle-absent-") as tmp:
            workspace = Path(tmp)
            self._seed_repo(workspace, with_dist=False)
            proc = self._run_resume(workspace)
            combined = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, combined)
            report = (workspace / "runtime-report.txt").read_text(encoding="utf-8")
            self.assertIn("bundle_state=absent", report.replace("True", "true"))
            marker = workspace / "bundle" / "app-dist.absent"
            self.assertTrue(marker.is_file())
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            self.assertTrue((workspace / "bundle" / "scripts" / "cp-api.sh").is_file())
            dumps = list((workspace / "bundle" / "pg-backup").glob("pre-001-*.dump"))
            self.assertEqual(len(dumps), 1)
            pointer = workspace / "bundle" / "pg-backup" / "latest-001.path"
            self.assertTrue(pointer.is_file())
            self.assertFalse(pointer.is_symlink())
            dump_path = Path(pointer.read_text(encoding="utf-8").strip())
            self.assertTrue(str(dump_path).startswith(str(workspace / "bundle" / "pg-backup")))
            self.assertTrue(dump_path.is_file())
            self.assertFalse(dump_path.is_symlink())
            self.assertGreater(dump_path.stat().st_size, 0)
            mode = dump_path.stat().st_mode & 0o777
            self.assertEqual(mode & 0o077, 0)
            self.assertNotIn(str(dump_path), combined)

    def test_bundle_complete_preserves_sha256_mtime_and_dump_count(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermesctl-bundle-complete-") as tmp:
            workspace = Path(tmp)
            self._seed_repo(workspace, with_dist=True)
            dump = self._seed_complete_bundle(workspace, dist_state="present")
            compose = workspace / "bundle" / "compose.yml"
            script = workspace / "bundle" / "scripts" / "cp-api.sh"
            pointer = workspace / "bundle" / "pg-backup" / "latest-001.path"

            before = {
                "compose_sha": _sha256(compose),
                "compose_mtime": _mtime_ns(compose),
                "script_sha": _sha256(script),
                "script_mtime": _mtime_ns(script),
                "dump_sha": _sha256(dump),
                "dump_mtime": _mtime_ns(dump),
                "pointer_sha": _sha256(pointer),
                "pointer_mtime": _mtime_ns(pointer),
                "dump_count": len(list((workspace / "bundle" / "pg-backup").glob("pre-001-*.dump"))),
            }
            time.sleep(0.05)

            proc = self._run_resume(workspace)
            combined = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, combined)
            report = (workspace / "runtime-report.txt").read_text(encoding="utf-8")
            self.assertIn("bundle_state=complete", report)
            self.assertIn("reuse_rollback_bundle=true", report)
            self.assertIn("bundle_dist_state=dist_present", report)
            self.assertIn("reuse_rollback_bundle=true", combined)

            after_dumps = list((workspace / "bundle" / "pg-backup").glob("pre-001-*.dump"))
            self.assertEqual(len(after_dumps), before["dump_count"])
            self.assertEqual(_sha256(compose), before["compose_sha"])
            self.assertEqual(_mtime_ns(compose), before["compose_mtime"])
            self.assertEqual(_sha256(script), before["script_sha"])
            self.assertEqual(_mtime_ns(script), before["script_mtime"])
            self.assertEqual(_sha256(dump), before["dump_sha"])
            self.assertEqual(_mtime_ns(dump), before["dump_mtime"])
            self.assertEqual(_sha256(pointer), before["pointer_sha"])
            self.assertEqual(_mtime_ns(pointer), before["pointer_mtime"])

    def test_bundle_partial_fails_generic(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermesctl-bundle-partial-") as tmp:
            workspace = Path(tmp)
            self._seed_repo(workspace, with_dist=False)
            bundle = workspace / "bundle"
            (bundle / "scripts").mkdir(parents=True)
            (bundle / "scripts" / "only.sh").write_text("x\n", encoding="utf-8")
            proc = self._run_resume(workspace)
            combined = proc.stdout + proc.stderr
            self.assertNotEqual(proc.returncode, 0, combined)
            self.assertIn("rollback_bundle_incomplete", combined)
            self.assertFalse((bundle / "pg-backup").exists())

    def test_legacy_bundle_migrates_marker_when_current_dist_absent(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermesctl-bundle-legacy-") as tmp:
            workspace = Path(tmp)
            self._seed_repo(workspace, with_dist=False)
            dump = self._seed_complete_bundle(workspace, dist_state="legacy")
            compose = workspace / "bundle" / "compose.yml"
            script = workspace / "bundle" / "scripts" / "cp-api.sh"
            pointer = workspace / "bundle" / "pg-backup" / "latest-001.path"
            marker = workspace / "bundle" / "app-dist.absent"

            self.assertFalse(marker.exists())
            before = {
                "compose_sha": _sha256(compose),
                "compose_mtime": _mtime_ns(compose),
                "script_sha": _sha256(script),
                "script_mtime": _mtime_ns(script),
                "dump_sha": _sha256(dump),
                "dump_mtime": _mtime_ns(dump),
                "pointer_sha": _sha256(pointer),
                "pointer_mtime": _mtime_ns(pointer),
                "dump_count": len(list((workspace / "bundle" / "pg-backup").glob("pre-001-*.dump"))),
            }
            time.sleep(0.05)

            proc = self._run_resume(workspace)
            combined = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, combined)
            self.assertIn("legacy_dist_marker_migrated", combined)
            report = (workspace / "runtime-report.txt").read_text(encoding="utf-8")
            self.assertIn("bundle_state=complete", report)
            self.assertIn("reuse_rollback_bundle=true", report)
            self.assertIn("bundle_dist_state=dist_absent", report)
            self.assertIn("legacy_migrated=true", report)

            self.assertTrue(marker.is_file())
            self.assertFalse(marker.is_symlink())
            self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
            self.assertEqual(marker.read_text(encoding="utf-8"), "app-dist-absent\n")
            self.assertFalse((workspace / "bundle" / "app-dist").exists())

            after_dumps = list((workspace / "bundle" / "pg-backup").glob("pre-001-*.dump"))
            self.assertEqual(len(after_dumps), before["dump_count"])
            self.assertEqual(_sha256(compose), before["compose_sha"])
            self.assertEqual(_mtime_ns(compose), before["compose_mtime"])
            self.assertEqual(_sha256(script), before["script_sha"])
            self.assertEqual(_mtime_ns(script), before["script_mtime"])
            self.assertEqual(_sha256(dump), before["dump_sha"])
            self.assertEqual(_mtime_ns(dump), before["dump_mtime"])
            self.assertEqual(_sha256(pointer), before["pointer_sha"])
            self.assertEqual(_mtime_ns(pointer), before["pointer_mtime"])

    def test_legacy_bundle_fails_when_current_dist_present(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermesctl-bundle-legacy-dist-") as tmp:
            workspace = Path(tmp)
            self._seed_repo(workspace, with_dist=True)
            dump = self._seed_complete_bundle(workspace, dist_state="legacy")
            compose = workspace / "bundle" / "compose.yml"
            script = workspace / "bundle" / "scripts" / "cp-api.sh"
            pointer = workspace / "bundle" / "pg-backup" / "latest-001.path"
            marker = workspace / "bundle" / "app-dist.absent"

            before = {
                "compose_sha": _sha256(compose),
                "script_sha": _sha256(script),
                "dump_sha": _sha256(dump),
                "pointer_sha": _sha256(pointer),
                "dump_count": len(list((workspace / "bundle" / "pg-backup").glob("pre-001-*.dump"))),
                "marker_exists": marker.exists(),
            }

            proc = self._run_resume(workspace)
            combined = proc.stdout + proc.stderr
            self.assertNotEqual(proc.returncode, 0, combined)
            self.assertIn("rollback_bundle_dist_state_unknown", combined)
            self.assertFalse(marker.exists())
            self.assertEqual(before["marker_exists"], False)
            self.assertEqual(len(list((workspace / "bundle" / "pg-backup").glob("pre-001-*.dump"))), before["dump_count"])
            self.assertEqual(_sha256(compose), before["compose_sha"])
            self.assertEqual(_sha256(script), before["script_sha"])
            self.assertEqual(_sha256(dump), before["dump_sha"])
            self.assertEqual(_sha256(pointer), before["pointer_sha"])
            self.assertFalse((workspace / "runtime-report.txt").exists())

    def test_bundle_dist_conflict_both_states_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermesctl-bundle-dist-conflict-") as tmp:
            workspace = Path(tmp)
            self._seed_repo(workspace, with_dist=False)
            self._seed_complete_bundle(workspace, dist_state="absent")
            dist = workspace / "bundle" / "app-dist"
            dist.mkdir(parents=True)
            (dist / "daemon.js").write_text("conflict\n", encoding="utf-8")

            proc = self._run_resume(workspace)
            combined = proc.stdout + proc.stderr
            self.assertNotEqual(proc.returncode, 0, combined)
            self.assertIn("rollback_bundle_dist_state_conflict", combined)


class HermesctlRollbackDistAbsentRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("ansible-playbook") is None:
            raise unittest.SkipTest("ansible-playbook indisponible")

    def _run_rollback(self, repo: Path, bundle: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "ansible-playbook",
                str(ROLLBACK_DIST_PLAYBOOK),
                "-e",
                f"repo_root={repo}",
                "-e",
                f"rollback_bundle_dir={bundle}",
                "-e",
                f"rollback_scripts_dir={bundle / 'scripts'}",
                "-e",
                f"rollback_api_src_dir={bundle / 'app-src'}",
                "-e",
                f"rollback_dist_dir={bundle / 'app-dist'}",
                "-e",
                f"rollback_compose_file={bundle / 'compose.yml'}",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=180,
            cwd=str(ANSIBLE_DIR),
        )

    def test_rollback_removes_dist_when_app_dist_absent_marker(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermesctl-rollback-dist-") as tmp:
            workspace = Path(tmp)
            repo = workspace / "repo"
            bundle = workspace / "bundle"
            (bundle / "scripts").mkdir(parents=True)
            (bundle / "scripts" / "cp-api.sh").write_text("old-script\n", encoding="utf-8")
            (bundle / "app-src").mkdir(parents=True)
            (bundle / "app-src" / "index.ts").write_text("export const old = true\n", encoding="utf-8")
            (bundle / "compose.yml").write_text("services: {}\n", encoding="utf-8")
            (bundle / "app-dist.absent").write_text("app-dist-absent\n", encoding="utf-8")

            (repo / "app" / "dist").mkdir(parents=True)
            (repo / "app" / "dist" / "daemon.js").write_text("new-dist\n", encoding="utf-8")
            (repo / "scripts").mkdir(parents=True)
            (repo / "app" / "src").mkdir(parents=True)
            (repo / "compose.yml").write_text("services: {api: {}}\n", encoding="utf-8")

            proc = self._run_rollback(repo, bundle)
            combined = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, combined)
            self.assertFalse((repo / "app" / "dist").exists())
            self.assertEqual((repo / "scripts" / "cp-api.sh").read_text(encoding="utf-8"), "old-script\n")

    def test_rollback_after_legacy_marker_migration_removes_new_dist(self) -> None:
        """Cas historique : migration marqueur puis rollback d'un dist déployé."""
        resume = HermesctlBundleResumeRuntimeTest()
        resume.setUpClass()
        with tempfile.TemporaryDirectory(prefix="hermesctl-legacy-rollback-") as tmp:
            workspace = Path(tmp)
            resume._seed_repo(workspace, with_dist=False)
            resume._seed_complete_bundle(workspace, dist_state="legacy")

            proc = resume._run_resume(workspace)
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            marker = workspace / "bundle" / "app-dist.absent"
            self.assertTrue(marker.is_file())

            repo = workspace / "repo"
            (repo / "app" / "dist").mkdir(parents=True)
            (repo / "app" / "dist" / "daemon.js").write_text("deployed-new\n", encoding="utf-8")

            rb = self._run_rollback(repo, workspace / "bundle")
            self.assertEqual(rb.returncode, 0, rb.stdout + rb.stderr)
            self.assertFalse((repo / "app" / "dist").exists())


if __name__ == "__main__":
    unittest.main()
