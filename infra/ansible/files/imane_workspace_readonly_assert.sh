#!/usr/bin/env bash
# Assertions Imane workspace RO — aucun secret, aucune mutation.
set -euo pipefail

REPO="${1:-/opt/agentimpact/runner/repos/imn-academy-tanstack}"
SAMPLE="${REPO}/package.json"
OWNER_EXPECTED="agentimpact-runner:agentimpact-runner"
ORIGIN_FETCH_EXPECTED="git@github.com:NadirL05/imane-projet.git"
ORIGIN_PUSH_EXPECTED="DISABLED"

fail() { echo "ASSERT_FAIL: $*" >&2; exit 1; }
ok() { echo "ASSERT_OK: $*"; }

[ -d "$REPO" ] || fail "repo_missing:$REPO"
owner="$(stat -c '%U:%G' "$REPO")"
[ "$owner" = "$OWNER_EXPECTED" ] || fail "owner:$owner"

# ACL parents traverse
getfacl -p /opt/agentimpact/runner 2>/dev/null | grep -q 'user:hermes:--x' \
  || fail "acl_runner_traverse"
getfacl -p /opt/agentimpact/runner/repos 2>/dev/null | grep -q 'user:hermes:--x' \
  || fail "acl_repos_traverse"
getfacl -p "$REPO" 2>/dev/null | grep -Eq 'user:hermes:r-x' \
  || fail "acl_repo_read"

runuser -u hermes -- test -x /opt/agentimpact/runner || fail "hermes_traverse_runner"
runuser -u hermes -- test -x /opt/agentimpact/runner/repos || fail "hermes_traverse_repos"
runuser -u hermes -- test -r "$SAMPLE" || fail "hermes_read_file"
runuser -u hermes -- git -C "$REPO" status --short >/dev/null || fail "hermes_git_status"
runuser -u hermes -- git -C "$REPO" log -1 --oneline >/dev/null || fail "hermes_git_log"
runuser -u hermes -- git -C "$REPO" diff --stat >/dev/null || fail "hermes_git_diff"

probe="${REPO}/.imane_ro_assert_probe_$$"
if runuser -u hermes -- touch "$probe" 2>/dev/null; then
  rm -f "$probe"
  fail "hermes_can_write_sources"
fi
gprobe="${REPO}/.git/imane_ro_assert_probe_$$"
if runuser -u hermes -- touch "$gprobe" 2>/dev/null; then
  rm -f "$gprobe"
  fail "hermes_can_write_git"
fi
ok "hermes_read_pass_write_denied"

fetch_url="$(runuser -u agentimpact-runner -- git -C "$REPO" remote get-url origin)"
push_url="$(runuser -u agentimpact-runner -- git -C "$REPO" remote get-url --push origin)"
[ "$fetch_url" = "$ORIGIN_FETCH_EXPECTED" ] || fail "origin_fetch:$fetch_url"
[ "$push_url" = "$ORIGIN_PUSH_EXPECTED" ] || fail "origin_push:$push_url"
ok "origin_fetch_ok_push_disabled"

# Push must fail
if runuser -u agentimpact-runner -- git -C "$REPO" push origin HEAD >/dev/null 2>&1; then
  fail "push_unexpectedly_succeeded"
fi
ok "push_disabled"

# Runner still writable
runuser -u agentimpact-runner -- test -w "$REPO" || fail "runner_not_writable"
ok "runner_write_preserved"

# No hermes GitHub identity for this repo required — hermes must not need SSH to github
# (informational): skip network

echo "imane_workspace_readonly_assert=PASS"
