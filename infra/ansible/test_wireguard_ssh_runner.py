"""Tests unitaires du normaliseur UFW WireGuard SSH (sans root / sans ufw réel)."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parent
    / "roles"
    / "wireguard_ssh_runner"
    / "files"
    / "normalize_ufw_wg_ssh.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("normalize_ufw_wg_ssh", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


SRC = "10.66.66.2"
DST = "10.66.66.1"
IFACE = "wg0"
PORT = "22"


SAMPLE_STATUS = """
Status: active

     To                         Action      From
     --                         ------      ----
[ 1] 10.66.66.2 22/tcp on wg0   ALLOW IN    10.66.66.1
[ 2] 45.144.113.141 22/tcp      ALLOW IN    Anywhere
[ 3] 176.171.153.193 22/tcp     ALLOW IN    Anywhere
[ 4] 82.224.78.70 22/tcp        ALLOW IN    Anywhere
[ 5] 22/tcp                     LIMIT IN    Anywhere
[ 6] 22/tcp (v6)                LIMIT IN    Anywhere (v6)
"""


SAMPLE_BAD_ORDER = """
Status: active

[ 1] 45.144.113.141 22/tcp      ALLOW IN    Anywhere
[ 2] 22/tcp                     LIMIT IN    Anywhere
[ 3] 10.66.66.2 22/tcp on wg0   ALLOW IN    10.66.66.1
"""


SAMPLE_DUPLICATES = """
Status: active

[ 1] 10.66.66.2 22/tcp on wg0   ALLOW IN    10.66.66.1
[ 2] 10.66.66.2 22/tcp on wg0   ALLOW IN    10.66.66.1
[ 3] 22/tcp                     LIMIT IN    Anywhere
"""


SAMPLE_GLOBAL_ALLOW = """
Status: active

[ 1] 10.66.66.2 22/tcp on wg0   ALLOW IN    10.66.66.1
[ 2] 22/tcp                     ALLOW IN    Anywhere
[ 3] 22/tcp                     LIMIT IN    Anywhere
"""


class NormalizeUfwWgSshUnitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mod = _load_module()

    def test_parse_numbered_skips_v6_and_extracts_ipv4(self) -> None:
        rules = self.mod.parse_numbered(SAMPLE_STATUS)
        self.assertEqual([r.number for r in rules], [1, 2, 3, 4, 5])
        self.assertEqual(rules[0].action, "ALLOW")
        self.assertEqual(rules[4].action, "LIMIT")

    def test_detects_canonical_wg_ssh_rule(self) -> None:
        rules = self.mod.parse_numbered(SAMPLE_STATUS)
        wg = [
            r
            for r in rules
            if self.mod.is_wg_ssh_allow(
                r, source=SRC, destination=DST, interface=IFACE, port=PORT
            )
        ]
        self.assertEqual(len(wg), 1)
        self.assertEqual(wg[0].number, 1)
        self.assertIn(SRC, wg[0].left)
        self.assertIn(f"on {IFACE}", wg[0].left.lower())
        self.assertIn("22/tcp", wg[0].left)
        self.assertIn(DST, wg[0].right)

    def test_wg_rule_is_before_public_limit(self) -> None:
        rules = self.mod.parse_numbered(SAMPLE_STATUS)
        limit = next(r for r in rules if self.mod.is_public_ssh_limit(r))
        wg = next(
            r
            for r in rules
            if self.mod.is_wg_ssh_allow(
                r, source=SRC, destination=DST, interface=IFACE, port=PORT
            )
        )
        self.assertLess(wg.number, limit.number)

    def test_public_limit_present_and_not_global_allow(self) -> None:
        rules = self.mod.parse_numbered(SAMPLE_STATUS)
        self.assertTrue(any(self.mod.is_public_ssh_limit(r) for r in rules))
        self.assertFalse(any(self.mod.is_public_ssh_allow_anywhere(r) for r in rules))

    def test_temp_public_ip_exceptions_are_not_global_allow(self) -> None:
        rules = self.mod.parse_numbered(SAMPLE_STATUS)
        temp = [r for r in rules if "45.144.113.141" in r.left or "176.171.153.193" in r.left]
        self.assertEqual(len(temp), 2)
        for rule in temp:
            self.assertFalse(self.mod.is_public_ssh_allow_anywhere(rule))

    def test_bad_order_detected(self) -> None:
        rules = self.mod.parse_numbered(SAMPLE_BAD_ORDER)
        limit = next(r for r in rules if self.mod.is_public_ssh_limit(r))
        wg = next(
            r
            for r in rules
            if self.mod.is_wg_ssh_allow(
                r, source=SRC, destination=DST, interface=IFACE, port=PORT
            )
        )
        self.assertGreater(wg.number, limit.number)

    def test_duplicates_detected(self) -> None:
        rules = self.mod.parse_numbered(SAMPLE_DUPLICATES)
        wg = [
            r
            for r in rules
            if self.mod.is_wg_ssh_allow(
                r, source=SRC, destination=DST, interface=IFACE, port=PORT
            )
        ]
        self.assertEqual(len(wg), 2)

    def test_global_allow_anywhere_detected(self) -> None:
        rules = self.mod.parse_numbered(SAMPLE_GLOBAL_ALLOW)
        self.assertTrue(any(self.mod.is_public_ssh_allow_anywhere(r) for r in rules))

    def test_module_file_has_no_private_key_material(self) -> None:
        text = MODULE_PATH.read_text(encoding="utf-8")
        for needle in (
            "BEGIN OPENSSH PRIVATE KEY",
            "BEGIN PRIVATE KEY",
            "BEGIN RSA PRIVATE KEY",
            "crsr_",
            "sk-",
            "api_key",
        ):
            self.assertNotIn(needle, text)


if __name__ == "__main__":
    unittest.main()
