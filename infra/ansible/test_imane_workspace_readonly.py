"""Tests Imane workspace read-only playbook — static + runtime local."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ANSIBLE_DIR = Path(__file__).resolve().parent
PLAYBOOK = ANSIBLE_DIR / "playbooks" / "imane-workspace-readonly.yml"
ASSERT_SH = ANSIBLE_DIR / "files" / "imane_workspace_readonly_assert.sh"
FORBIDDEN = re.compile(
    r"(?i)\b(git\s+pull|git\s+merge|git\s+reset|git\s+checkout|git\s+push|"
    r"deploy.?key|IdentityFile|BEGIN OPENSSH PRIVATE KEY|ghp_|gho_|github_pat_)\b"
)


class ImaneWorkspaceReadonlyStaticTest(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(PLAYBOOK.is_file(), "playbook missing")
        self.assertTrue(ASSERT_SH.is_file(), "assert script missing")
        self.playbook_text = PLAYBOOK.read_text(encoding="utf-8")
        self.assert_text = ASSERT_SH.read_text(encoding="utf-8")

    def test_playbook_has_no_destructive_git(self) -> None:
        # Allow comments that mention forbidden words only if clearly documenting prohibition.
        for line in self.playbook_text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            self.assertIsNone(
                FORBIDDEN.search(stripped),
                f"forbidden pattern in playbook line: {stripped}",
            )

    def test_playbook_uses_fetch_only(self) -> None:
        self.assertIn("git -C \"{{ imane_repo_path }}\" fetch origin", self.playbook_text)
        self.assertNotRegex(self.playbook_text, r"(?m)^\s+[^#]*\bgit\s+pull\b")
        self.assertNotRegex(self.playbook_text, r"(?m)^\s+[^#]*\bgit\s+merge\b")
        self.assertNotRegex(self.playbook_text, r"(?m)^\s+[^#]*\bgit\s+reset\b")

    def test_push_url_disabled(self) -> None:
        self.assertIn("imane_origin_push: DISABLED", self.playbook_text)
        self.assertIn("remote set-url --push origin", self.playbook_text)

    def test_expected_path_and_owner(self) -> None:
        self.assertIn("/opt/agentimpact/runner/repos/imn-academy-tanstack", self.playbook_text)
        self.assertIn("agentimpact-runner", self.playbook_text)
        self.assertIn("NadirL05/imane-projet.git", self.playbook_text)

    def test_acl_not_global_chmod(self) -> None:
        self.assertIn("setfacl", self.playbook_text)
        self.assertNotRegex(self.playbook_text, r"chmod\s+-R\s+777")
        self.assertNotRegex(self.playbook_text, r"chmod\s+-R\s+o\+rwx")

    def test_no_secrets_in_tracked_files(self) -> None:
        for path in (PLAYBOOK, ASSERT_SH):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("BEGIN OPENSSH", text)
            self.assertNotRegex(text, r"ghp_[A-Za-z0-9]+")
            self.assertNotRegex(text, r"gho_[A-Za-z0-9]+")

    def test_dirty_guard_present(self) -> None:
        self.assertIn("imane_repo_dirty", self.playbook_text)
        self.assertIn("status --porcelain", self.playbook_text)

    def test_assert_script_covers_hermes_ro(self) -> None:
        self.assertIn("hermes_can_write_sources", self.assert_text)
        self.assertIn("git -C \"$REPO\" status", self.assert_text)
        self.assertIn("origin_push", self.assert_text)
        self.assertIn("DISABLED", self.assert_text)

    def test_assert_script_shellcheck_syntax(self) -> None:
        proc = subprocess.run(
            ["bash", "-n", str(ASSERT_SH)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)


class ImaneWorkspaceReadonlyRuntimeTest(unittest.TestCase):
    """Runtime checks against the live VPS path when present."""

    REPO = Path("/opt/agentimpact/runner/repos/imn-academy-tanstack")

    @classmethod
    def setUpClass(cls) -> None:
        if not cls.REPO.is_dir():
            raise unittest.SkipTest("imane workspace absent on this host")
        if os.geteuid() != 0 and not Path("/usr/bin/runuser").exists():
            raise unittest.SkipTest("runuser/root required for hermes probes")

    def test_hermes_read_and_git(self) -> None:
        sample = self.REPO / "package.json"
        for cmd in (
            ["runuser", "-u", "hermes", "--", "test", "-r", str(sample)],
            ["runuser", "-u", "hermes", "--", "git", "-C", str(self.REPO), "status", "--short"],
            ["runuser", "-u", "hermes", "--", "git", "-C", str(self.REPO), "log", "-1", "--oneline"],
        ):
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
            self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_hermes_cannot_write(self) -> None:
        probe = self.REPO / f".pytest_hermes_write_{os.getpid()}"
        proc = subprocess.run(
            ["runuser", "-u", "hermes", "--", "touch", str(probe)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(probe.exists())

    def test_origin_push_disabled(self) -> None:
        proc = subprocess.run(
            ["runuser", "-u", "agentimpact-runner", "--", "git", "-C", str(self.REPO), "remote", "get-url", "--push", "origin"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "DISABLED")

    def test_fetch_url(self) -> None:
        proc = subprocess.run(
            ["runuser", "-u", "agentimpact-runner", "--", "git", "-C", str(self.REPO), "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "git@github.com:NadirL05/imane-projet.git")

    def test_assert_script_pass(self) -> None:
        if os.geteuid() != 0:
            raise unittest.SkipTest("root required for full assert script")
        proc = subprocess.run(
            ["bash", str(ASSERT_SH), str(self.REPO)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("imane_workspace_readonly_assert=PASS", proc.stdout)

    def test_idempotent_remote_urls(self) -> None:
        """Re-setting the same URLs must leave HEAD unchanged."""
        head_before = subprocess.run(
            ["runuser", "-u", "agentimpact-runner", "--", "git", "-C", str(self.REPO), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        for args in (
            ["remote", "set-url", "origin", "git@github.com:NadirL05/imane-projet.git"],
            ["remote", "set-url", "--push", "origin", "DISABLED"],
        ):
            subprocess.run(
                ["runuser", "-u", "agentimpact-runner", "--", "git", "-C", str(self.REPO), *args],
                check=True,
            )
        head_after = subprocess.run(
            ["runuser", "-u", "agentimpact-runner", "--", "git", "-C", str(self.REPO), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.assertEqual(head_before, head_after)


if __name__ == "__main__":
    unittest.main()
