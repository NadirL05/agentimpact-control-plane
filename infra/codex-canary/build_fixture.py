"""Build a NEW local R8 fixture and CodexPolicy-compatible registry; never installs them."""
import io
import gzip
from pathlib import Path
import subprocess
import tarfile

from bootstrap import canonical, require, sha

IDS = {"preflight": "f0bb3f79-9718-44c2-a8be-25b6b727bc92",
       "mission": "3d034b98-a775-41db-bffc-bd0e7dc24d0c",
       "attempt": "99df976d-6595-4cde-b5ba-c1c9c92fe560"}
REPO = "codex-r8-" + IDS["mission"]
ROOT = Path("/home/agentimpact-runner/r8-preparation-" + IDS["preflight"])
# Exact CodexPolicy / codexRepositoryPolicySchema.strict() keys. Never add
# base_sha or publisher here: those bindings live on attempt/lease and runtime.
POLICY_KEYS = ("repoId", "mirrorPath", "allowedPaths", "maxDiffBytes", "requiredTests")
ENV = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "LANG": "C.UTF-8",
       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
       "GIT_AUTHOR_NAME": "AgentImpact Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
       "GIT_COMMITTER_NAME": "AgentImpact Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
       "GIT_AUTHOR_DATE": "2026-09-08T12:00:00Z", "GIT_COMMITTER_DATE": "2026-09-08T12:00:00Z"}
SOURCE = b"exports.increment = (value) => value;\n"
FIXED = b"exports.increment = (value) => value + 1;\n"
TEST = b"""const { test } = require('node:test');
const assert = require('node:assert/strict');
const { increment } = require('../src/increment');
test('increments positive, zero and negative inputs', () => {
  for (const value of [-3, 0, 7]) assert.equal(increment(value), value + 1);
});
"""


def run(cwd, *args, expected=0):
    result = subprocess.run(args, cwd=cwd, env=ENV, capture_output=True, timeout=30, check=False)
    require(result.returncode == expected, "local_fixture_check_failed")
    return result.stdout


def repository_policy(repo_id, mirror_path, allowed_paths, max_diff_bytes, required_tests):
    """Build one CodexPolicy entry with only schema-supported keys."""
    entry = {
        "repoId": repo_id,
        "mirrorPath": mirror_path,
        "allowedPaths": list(allowed_paths),
        "maxDiffBytes": max_diff_bytes,
        "requiredTests": list(required_tests),
    }
    require(tuple(entry) == POLICY_KEYS, "policy_key_order_or_set_invalid")
    require(not ({"base_sha", "publisher"} & set(entry)), "policy_forbidden_keys")
    return entry


def registry_policy(repo_id, mirror_path, allowed_paths, max_diff_bytes, required_tests):
    return {"repositories": [
        repository_policy(repo_id, mirror_path, allowed_paths, max_diff_bytes, required_tests),
    ]}


def build():
    ROOT.mkdir(mode=0o700)  # Refuse existing preparations, including partial ones.
    work = ROOT / "fixture"
    work.mkdir()
    (work / "src").mkdir()
    (work / "test").mkdir()
    (work / "src/increment.js").write_bytes(SOURCE)
    (work / "test/increment.test.js").write_bytes(TEST)
    run(work, "/usr/bin/git", "init", "--template=", "--initial-branch=r8-fixture")
    run(work, "/usr/bin/git", "add", "src/increment.js", "test/increment.test.js")
    run(work, "/usr/bin/git", "commit", "-m", "R8 immutable increment fixture")
    base = run(work, "/usr/bin/git", "rev-parse", "HEAD").decode().strip()
    require(run(work, "/usr/bin/git", "status", "--porcelain") == b"", "fixture_dirty")
    require(run(work, "/usr/bin/git", "remote") == b"", "fixture_remote")
    run(work, "/usr/bin/git", "fsck", "--full", "--strict")
    run(work, "/usr/bin/node", "--test", "test/increment.test.js", expected=1)
    # Expected fix validated in a separate non-Git directory, never in the fixture.
    fixed = ROOT / "expected-fix"
    (fixed / "src").mkdir(parents=True)
    (fixed / "test").mkdir()
    (fixed / "src/increment.js").write_bytes(FIXED)
    (fixed / "test/increment.test.js").write_bytes(TEST)
    run(fixed, "/usr/bin/node", "--test", "test/increment.test.js")
    future_mirror = "/var/lib/agentimpact-codex-worker/fixtures/" + IDS["attempt"] + ".git"
    # CodexPolicy only. base_sha binds via attempt/lease; publisher stays runtime OFF.
    policy = registry_policy(
        REPO, future_mirror, ["src/increment.js"], 2048,
        [{"name": "increment-test", "file": "/usr/bin/node",
          "args": ["--test", "test/increment.test.js"]}],
    )
    payload = canonical(policy)
    (ROOT / "policy.proposed.json").write_bytes(payload)
    manifest = {"ids": IDS, "repo_id": REPO, "base_sha": base,
        "base_sha_binding": "attempt_and_lease_contract",
        "publisher_control": "control_plane_runtime",
        "policy_sha256": sha(payload), "policy_compatible_with_deployed_schema": True,
        "test_before": "FAIL_EXIT_1", "test_expected_fix": "PASS_EXIT_0",
        "workspace": "/var/lib/agentimpact-codex-worker/attempts/" + IDS["attempt"] + "/workspace",
        "max_attempts": 1, "mission_retries": 0, "concurrency": 1, "deadline_seconds": 300,
        "expected_codex_executions": 1, "publisher": False, "quota_state": "UNKNOWN",
        "api_fallback": False, "real_codex_calls": 0}
    (ROOT / "plan.json").write_bytes(canonical(manifest))
    inventory = {}
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        paths = [work, *sorted(work.rglob("*")), ROOT / "policy.proposed.json", ROOT / "plan.json"]
        for path in paths:
            require(not path.is_symlink(), "fixture_symlink")
            relative = path.relative_to(ROOT).as_posix()
            info = tarfile.TarInfo(relative)
            info.uid = info.gid = info.mtime = 0
            if path.is_dir():
                info.type, info.mode = tarfile.DIRTYPE, 0o700
                inventory[relative] = None
                archive.addfile(info)
            else:
                content = path.read_bytes()
                info.size, info.mode = len(content), 0o400
                inventory[relative] = sha(content)
                archive.addfile(info, io.BytesIO(content))
    bundle = gzip.compress(buffer.getvalue(), mtime=0)
    (ROOT / "bundle.tar.gz").write_bytes(bundle)
    (ROOT / "inventory.json").write_bytes(canonical(inventory))
    print("R8_BASE_SHA=" + base)
    print("R8_POLICY_SHA256=" + sha(payload))
    print("R8_BUNDLE_SHA256=" + sha(bundle))
    print("POLICY_COMPATIBLE_WITH_DEPLOYED_SCHEMA=YES")
    print("BASE_SHA_BINDING=ATTEMPT_AND_LEASE_CONTRACT")
    print("PUBLISHER_CONTROL=CONTROL_PLANE_RUNTIME")
    print("LOCAL_PREPARATION=" + str(ROOT))
    print("REAL_CODEX_CALLS=0")


if __name__ == "__main__":
    build()
