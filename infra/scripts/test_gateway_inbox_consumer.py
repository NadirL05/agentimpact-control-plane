#!/usr/bin/env python3
"""Tests unitaires gateway-inbox-consumer (sans réseau ni Hermès)."""

from __future__ import annotations

import importlib.util
import os
import unittest
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


if __name__ == "__main__":
    unittest.main()
