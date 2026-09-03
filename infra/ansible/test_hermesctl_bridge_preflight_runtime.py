"""Tests runtime — préflight bridge.env (idempotence reprise hermesctl)."""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ANSIBLE_DIR = Path(__file__).resolve().parent
FIXTURES = ANSIBLE_DIR / "test-fixtures" / "hermesctl-bridge-preflight"
RUNTIME_PLAYBOOK = FIXTURES / "runtime-playbook.yml"
PREFLIGHT_SCRIPT = ANSIBLE_DIR / "files" / "hermesctl_bridge_env_preflight.sh"
SECRET_MARKER = "BRIDGE_SECRET_VALUE_DO_NOT_LEAK"


class _FakeStatEnv:
    """PATH mock: stat -c '%a' / '%U:%G' lisent des sidecars ; getent contrôle les identités."""

    def __init__(self, work: Path, *, owner: str, mode: str, ctl_user: bool = True, ctl_group: bool = True) -> None:
        self.work = work
        self.bin = work / "bin"
        self.bin.mkdir(parents=True)
        self.owner = owner
        self.mode = mode
        self.ctl_user = ctl_user
        self.ctl_group = ctl_group
        self._write_mocks()

    def _write_mocks(self) -> None:
        stat_sh = self.bin / "stat"
        stat_sh.write_text(
            f"""#!/usr/bin/env bash
set -euo pipefail
fmt=""
while getopts 'c:' opt; do
  case "$opt" in
    c) fmt="$OPTARG" ;;
  esac
done
shift $((OPTIND - 1))
target="${{1:-}}"
case "$fmt" in
  %a) echo "{self.mode}" ;;
  %U:%G) echo "{self.owner}" ;;
  *)
    # Délègue au vrai stat pour tout le reste (ex. tests hors mock).
    command -p stat -c "$fmt" "$target"
    ;;
esac
""",
            encoding="utf-8",
        )
        stat_sh.chmod(0o755)

        getent_sh = self.bin / "getent"
        getent_sh.write_text(
            f"""#!/usr/bin/env bash
set -euo pipefail
db="${{1:-}}"
key="${{2:-}}"
if [ "$db" = "passwd" ] && [ "$key" = "agentimpact-ctl" ]; then
  {"exit 0" if self.ctl_user else "exit 2"}
fi
if [ "$db" = "group" ] && [ "$key" = "agentimpact-ctl" ]; then
  {"exit 0" if self.ctl_group else "exit 2"}
fi
command -p getent "$@"
""",
            encoding="utf-8",
        )
        getent_sh.chmod(0o755)

    def env(self) -> dict[str, str]:
        return {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ.get('PATH', '')}",
        }


class HermesctlBridgePreflightRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("ansible-playbook") is None:
            raise unittest.SkipTest("ansible-playbook indisponible")
        if not PREFLIGHT_SCRIPT.is_file():
            raise unittest.SkipTest("script préflight manquant")
        PREFLIGHT_SCRIPT.chmod(PREFLIGHT_SCRIPT.stat().st_mode | stat.S_IXUSR)

    def _write_bridge(self, directory: Path, content: str = SECRET_MARKER + "\n") -> Path:
        path = directory / "bridge.env"
        path.write_text(content, encoding="utf-8")
        path.chmod(0o600)
        return path

    def _run_script(self, path: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(PREFLIGHT_SCRIPT), str(path)],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
            env=env or os.environ.copy(),
        )

    def _run_playbook_twice(
        self,
        path: Path,
        *,
        fake: _FakeStatEnv,
        run_twice: bool,
    ) -> subprocess.CompletedProcess[str]:
        report = fake.work / "runtime-report.txt"
        env = {
            **fake.env(),
            "ANSIBLE_STDOUT_CALLBACK": "default",
            "ANSIBLE_RETRY_FILES_ENABLED": "false",
        }
        return subprocess.run(
            [
                "ansible-playbook",
                str(RUNTIME_PLAYBOOK),
                "-e",
                f"bridge_env_path={path}",
                "-e",
                f"runtime_report_path={report}",
                "-e",
                f"run_twice={'true' if run_twice else 'false'}",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=120,
            env=env,
            cwd=str(ANSIBLE_DIR),
        )

    def _assert_no_secret_leak(self, combined: str) -> None:
        self.assertNotIn(SECRET_MARKER, combined)
        self.assertNotIn("BRIDGE_SECRET", combined)

    def test_initial_root_root_0600_accepted(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bridge-preflight-root-") as tmp:
            work = Path(tmp)
            path = self._write_bridge(work)
            fake = _FakeStatEnv(work, owner="root:root", mode="600")
            proc = self._run_script(path, fake.env())
            combined = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, combined)
            self.assertIn("bridge_env_preflight=ok", proc.stdout)
            self._assert_no_secret_leak(combined)

    def test_root_agentimpact_ctl_without_group_read_accepted(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bridge-preflight-rootctl-") as tmp:
            work = Path(tmp)
            path = self._write_bridge(work)
            fake = _FakeStatEnv(work, owner="root:agentimpact-ctl", mode="640")
            # 640 has group read (4) → must refuse
            bad = self._run_script(path, fake.env())
            self.assertNotEqual(bad.returncode, 0, bad.stdout + bad.stderr)
            fake_ok = _FakeStatEnv(work / "ok", owner="root:agentimpact-ctl", mode="600")
            ok = self._run_script(path, fake_ok.env())
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)

    def test_resumed_agentimpact_ctl_0400_accepted(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bridge-preflight-ctl-") as tmp:
            work = Path(tmp)
            path = self._write_bridge(work)
            path.chmod(0o400)
            fake = _FakeStatEnv(work, owner="agentimpact-ctl:agentimpact-ctl", mode="400")
            proc = self._run_script(path, fake.env())
            combined = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, combined)
            self.assertIn("bridge_env_preflight=ok", proc.stdout)
            self._assert_no_secret_leak(combined)

    def test_preflight_twice_idempotent_with_ctl_0400(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bridge-preflight-twice-") as tmp:
            work = Path(tmp)
            path = self._write_bridge(work)
            path.chmod(0o400)
            fake = _FakeStatEnv(work, owner="agentimpact-ctl:agentimpact-ctl", mode="400")
            proc = self._run_playbook_twice(path, fake=fake, run_twice=True)
            combined = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, combined)
            report = (work / "runtime-report.txt").read_text(encoding="utf-8")
            self.assertIn("preflight1=bridge_env_preflight=ok", report)
            self.assertIn("preflight2=bridge_env_preflight=ok", report)
            self.assertIn("ran_twice=true", report)
            self._assert_no_secret_leak(combined)
            self._assert_no_secret_leak(report)

    def test_agentimpact_ctl_owner_0600_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bridge-preflight-ctl0600-") as tmp:
            work = Path(tmp)
            path = self._write_bridge(work)
            fake = _FakeStatEnv(work, owner="agentimpact-ctl:agentimpact-ctl", mode="600")
            proc = self._run_script(path, fake.env())
            combined = proc.stdout + proc.stderr
            self.assertNotEqual(proc.returncode, 0, combined)
            self.assertIn("unexpected_bridge_mode_preflight", combined)
            self._assert_no_secret_leak(combined)

    def test_unexpected_owner_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bridge-preflight-owner-") as tmp:
            work = Path(tmp)
            path = self._write_bridge(work)
            fake = _FakeStatEnv(work, owner="nobody:nogroup", mode="600")
            proc = self._run_script(path, fake.env())
            combined = proc.stdout + proc.stderr
            self.assertNotEqual(proc.returncode, 0, combined)
            self.assertIn("unexpected_bridge_owner_preflight", combined)
            self._assert_no_secret_leak(combined)

    def test_symlink_rejected(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bridge-preflight-symlink-") as tmp:
            work = Path(tmp)
            real = work / "real.env"
            real.write_text(SECRET_MARKER + "\n", encoding="utf-8")
            link = work / "bridge.env"
            link.symlink_to(real)
            fake = _FakeStatEnv(work, owner="root:root", mode="600")
            proc = self._run_script(link, fake.env())
            combined = proc.stdout + proc.stderr
            self.assertNotEqual(proc.returncode, 0, combined)
            self.assertIn("invalid_bridge_env_preflight", combined)
            self._assert_no_secret_leak(combined)

    def test_output_never_contains_file_value(self) -> None:
        with tempfile.TemporaryDirectory(prefix="bridge-preflight-leak-") as tmp:
            work = Path(tmp)
            path = self._write_bridge(work, content=f"{SECRET_MARKER}=super-secret\n")
            path.chmod(0o400)
            fake = _FakeStatEnv(work, owner="agentimpact-ctl:agentimpact-ctl", mode="400")
            ok = self._run_script(path, fake.env())
            bad_owner = self._run_script(
                path,
                _FakeStatEnv(work / "b", owner="evil:evil", mode="400").env(),
            )
            combined = ok.stdout + ok.stderr + bad_owner.stdout + bad_owner.stderr
            self._assert_no_secret_leak(combined)
            self.assertNotIn("super-secret", combined)
            self.assertNotIn("cat ", combined)


if __name__ == "__main__":
    unittest.main()
