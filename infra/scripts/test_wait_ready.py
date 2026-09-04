#!/usr/bin/env python3
"""Tests wait-postgres-ready / wait-control-plane-ready (sans Docker ni secrets)."""

from __future__ import annotations

import http.server
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
WAIT_PG = SCRIPTS / "wait-postgres-ready.sh"
WAIT_API = SCRIPTS / "wait-control-plane-ready.sh"


class WaitPostgresReadyTest(unittest.TestCase):
    def test_script_has_no_fixed_sleep_and_bounded_timeout(self) -> None:
        text = WAIT_PG.read_text(encoding="utf-8")
        self.assertIn("TIMEOUT_SEC", text)
        self.assertIn("pg_isready", text)
        self.assertNotRegex(text, r"sleep\s+30")
        self.assertNotRegex(text, r"sleep\s+60")
        self.assertIn("timeout_sec=", text)

    def test_success_when_check_cmd_ok(self) -> None:
        env = os.environ.copy()
        env["WAIT_POSTGRES_TIMEOUT_SEC"] = "5"
        env["WAIT_POSTGRES_INTERVAL_SEC"] = "1"
        env["WAIT_POSTGRES_CHECK_CMD"] = "true"
        proc = subprocess.run(
            ["bash", str(WAIT_PG)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("ok", proc.stderr)

    def test_timeout_when_check_cmd_fails(self) -> None:
        env = os.environ.copy()
        env["WAIT_POSTGRES_TIMEOUT_SEC"] = "3"
        env["WAIT_POSTGRES_INTERVAL_SEC"] = "1"
        env["WAIT_POSTGRES_CHECK_CMD"] = "false"
        proc = subprocess.run(
            ["bash", str(WAIT_PG)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn("timeout_sec=3", proc.stderr)
        self.assertNotIn("password", proc.stderr.lower())
        self.assertNotIn("token", proc.stderr.lower())

    def test_invalid_timeout_rejected(self) -> None:
        env = os.environ.copy()
        env["WAIT_POSTGRES_TIMEOUT_SEC"] = "9999"
        env["WAIT_POSTGRES_CHECK_CMD"] = "true"
        proc = subprocess.run(
            ["bash", str(WAIT_PG)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 64)


class WaitControlPlaneReadyTest(unittest.TestCase):
    def test_script_has_no_fixed_sleep(self) -> None:
        text = WAIT_API.read_text(encoding="utf-8")
        self.assertIn("/health", text)
        self.assertIn("TIMEOUT_SEC", text)
        self.assertNotRegex(text, r"sleep\s+30")
        self.assertNotRegex(text, r"sleep\s+60")

    def test_ok_on_http_200(self) -> None:
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                auth = self.headers.get("Authorization", "")
                if auth != "Bearer test-token":
                    self.send_response(401)
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')

            def log_message(self, format: str, *args: object) -> None:
                return

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.NamedTemporaryFile("w", delete=False) as handle:
                handle.write("test-token\n")
                token_path = handle.name
            env = os.environ.copy()
            env["SLACK_ROUTER_BRIDGE_TOKEN_FILE"] = token_path
            env["WAIT_CONTROL_PLANE_HEALTH_URL"] = f"http://127.0.0.1:{port}/health"
            env["WAIT_CONTROL_PLANE_TIMEOUT_SEC"] = "5"
            env["WAIT_CONTROL_PLANE_INTERVAL_SEC"] = "1"
            proc = subprocess.run(
                ["bash", str(WAIT_API)],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("ok", proc.stderr)
            self.assertNotIn("test-token", proc.stderr)
        finally:
            server.shutdown()
            os.unlink(token_path)

    def test_timeout_on_connection_refused(self) -> None:
        with tempfile.NamedTemporaryFile("w", delete=False) as handle:
            handle.write("test-token\n")
            token_path = handle.name
        try:
            env = os.environ.copy()
            env["SLACK_ROUTER_BRIDGE_TOKEN_FILE"] = token_path
            # Port fermé
            env["WAIT_CONTROL_PLANE_HEALTH_URL"] = "http://127.0.0.1:1/health"
            env["WAIT_CONTROL_PLANE_TIMEOUT_SEC"] = "3"
            env["WAIT_CONTROL_PLANE_INTERVAL_SEC"] = "1"
            proc = subprocess.run(
                ["bash", str(WAIT_API)],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 1, proc.stderr)
            self.assertIn("timeout_sec=3", proc.stderr)
            self.assertNotIn("test-token", proc.stderr)
        finally:
            os.unlink(token_path)

    def test_missing_token_file_fail_closed(self) -> None:
        env = os.environ.copy()
        env.pop("SLACK_ROUTER_BRIDGE_TOKEN_FILE", None)
        env.pop("CREDENTIALS_DIRECTORY", None)
        env["WAIT_CONTROL_PLANE_TIMEOUT_SEC"] = "3"
        proc = subprocess.run(
            ["bash", str(WAIT_API)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
