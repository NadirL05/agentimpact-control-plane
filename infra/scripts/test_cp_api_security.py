"""Tests sécurité cp-api.sh — token hors argv."""

from __future__ import annotations

import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "cp-api.sh"


class CpApiSecurityTest(unittest.TestCase):
    def test_token_not_passed_via_curl_argv(self) -> None:
        content = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("CURL_ARGS", content)
        self.assertNotIn('-H "Authorization: Bearer ${TOKEN}"', content)
        self.assertIn("--config", content)
        self.assertIn('chmod 600 "$CURL_CFG"', content)

    def test_token_loaded_from_env_file_not_argv(self) -> None:
        content = SCRIPT.read_text(encoding="utf-8")
        self.assertIn('. "$ENV_FILE"', content)
        self.assertIn('printf \'header = "Authorization: Bearer %s"\\n\' "$TOKEN"', content)


if __name__ == "__main__":
    unittest.main()
