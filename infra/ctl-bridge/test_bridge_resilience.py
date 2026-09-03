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
        if not payload.endswith(b"\n"):
            payload = payload + b"\n"
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

    def test_handle_client_rejects_non_object_json(self) -> None:
        response = self._run_client_exchange(json.dumps([1, 2, 3]).encode("utf-8") + b"\n")
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "PROTOCOL_ERROR")

    def test_handle_client_accepts_fragmented_request(self) -> None:
        payload = json.dumps(
            {"v": 1, "id": "frag", "cmd": "health", "params": {}},
        ).encode("utf-8") + b"\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bridge.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(path)
            conn, _ = server.accept()
            mid = len(payload) // 2
            client.sendall(payload[:mid])
            client.sendall(payload[mid:])
            with mock.patch.object(bridge, "peer_credentials", return_value=(1, 1001, 1001)):
                with mock.patch.object(bridge, "upstream_request", return_value=(200, {"status": "ok"})):
                    bridge.handle_client(conn)
            response = client.recv(65536)
            client.close()
            conn.close()
            server.close()
            parsed = json.loads(response.decode("utf-8").strip())
            self.assertTrue(parsed["ok"])

    def test_read_request_line_rejects_oversized_without_newline(self) -> None:
        class FakeConn:
            def __init__(self) -> None:
                self.sent = b"x" * (bridge.MAX_REQUEST_BYTES + 1)

            def recv(self, n: int) -> bytes:
                chunk = self.sent[:n]
                self.sent = self.sent[n:]
                return chunk

        self.assertIsNone(bridge.read_request_line(FakeConn()))  # type: ignore[arg-type]


    def test_handle_client_read_timeout(self) -> None:
        class SlowSocket:
            def settimeout(self, _seconds: float) -> None:
                return None

            def setsockopt(self, *args):  # noqa: ANN002, ANN003
                return None

            def recv(self, _n: int) -> bytes:
                raise socket.timeout()

            def sendall(self, _data: bytes) -> None:
                return None

            def close(self) -> None:
                return None

        with mock.patch.object(bridge, "peer_credentials", return_value=(1, 1001, 1001)):
            with mock.patch.object(bridge, "READ_TIMEOUT_SECONDS", 0.01):
                bridge.handle_client(SlowSocket())  # type: ignore[arg-type]


class BridgeSystemdFdTest(unittest.TestCase):
    """Tests FD 3 / LISTEN_FDS — activation socket systemd."""

    def test_systemd_listen_fd_returns_3_when_listen_fds_set(self) -> None:
        with mock.patch.dict(os.environ, {"LISTEN_FDS": "1"}, clear=False):
            self.assertEqual(bridge.systemd_listen_fd(), 3)

    def test_systemd_listen_fd_raises_fast_when_missing(self) -> None:
        """Absence de LISTEN_FDS échoue rapidement, sans attente ni retry."""
        env = {k: v for k, v in os.environ.items() if k != "LISTEN_FDS"}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(RuntimeError) as ctx:
                bridge.systemd_listen_fd()
            self.assertIn("LISTEN_FDS", str(ctx.exception))

    def test_systemd_listen_fd_raises_fast_when_zero(self) -> None:
        with mock.patch.dict(os.environ, {"LISTEN_FDS": "0"}, clear=True):
            with self.assertRaises(RuntimeError):
                bridge.systemd_listen_fd()

    def test_main_fails_fast_without_listen_fds(self) -> None:
        """main() échoue avant la boucle d'accept si LISTEN_FDS absent."""
        env = {
            "CTL_BRIDGE_TOKEN": "t",
            "CONTROL_PLANE_URL": "http://127.0.0.1:9",
        }
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch.object(bridge, "BRIDGE_TOKEN", "t"):
                with mock.patch.object(bridge, "API_BASE", "http://127.0.0.1:9"):
                    with mock.patch.object(bridge, "setup_audit_logging", return_value=None):
                        with self.assertRaises(RuntimeError):
                            bridge.main()

    def test_consecutive_clients_handled_on_same_listen_socket(self) -> None:
        """Plusieurs clients successifs sont servis sans recréer le socket d'écoute."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bridge.sock")
            listen_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listen_sock.bind(path)
            listen_sock.listen(8)
            fd = listen_sock.fileno()

            def fake_fromfd(_fd, _family, _type):
                return socket.fromfd(fd, socket.AF_UNIX, socket.SOCK_STREAM)

            responses = []
            with mock.patch.object(bridge, "socket") as m_socket:
                m_socket.fromfd = fake_fromfd
                m_socket.AF_UNIX = socket.AF_UNIX
                m_socket.SOCK_STREAM = socket.SOCK_STREAM
                m_socket.timeout = socket.timeout
                m_socket.SOL_SOCKET = socket.SOL_SOCKET
                m_socket.SO_PEERCRED = getattr(socket, "SO_PEERCRED", 17)

                for i in range(3):
                    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    client.connect(path)
                    conn, _ = listen_sock.accept()
                    payload = json.dumps(
                        {"v": 1, "id": f"c{i}", "cmd": "health", "params": {}}
                    ).encode("utf-8") + b"\n"
                    client.sendall(payload)
                    with mock.patch.object(
                        bridge, "peer_credentials", return_value=(1, 1001, 1001)
                    ):
                        with mock.patch.object(
                            bridge,
                            "upstream_request",
                            return_value=(200, {"status": "ok"}),
                        ):
                            bridge.handle_client(conn)
                    raw = client.recv(65536)
                    responses.append(json.loads(raw.decode("utf-8").strip()))
                    client.close()
            listen_sock.close()
            self.assertEqual(len(responses), 3)
            for r in responses:
                self.assertTrue(r["ok"])

    def test_worker_restart_preserves_listen_socket_for_new_clients(self) -> None:
        """Simule un crash/rediarrage du worker : le socket d'écoute (FD 3) reste
        valide pour les clients suivants car l'unité socket le conserve."""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bridge.sock")
            listen_sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listen_sock.bind(path)
            listen_sock.listen(8)
            fd = listen_sock.fileno()

            def fake_fromfd(_fd, _family, _type):
                return socket.fromfd(fd, socket.AF_UNIX, socket.SOCK_STREAM)

            with mock.patch.object(bridge, "socket") as m_socket:
                m_socket.fromfd = fake_fromfd
                m_socket.AF_UNIX = socket.AF_UNIX
                m_socket.SOCK_STREAM = socket.SOCK_STREAM
                m_socket.timeout = socket.timeout
                m_socket.SOL_SOCKET = socket.SOL_SOCKET
                m_socket.SO_PEERCRED = getattr(socket, "SO_PEERCRED", 17)

                # Première "vie" du worker : un client.
                c1 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                c1.connect(path)
                conn1, _ = listen_sock.accept()
                c1.sendall(
                    json.dumps({"v": 1, "id": "w1", "cmd": "health", "params": {}}).encode()
                    + b"\n"
                )
                with mock.patch.object(
                    bridge, "peer_credentials", return_value=(1, 1001, 1001)
                ):
                    with mock.patch.object(
                        bridge, "upstream_request", return_value=(200, {"status": "ok"})
                    ):
                        bridge.handle_client(conn1)
                r1 = json.loads(c1.recv(65536).decode().strip())
                c1.close()
                self.assertTrue(r1["ok"])

                # "Crash" du worker : on ne ferme PAS listen_sock (l'unité socket le garde).
                # Nouvelle "vie" : un second client se connecte sur le même socket.
                c2 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                c2.connect(path)
                conn2, _ = listen_sock.accept()
                c2.sendall(
                    json.dumps({"v": 1, "id": "w2", "cmd": "health", "params": {}}).encode()
                    + b"\n"
                )
                with mock.patch.object(
                    bridge, "peer_credentials", return_value=(1, 1001, 1001)
                ):
                    with mock.patch.object(
                        bridge, "upstream_request", return_value=(200, {"status": "ok"})
                    ):
                        bridge.handle_client(conn2)
                r2 = json.loads(c2.recv(65536).decode().strip())
                c2.close()
                self.assertTrue(r2["ok"])
            listen_sock.close()


if __name__ == "__main__":
    unittest.main()
