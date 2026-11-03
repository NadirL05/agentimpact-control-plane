"""Static, non-mutating checks for the NADIR-26 Cursor sandbox patch."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


class CursorSandboxRunnerTest(unittest.TestCase):
    def test_apparmor_is_exact_and_keeps_global_restriction(self):
        profile = (ROOT / "infra/apparmor/agentimpact-cursor-sandbox").read_text()
        exact = "/var/lib/agentimpact-superset/toolchains/cursor/2026.09.08-6caf4ff/payload/cursorsandbox"
        self.assertIn(f"profile agentimpact-cursor-sandbox {exact}", profile)
        self.assertIn("  userns,", profile)
        self.assertNotIn("toolchains/cursor/*", profile)
        self.assertNotIn("apparmor_restrict_unprivileged_userns=0", profile)

    def test_host_dropin_only_opens_namespaces_and_adds_fail_closed_preflight(self):
        dropin = (
            ROOT
            / "infra/systemd/agentimpact-superset-host.service.d/50-cursor-sandbox.conf"
        ).read_text()
        self.assertIn("RestrictNamespaces=\n", dropin)
        self.assertIn("RestrictNamespaces=user mnt pid ipc uts cgroup net", dropin)
        self.assertIn("ExecStartPre=/usr/local/libexec/agentimpact-cursor-sandbox-preflight --runtime", dropin)
        self.assertNotIn("NoNewPrivileges=false", dropin)
        self.assertNotIn("PrivateTmp=false", dropin)
        self.assertNotIn("ProtectSystem=false", dropin)

    def test_private_executor_cannot_replace_the_pinned_toolchain(self):
        dropin = (
            ROOT
            / "infra/systemd/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf"
        ).read_text()
        self.assertIn("ReadOnlyPaths=/var/lib/agentimpact-superset/toolchains", dropin)
        self.assertNotIn("ReadWritePaths=", dropin)

    def test_preflight_is_non_provider_and_pins_runtime_bytes(self):
        script = (ROOT / "infra/scripts/cursor-sandbox-preflight.sh").read_text()
        for digest in (
            "2ccc9a8e167797641448b5e5c936f006ba137a2555f117f38c5eb76a5238a233",
            "e0e46d3a1c0667117303412647cafcbcefb1be7612493015ec8fd6b7440162a4",
            "61b58f6a0b9e64970fce5f001526996a786a121f3d8836fa2e1d4b3629f3b02f",
            "ecdd7459846e9e48317098a96b5260c0e99f6ee935f9f37256005293511cb779",
        ):
            self.assertIn(digest, script)
        self.assertIn("--preflight-only", script)
        self.assertIn("kernel.apparmor_restrict_unprivileged_userns", script)
        self.assertIn("runtime_root_must_be_readonly", script)
        self.assertNotIn("--sandbox disabled", script)
        self.assertNotIn("CURSOR_API_KEY", script)
        self.assertNotIn('"$cursor_root/cursor-agent"', script)

    def test_preflight_shell_syntax(self):
        result = subprocess.run(
            ["bash", "-n", str(ROOT / "infra/scripts/cursor-sandbox-preflight.sh")],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_root_scripts_are_fail_closed_and_shell_valid(self):
        install = ROOT / "infra/scripts/root-install-cursor-sandbox-runner.sh"
        rollback = ROOT / "infra/scripts/root-rollback-cursor-sandbox-runner.sh"
        for script in (install, rollback):
            result = subprocess.run(
                ["bash", "-n", str(script)], capture_output=True, text=True, check=False
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("rm -rf", script.read_text())
            self.assertNotIn("apparmor_restrict_unprivileged_userns=0", script.read_text())
            self.assertNotIn("CURSOR_API_KEY", script.read_text())
        source = install.read_text()
        self.assertIn("--ack-agent-interruption", source)
        self.assertIn("AGENT_INTERRUPTION=YES", source)
        self.assertIn("BACKUP_COMPLETE", source)
        self.assertIn("ROLLING_BACK_AUTOMATICALLY", source)
        self.assertIn('systemctl restart "$host_unit"', source)
        self.assertIn('AGENTIMPACT_CURSOR_SANDBOX_LOCK_HELD=1 "$source_rollback"', source)
        self.assertLess(source.index("BACKUP_COMPLETE"), source.index("mutated=1"))

    @staticmethod
    def _write_executable(path: Path, source: str) -> None:
        path.write_text(source)
        path.chmod(0o755)

    def test_partial_mutation_auto_rolls_back_broken_symlink_without_real_systemd(self):
        if os.geteuid() == 0:
            self.skipTest("the guarded test mode deliberately refuses root")
        with tempfile.TemporaryDirectory(prefix="nadir26-installer-") as temporary:
            test_root = Path(temporary)
            fake_bin = test_root / "bin"
            fake_bin.mkdir()
            profiles = test_root / "apparmor-profiles"
            profiles.write_text("")
            log = test_root / "systemctl.log"

            host_dropin = (
                test_root
                / "etc/systemd/system/agentimpact-superset-host.service.d/50-cursor-sandbox.conf"
            )
            systemctl = f"""#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> {log}
command_name="$1"
shift
case "$command_name" in
  show)
    property=""
    while (($#)); do
      if [[ "$1" == -p ]]; then property="$2"; shift; fi
      shift
    done
    case "$property" in
      User|Group) echo agentimpact-superset ;;
      NoNewPrivileges|PrivateTmp) echo yes ;;
      ProtectSystem) echo strict ;;
      CapabilityBoundingSet) echo ;;
      RestrictNamespaces)
        if [[ -e {host_dropin} ]]; then echo 'user mnt pid ipc uts cgroup net'; else echo yes; fi ;;
      InvocationID) echo test-invocation ;;
      *) exit 2 ;;
    esac
    ;;
  is-active)
    if [[ "$1" == agentimpact-superset-host.service ]]; then echo active; exit 0; fi
    echo inactive
    exit 3
    ;;
  stop|start|restart|daemon-reload) exit 0 ;;
  *) exit 2 ;;
esac
"""
            self._write_executable(fake_bin / "systemctl", systemctl)
            apparmor_parser = f"""#!/usr/bin/env bash
set -eu
case "$1" in
  -p) exit 0 ;;
  -r) echo 'agentimpact-cursor-sandbox (unconfined)' > {profiles} ;;
  -R) : > {profiles} ;;
  *) exit 2 ;;
esac
"""
            self._write_executable(fake_bin / "apparmor_parser", apparmor_parser)
            self._write_executable(
                fake_bin / "journalctl",
                "#!/usr/bin/env bash\necho 'CURSOR_SANDBOX_PREFLIGHT=PASS mode=runtime'\n",
            )

            draft = test_root / "draft"
            # Reproduce a checkout created by root while hPanel still has umask 077.
            required = {
                "infra/apparmor/agentimpact-cursor-sandbox": 0o600,
                "infra/systemd/agentimpact-superset-host.service.d/50-cursor-sandbox.conf": 0o600,
                "infra/systemd/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf": 0o600,
                "infra/scripts/cursor-sandbox-preflight.sh": 0o700,
                "infra/scripts/root-install-cursor-sandbox-runner.sh": 0o700,
                "infra/scripts/root-rollback-cursor-sandbox-runner.sh": 0o700,
            }
            for relative, mode in required.items():
                destination = draft / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / relative, destination)
                destination.chmod(mode)
            self._write_executable(
                draft / "infra/scripts/cursor-sandbox-preflight.sh",
                "#!/usr/bin/env bash\nset -eu\n[[ \"$1\" == --static ]]\n",
            )
            (draft / "infra/scripts/cursor-sandbox-preflight.sh").chmod(0o700)
            subprocess.run(["git", "init", "-q", str(draft)], check=True)
            subprocess.run(["git", "-C", str(draft), "config", "user.name", "NADIR-26 test"], check=True)
            subprocess.run(["git", "-C", str(draft), "config", "user.email", "nadir26@test.invalid"], check=True)
            subprocess.run(["git", "-C", str(draft), "add", "."], check=True)
            subprocess.run(["git", "-C", str(draft), "commit", "-qm", "fixture"], check=True)
            subprocess.run(
                [
                    "git", "-C", str(draft), "remote", "add", "origin",
                    "https://github.com/NadirL05/agentimpact-control-plane.git",
                ],
                check=True,
            )
            sha = subprocess.check_output(
                ["git", "-C", str(draft), "rev-parse", "HEAD"], text=True
            ).strip()
            subprocess.run(["git", "-C", str(draft), "checkout", "-q", "--detach", sha], check=True)
            stage = test_root / "staging" / f"nadir-26-{sha}"
            stage.parent.mkdir()
            draft.rename(stage)

            installed_preflight = test_root / "usr/local/libexec/agentimpact-cursor-sandbox-preflight"
            installed_preflight.parent.mkdir(parents=True)
            installed_preflight.symlink_to("missing-pre-nadir26")

            env = {
                **os.environ,
                "AGENTIMPACT_TEST_ONLY": "1",
                "AGENTIMPACT_TEST_ROOT": str(test_root),
                "AGENTIMPACT_TEST_FAIL_AFTER_FIRST_MUTATION": "1",
            }
            result = subprocess.run(
                [
                    str(stage / "infra/scripts/root-install-cursor-sandbox-runner.sh"),
                    "--ack-agent-interruption",
                ],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            output = result.stdout + result.stderr
            self.assertNotEqual(result.returncode, 0, output)
            self.assertIn("CURSOR_SANDBOX_INSTALL=ROLLING_BACK_AUTOMATICALLY", output)
            self.assertIn("CURSOR_SANDBOX_INSTALL=AUTO_ROLLBACK_PASS", output)
            self.assertTrue(installed_preflight.is_symlink())
            self.assertEqual(os.readlink(installed_preflight), "missing-pre-nadir26")
            current = test_root / "rollback/nadir-26-cursor-sandbox/current"
            bundle = current.resolve()
            self.assertTrue((bundle / "preflight.previous").is_symlink())
            self.assertTrue((bundle / "preflight.symlink.sha256").is_file())
            expected = hashlib.sha256(b"missing-pre-nadir26\n").hexdigest()
            self.assertEqual((bundle / "preflight.symlink.sha256").read_text().strip(), expected)
            self.assertTrue((bundle / "ROLLED_BACK").is_file())
            self.assertIn("stop agentimpact-superset-host.service", log.read_text())

    def test_runbook_uses_real_nonroot_worktree_then_root_owned_immutable_staging(self):
        runbook = (ROOT / "docs/ops/cursor-sandbox-runner.md").read_text()
        self.assertIn(
            "/var/lib/agentimpact-superset/home/.superset/worktrees/"
            "agentimpact-control-plane/codex/cursor-sandbox-runner-20261012",
            runbook,
        )
        self.assertIn("sha=FULL_40_HEX_SHA_PINNED_IN_PR_COMMENT", runbook)
        self.assertIn("umask 022", runbook)
        self.assertIn("git clone --no-checkout https://github.com/NadirL05/agentimpact-control-plane.git", runbook)
        self.assertIn('test "$(git -C "$stage" rev-parse HEAD)" = "$sha"', runbook)
        self.assertIn(
            '"$stage/infra/scripts/root-install-cursor-sandbox-runner.sh" '
            "--ack-agent-interruption",
            runbook,
        )
        self.assertNotIn("/opt/agentimpact/runner/worktrees/cursor-sandbox-runner-20261012", runbook)
        self.assertNotIn("sudo /usr/sbin/apparmor_parser -p infra/", runbook)


if __name__ == "__main__":
    unittest.main()
