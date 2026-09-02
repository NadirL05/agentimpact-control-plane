"""Test LISTEN_FDS / FD 3 pour activation socket systemd."""

import os
import socket
import tempfile
import unittest
from unittest import mock

# Import après path setup
import sys

sys.path.insert(0, os.path.dirname(__file__))
import bridge  # noqa: E402


class ListenFdsTest(unittest.TestCase):
    def test_systemd_listen_fd_requires_listen_fds(self) -> None:
        with mock.patch.dict(os.environ, {"LISTEN_FDS": "0"}, clear=False):
            with self.assertRaises(RuntimeError):
                bridge.systemd_listen_fd()

    def test_systemd_listen_fd_returns_fd3(self) -> None:
        with mock.patch.dict(os.environ, {"LISTEN_FDS": "1"}, clear=False):
            self.assertEqual(bridge.systemd_listen_fd(), 3)

    def test_accept_over_unix_socket(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "test.sock")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(path)
            conn, _ = server.accept()
            conn.close()
            client.close()
            server.close()


if __name__ == "__main__":
    unittest.main()
