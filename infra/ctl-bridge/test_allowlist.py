"""Tests unitaires allowlist bridge."""

import unittest

from allowlist import ALLOWED_CMDS, _proposal_body, build_query_path, validate_params


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

    def test_malformed_limit_rejected_without_exception(self) -> None:
        self.assertEqual(
            validate_params("missions.list", {"limit": "not-a-number"}),
            "limit out of range",
        )

    def test_non_dict_params_rejected(self) -> None:
        self.assertEqual(validate_params("health", []), "invalid params")

    def test_proposal_body_ignores_client_identity(self) -> None:
        body = _proposal_body(
            {
                "title": "Titre valide",
                "instruction": "Instruction assez longue pour passer.",
                "proposed_by_uid": 4242,
                "proposed_by": "spoofed",
            },
            1001,
        )
        self.assertEqual(body["proposed_by_uid"], 1001)
        self.assertEqual(body["proposed_by"], "agentimpact-runner")

    def test_proposal_body_omits_absent_source_url(self) -> None:
        body = _proposal_body(
            {
                "title": "Titre valide",
                "instruction": "Instruction assez longue pour passer.",
            },
            1001,
        )
        self.assertNotIn("source_url", body)

    def test_build_query_path_urlencodes_values(self) -> None:
        path = build_query_path(
            "missions.list",
            "/missions",
            {"status": "in progress", "limit": 10},
        )
        self.assertIn("status=in%20progress", path)
        self.assertIn("limit=10", path)


if __name__ == "__main__":
    unittest.main()
