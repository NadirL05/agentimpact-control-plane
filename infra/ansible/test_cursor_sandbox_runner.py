"""Static, non-mutating checks for the NADIR-26 Cursor sandbox patch."""
from pathlib import Path
import subprocess
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

    def test_runbook_uses_real_nonroot_worktree_then_root_owned_immutable_staging(self):
        runbook = (ROOT / "docs/ops/cursor-sandbox-runner.md").read_text()
        self.assertIn(
            "/var/lib/agentimpact-superset/home/.superset/worktrees/"
            "agentimpact-control-plane/codex/cursor-sandbox-runner-20261012",
            runbook,
        )
        self.assertIn("approved_sha=APPROVED_FULL_40_HEX_SHA_FROM_PR", runbook)
        self.assertIn("sudo git clone --no-checkout https://github.com/NadirL05/agentimpact-control-plane.git", runbook)
        self.assertIn('test "$(sudo git -C "$staging" rev-parse HEAD)" = "$approved_sha"', runbook)
        self.assertIn('sudo install -m 0755 "$staging/infra/scripts/cursor-sandbox-preflight.sh"', runbook)
        self.assertNotIn("/opt/agentimpact/runner/worktrees/cursor-sandbox-runner-20261012", runbook)
        self.assertNotIn("sudo /usr/sbin/apparmor_parser -p infra/", runbook)


if __name__ == "__main__":
    unittest.main()
