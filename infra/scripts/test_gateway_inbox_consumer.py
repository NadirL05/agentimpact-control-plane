#!/usr/bin/env python3
"""Tests unitaires gateway-inbox-consumer (sans réseau ni Hermès)."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parent / "gateway-inbox-consumer.py"


def load_module():
    spec = importlib.util.spec_from_file_location("gateway_inbox_consumer", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class GatewayInboxConsumerTest(unittest.TestCase):
    def setUp(self) -> None:
        for key in list(os.environ):
            if key.startswith("GATEWAY_INBOX_") or key.startswith("SLACK_ROUTER_"):
                os.environ.pop(key, None)

    def test_validate_target_hermes(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        self.assertEqual(load_module().validate_target(), 0)

    def test_validate_target_ana(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "ana"
        self.assertEqual(load_module().validate_target(), 0)

    def test_validate_target_unknown(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "codex"
        self.assertEqual(load_module().validate_target(), 2)

    def test_validate_target_devin_forbidden(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "devin"
        self.assertEqual(load_module().validate_target(), 2)

    def test_run_hermes_uses_nadir_operator_profile(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        os.environ["HERMES_PROFILE"] = "nadir-operator"
        mod = load_module()
        with patch.object(mod.subprocess, "run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess([], 0, stdout="ok\n", stderr="")
            mod.run_hermes("prompt")
            cmd = mock_run.call_args[0][0]
            self.assertEqual(cmd[0], "/opt/agentimpact/scripts/run-with-profile.sh")
            self.assertEqual(cmd[1], "nadir-operator")

    def test_run_hermes_uses_agentimpact_growth_for_ana(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "ana"
        os.environ["HERMES_PROFILE"] = "agentimpact-growth"
        mod = load_module()
        with patch.object(mod.subprocess, "run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess([], 0, stdout="ok\n", stderr="")
            mod.run_hermes("prompt")
            self.assertEqual(mock_run.call_args[0][0][1], "agentimpact-growth")

    def test_v2_item_never_invokes_worker_or_completion(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        mod = load_module()
        with patch.object(mod, "api_post", return_value=(200, {"item": {
            "id": "synthetic-mission", "target": "hermes", "orchestration_version": 2,
            "prompt": "PRIVATE_INPUT_SENTINEL",
        }})) as post, patch.object(mod, "run_hermes") as run:
            self.assertEqual(mod.process_once("fixture"), "wrong_orchestration_version")
            run.assert_not_called()
            self.assertEqual(post.call_count, 1)

    def test_process_once_target_mismatch(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        mod = load_module()
        with patch.object(mod, "api_post") as mock_post, patch.object(mod, "run_hermes") as mock_run:
            mock_post.side_effect = [
                (200, {"item": {"id": "x", "target": "ana", "prompt": "p"}}),
                (200, {}),
            ]
            self.assertEqual(mod.process_once("token"), "failed")
            mock_run.assert_not_called()

    def test_process_once_hermes_success(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        mod = load_module()
        with patch.object(mod, "api_post") as mock_post, patch.object(
            mod, "run_hermes", return_value="ok"
        ):
            mock_post.side_effect = [
                (200, {"item": {"id": "x", "target": "hermes", "prompt": "p"}}),
                (200, {}),
            ]
            self.assertEqual(mod.process_once("token"), "processed")

    def test_process_once_empty_queue(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "ana"
        mod = load_module()
        with patch.object(mod, "api_post", return_value=(204, {})):
            self.assertEqual(mod.process_once("token"), "empty")

    def test_shutdown_during_processing(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        mod = load_module()
        mod._SHUTDOWN = True
        with patch.object(mod, "api_post") as mock_post:
            self.assertEqual(mod.process_once("token"), "shutdown")
            mock_post.assert_not_called()

    def test_claim_transport_error_before_claim(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        mod = load_module()
        with patch.object(mod, "api_post", side_effect=mod.TransportError("transport_error")):
            self.assertEqual(mod.process_once("token"), "transport_error")

    def test_claim_timeout_returns_transport_error(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        mod = load_module()

        def raise_timeout(*_args, **_kwargs):
            raise mod.TransportError("transport_error")

        with patch.object(mod, "api_post", side_effect=raise_timeout):
            self.assertEqual(mod.process_once("token"), "transport_error")

    def test_complete_transport_error_after_hermes_leaves_processing(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        mod = load_module()
        with patch.object(mod, "api_post") as mock_post, patch.object(
            mod, "run_hermes", return_value="ok"
        ):
            mock_post.side_effect = [
                (200, {"item": {"id": "x", "target": "hermes", "prompt": "p"}}),
                mod.TransportError("transport_error"),
            ]
            self.assertEqual(mod.process_once("token"), "transport_error")
            self.assertEqual(mock_post.call_count, 2)

    def test_loop_continues_after_transport_error(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as handle:
            handle.write("bridge-token\n")
            token_path = handle.name
        os.environ["SLACK_ROUTER_BRIDGE_TOKEN_FILE"] = token_path
        mod = load_module()
        mod._SHUTDOWN = False
        outcomes = iter(["transport_error", "shutdown"])

        with patch.object(mod, "process_once", side_effect=lambda _t: next(outcomes)), patch.object(
            mod, "sleep_backoff", return_value=True
        ):
            self.assertEqual(mod.run_loop(), 0)

    def test_sigterm_during_backoff_exits_loop(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        os.environ["SLACK_ROUTER_BRIDGE_TOKEN_FILE"] = "/dev/null"
        mod = load_module()
        mod._SHUTDOWN = False

        def stop_on_backoff(_seconds: float) -> bool:
            mod._SHUTDOWN = True
            return False

        with patch.object(mod, "load_bridge_token", return_value="token"), patch.object(
            mod, "process_once", return_value="transport_error"
        ), patch.object(mod, "sleep_backoff", side_effect=stop_on_backoff):
            self.assertEqual(mod.run_loop(), 0)

    def test_api_post_wraps_urlerror(self) -> None:
        mod = load_module()
        with patch.object(
            mod.urllib.request,
            "urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        ):
            with self.assertRaises(mod.TransportError):
                mod.api_post("/api/gateway-inbox/claim", {"target": "hermes"}, token="t")

    def test_run_loop_catches_unexpected_exception(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        mod = load_module()
        mod._SHUTDOWN = False
        calls = {"n": 0}

        def flaky(_token: str) -> str:
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("unexpected")
            mod._SHUTDOWN = True
            return "shutdown"

        with patch.object(mod, "load_bridge_token", return_value="token"), patch.object(
            mod, "process_once", side_effect=flaky
        ), patch.object(mod, "sleep_backoff", return_value=True):
            self.assertEqual(mod.run_loop(), 0)

    def test_run_loop_fail_closed_without_token_file(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        os.environ.pop("SLACK_ROUTER_BRIDGE_TOKEN_FILE", None)
        os.environ.pop("SLACK_ROUTER_BRIDGE_TOKEN", None)
        mod = load_module()
        self.assertEqual(mod.run_loop(), 2)

    def test_run_once_fail_closed_without_token(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        os.environ.pop("SLACK_ROUTER_BRIDGE_TOKEN_FILE", None)
        os.environ.pop("SLACK_ROUTER_BRIDGE_TOKEN", None)
        mod = load_module()
        self.assertEqual(mod.run_once(), 2)

    def test_process_once_hermes_error_marks_failed(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        mod = load_module()
        with patch.object(mod, "api_post") as mock_post, patch.object(
            mod, "run_hermes", side_effect=RuntimeError("hermes_exit_1")
        ):
            mock_post.side_effect = [
                (200, {"item": {"id": "x", "target": "hermes", "prompt": "p"}}),
                (200, {}),
            ]
            self.assertEqual(mod.process_once("token"), "failed")
            complete_call = mock_post.call_args_list[1]
            self.assertIn("/complete", complete_call[0][0])
            self.assertEqual(complete_call[0][1]["error_code"], "hermes_exit_1")

    def test_format_hermes_exit_78_includes_sanitized_profile_error(self) -> None:
        mod = load_module()
        err = mod.format_hermes_exit_error(
            78,
            "HERMES_PROFILE='default' ne resout vers aucun dossier existant "
            "(essaye: /home/hermes/.hermes/profiles/default)\n",
        )
        self.assertTrue(err.startswith("hermes_exit_78:"))
        self.assertIn("HERMES_PROFILE", err)
        self.assertNotIn("OPENROUTER", err)

    def test_format_hermes_exit_drops_secretish_stderr(self) -> None:
        mod = load_module()
        err = mod.format_hermes_exit_error(1, "api_key=sk-secret\nother\n")
        self.assertEqual(err, "hermes_exit_1")

    def test_run_hermes_maps_exit_78_from_wrapper(self) -> None:
        os.environ["GATEWAY_INBOX_TARGET"] = "hermes"
        os.environ["HERMES_PROFILE"] = "nadir-operator"
        mod = load_module()
        with patch.object(mod.subprocess, "run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess(
                [],
                78,
                stdout="",
                stderr="HERMES_PROFILE='default' ne resout vers aucun dossier existant\n",
            )
            with self.assertRaises(RuntimeError) as ctx:
                mod.run_hermes("prompt")
            self.assertIn("hermes_exit_78", str(ctx.exception))
            self.assertIn("HERMES_PROFILE", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
