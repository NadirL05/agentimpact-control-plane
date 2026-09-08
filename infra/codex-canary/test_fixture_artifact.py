"""Integration test of the exact prepared R8 archive, without privileged access."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import bootstrap as b
import build_fixture as builder
from build_fixture import IDS, SOURCE, TEST, run


class ArtifactTests(unittest.TestCase):
    def test_actual_archive_publish_reuse_and_git_integrity(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        preparation = Path(scratch.name) / "preparation"
        with patch.object(builder, "ROOT", preparation), patch("builtins.print"):
            builder.build()
        data = (preparation / "bundle.tar.gz").read_bytes()
        expected_sha = b.sha(data)
        expected = json.loads((preparation / "inventory.json").read_bytes())
        with tempfile.TemporaryDirectory() as temporary:
            state, path = b.publish(Path(temporary), IDS, data, expected_sha, expected)
            self.assertEqual(state, "PUBLISHED")
            state, repeated = b.publish(Path(temporary), IDS, data, expected_sha, expected)
            self.assertEqual(state, "EXACT_MATCH_REUSABLE")
            self.assertEqual(path, repeated)
            fixture = path / "fixture"
            self.assertEqual(run(fixture, "/usr/bin/git", "rev-parse", "HEAD").strip(),
                             b"31b97eeae466646dda48b85ab3e9e00e572f43d6")
            self.assertEqual(run(fixture, "/usr/bin/git", "status", "--porcelain"), b"")
            self.assertEqual(run(fixture, "/usr/bin/git", "remote"), b"")
            run(fixture, "/usr/bin/git", "fsck", "--full", "--strict")
            self.assertEqual(run(fixture, "/usr/bin/git", "ls-files", "-s"),
                             run(preparation / "fixture", "/usr/bin/git", "ls-files", "-s"))
            self.assertEqual((fixture / "src/increment.js").read_bytes(), SOURCE)
            self.assertEqual((fixture / "test/increment.test.js").read_bytes(), TEST)
            for forbidden in ("hooks", "objects/info/alternates", "refs/replace", "shallow",
                              "worktrees", "modules", "lfs", "config.worktree"):
                self.assertFalse((fixture / ".git" / forbidden).exists(), forbidden)
            self.assertFalse((fixture / ".gitmodules").exists())
            self.assertFalse((fixture / ".gitattributes").exists())
            self.assertFalse(any(p.is_symlink() for p in fixture.rglob("*")))
            run(fixture, "/usr/bin/node", "--test", "test/increment.test.js", expected=1)
            policy = json.loads((preparation / "policy.proposed.json").read_text())
            self.assertEqual(set(policy["repositories"][0]), set(builder.POLICY_KEYS))
            self.assertNotIn("base_sha", policy["repositories"][0])
            self.assertNotIn("publisher", policy["repositories"][0])
            plan = json.loads((preparation / "plan.json").read_text())
            self.assertIs(plan["policy_compatible_with_deployed_schema"], True)
            self.assertRegex(plan["base_sha"], r"^[0-9a-f]{40}$")
            self.assertIs(plan["publisher"], False)


if __name__ == "__main__":
    unittest.main()
