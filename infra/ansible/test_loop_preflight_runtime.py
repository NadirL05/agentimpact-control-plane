"""Tests runtime Ansible — boucle stat + assert post-boucle (preflight tokens)."""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

FIXTURES = Path(__file__).resolve().parent / "test-fixtures" / "loop-preflight"
RUNTIME_PLAYBOOK = FIXTURES / "runtime-playbook.yml"
ANSIBLE_INTERNAL_ERROR = "'dict object' has no attribute 'results'"
OUTPUT_LEAK_PATTERNS = (
    re.compile(r"""['"]checksum['"]\s*:"""),
    re.compile(r"""['"]size['"]\s*:\s*\d+"""),
    re.compile(r"fixture_only"),
    re.compile(r"TOKEN="),
)


class LoopPreflightRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("ansible-playbook") is None:
            raise unittest.SkipTest("ansible-playbook indisponible")

    @contextmanager
    def _materialize_token_dir(self, variant: str) -> Iterator[Path]:
        src_dir = FIXTURES / variant
        with tempfile.TemporaryDirectory(prefix="loop-preflight-") as tmp_dir:
            tmp_path = Path(tmp_dir)
            for fixture in src_dir.glob("*.env.fixture"):
                target_name = fixture.name.removesuffix(".fixture")
                shutil.copy(fixture, tmp_path / target_name)
            yield tmp_path

    def _run(self, token_fixture_dir: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "ansible-playbook",
                str(RUNTIME_PLAYBOOK),
                "-e",
                f"token_fixture_dir={token_fixture_dir}",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
        )

    def _assert_runtime_output_safe(self, combined: str) -> None:
        self.assertNotIn(ANSIBLE_INTERNAL_ERROR, combined)
        for pattern in OUTPUT_LEAK_PATTERNS:
            self.assertIsNone(
                pattern.search(combined),
                f"runtime output leak matched {pattern.pattern!r}",
            )

    def test_all_temp_tokens_present_succeeds(self) -> None:
        with self._materialize_token_dir("present") as tmp_dir:
            proc = self._run(tmp_dir)
        combined = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, combined)
        self._assert_runtime_output_safe(combined)

    def test_one_temp_token_missing_fails_generic(self) -> None:
        with self._materialize_token_dir("missing") as tmp_dir:
            proc = self._run(tmp_dir)
        combined = proc.stdout + proc.stderr
        self.assertNotEqual(proc.returncode, 0, combined)
        self._assert_runtime_output_safe(combined)
        self.assertIn("missing_required_token", combined)


if __name__ == "__main__":
    unittest.main()
