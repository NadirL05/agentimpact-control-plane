"""Tests unitaires allowlist bridge."""

import unittest

from allowlist import ALLOWED_CMDS, validate_params


class AllowlistTest(unittest.TestCase):
    def test_forbidden_cmds_absent(self) -> None:
        for forbidden in (
            "acp",
            "mcp",
            "chat",
            "dispatch",
            "shell",
            "hermes",
        ):
            self.assertNotIn(forbidden, ALLOWED_CMDS)

    def test_mission_propose_validation(self) -> None:
        self.assertIsNone(
            validate_params(
                "mission.propose",
                {
                    "title": "Titre valide",
                    "instruction": "Instruction assez longue pour passer.",
                    "target_agent": "dev-senior",
                },
            )
        )
        self.assertEqual(
            validate_params(
                "mission.propose",
                {"title": "x", "instruction": "court", "target_agent": "dev-senior"},
            ),
            "invalid title",
        )


if __name__ == "__main__":
    unittest.main()
