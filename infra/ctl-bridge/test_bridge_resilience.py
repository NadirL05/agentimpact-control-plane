"""Tests résilience bridge — requêtes malformées sans crash."""

from __future__ import annotations

import json
import os
import socket
import tempfile
import unittest
from unittest import mock

import sys

sys.path.insert(0, os.path.dirname(__file__))
import bridge  # noqa: E402
from allowlist import _proposal_body  # noqa: E402


class BridgeResilienceTest(unittest.TestCase):
    def test_malformed_limit_does_not_raise(self) -> None:
        ok, code, _data, _status = bridge.handle_command(
            "missions.list",
            {"limit": "not-a-number"},
            1001,
        )
        self.assertFalse(ok)
        self.assertEqual(code, "INVALID_PARAMS")

    def test_non_dict_params_rejected(self) -> None:
        ok, code, _, _ = bridge.handle_command("health", [], 1001)  # type: ignore[arg-type]
        self.assertFalse(ok)
        self.assertEqual(code, "INVALID_PARAMS")

    def test_proposal_identity_from_peer_uid_not_client(self) -> None:
        body = _proposal_body(
            {
                "title": "Titre valide",
                "instruction": "Instruction assez longue pour passer.",
                "proposed_by_uid": 9999,
                "proposed_by": "spoofed",
            },
            1001,
        )
        self.assertEqual(body["proposed_by_uid"], 1001)
        self.assertEqual(body["proposed_by"], "agentimpact-runner")

    def _run_client_exchange(self, payload: bytes) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bridge.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(path)
            conn, _ = server.accept()
            client.sendall(payload)
            with mock.patch.object(bridge, "peer_credentials", return_value=(1, 1001, 1001)):
                bridge.handle_client(conn)
            response = client.recv(65536)
            client.close()
            conn.close()
            server.close()
            return json.loads(response.decode("utf-8").strip())

    def test_handle_client_survives_invalid_json(self) -> None:
        response = self._run_client_exchange(b"not-json")
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "PROTOCOL_ERROR")

    def test_handle_client_survives_malformed_params(self) -> None:
        payload = json.dumps(
            {"v": 1, "id": "t1", "cmd": "missions.list", "params": "bad"},
        ).encode("utf-8")
        response = self._run_client_exchange(payload)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INVALID_PARAMS")


if __name__ == "__main__":
    unittest.main()
