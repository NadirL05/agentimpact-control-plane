"""Non-regression: R8 fixture policy matches CodexPolicy.strict() exactly."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_fixture as builder
from build_fixture import POLICY_KEYS, registry_policy, repository_policy


FORBIDDEN_POLICY_KEYS = frozenset({
    "base_sha", "publisher", "publisherEnabled", "branch", "headSha",
    "attemptId", "leaseId", "fencingToken",
})


class PolicyBuilderTests(unittest.TestCase):
    def test_repository_policy_exact_keys_only(self):
        entry = repository_policy(
            "repo", "/srv/git/repo.git", ["src/a.js"], 2048,
            [{"name": "t", "file": "/usr/bin/node", "args": ["--test"]}],
        )
        self.assertEqual(tuple(entry), POLICY_KEYS)
        self.assertEqual(set(entry), set(POLICY_KEYS))
        self.assertTrue(FORBIDDEN_POLICY_KEYS.isdisjoint(entry))

    def test_registry_rejects_builder_injection_of_forbidden_keys(self):
        entry = repository_policy(
            "repo", "/srv/git/repo.git", ["src/a.js"], 1024,
            [{"name": "t", "file": "/usr/bin/node", "args": []}],
        )
        poisoned = dict(entry)
        poisoned["publisher"] = False
        with self.assertRaisesRegex(Exception, "policy_forbidden_keys"):
            builder.require(
                not ({"base_sha", "publisher"} & set(poisoned)),
                "policy_forbidden_keys",
            )

    def test_built_fixture_policy_and_plan_contract(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        preparation = Path(scratch.name) / "preparation"
        with patch.object(builder, "ROOT", preparation), patch("builtins.print"):
            builder.build()
        policy = json.loads((preparation / "policy.proposed.json").read_text())
        self.assertEqual(set(policy), {"repositories"})
        self.assertEqual(len(policy["repositories"]), 1)
        entry = policy["repositories"][0]
        self.assertEqual(set(entry), set(POLICY_KEYS))
        self.assertTrue(FORBIDDEN_POLICY_KEYS.isdisjoint(entry))
        self.assertNotIn("base_sha", entry)
        self.assertNotIn("publisher", entry)

        plan = json.loads((preparation / "plan.json").read_text())
        self.assertIs(plan["policy_compatible_with_deployed_schema"], True)
        self.assertEqual(plan["base_sha_binding"], "attempt_and_lease_contract")
        self.assertEqual(plan["publisher_control"], "control_plane_runtime")
        self.assertRegex(plan["base_sha"], r"^[0-9a-f]{40}$")
        self.assertIs(plan["publisher"], False)
        self.assertEqual(plan["real_codex_calls"], 0)

        # Registry helper produces the same supported shape.
        rebuilt = registry_policy(
            entry["repoId"], entry["mirrorPath"], entry["allowedPaths"],
            entry["maxDiffBytes"], entry["requiredTests"],
        )
        self.assertEqual(rebuilt, policy)


if __name__ == "__main__":
    unittest.main()
