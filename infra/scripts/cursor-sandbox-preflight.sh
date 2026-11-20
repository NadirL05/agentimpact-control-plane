#!/usr/bin/env bash
set -euo pipefail

mode="${1:---static}"
case "$mode" in
  --static|--runtime) ;;
  *) echo "usage: $0 [--static|--runtime]" >&2; exit 64 ;;
esac

readonly cursor_root=/var/lib/agentimpact-superset/toolchains/cursor/2026.09.08-6caf4ff/payload
readonly cursor_agent_sha=2ccc9a8e167797641448b5e5c936f006ba137a2555f117f38c5eb76a5238a233
readonly cursor_node_sha=e0e46d3a1c0667117303412647cafcbcefb1be7612493015ec8fd6b7440162a4
readonly cursor_index_sha=61b58f6a0b9e64970fce5f001526996a786a121f3d8836fa2e1d4b3629f3b02f
readonly cursor_sandbox_sha=ecdd7459846e9e48317098a96b5260c0e99f6ee935f9f37256005293511cb779

fail() {
  printf 'CURSOR_SANDBOX_PREFLIGHT=FAIL reason=%s\n' "$1" >&2
  exit 2
}

check_file() {
  local name="$1" expected_sha="$2" expected_mode="$3" path actual
  path="$cursor_root/$name"
  [[ -f "$path" && ! -L "$path" ]] || fail "unsafe_${name//[^A-Za-z0-9]/_}"
  [[ "$(stat -c '%u:%g:%a' "$path")" == "0:0:$expected_mode" ]] \
    || fail "ownership_or_mode_${name//[^A-Za-z0-9]/_}"
  actual="$(sha256sum "$path")"
  [[ "${actual%% *}" == "$expected_sha" ]] || fail "hash_${name//[^A-Za-z0-9]/_}"
}

[[ "$(/sbin/sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" == 1 ]] \
  || fail apparmor_unprivileged_userns_must_remain_restricted
[[ -d "$cursor_root" && ! -L "$cursor_root" ]] || fail cursor_payload_directory
[[ "$(stat -c '%u:%g:%a' "$cursor_root")" == 0:0:755 ]] || fail cursor_payload_ownership

check_file cursor-agent "$cursor_agent_sha" 755
check_file node "$cursor_node_sha" 755
check_file index.js "$cursor_index_sha" 644
check_file cursorsandbox "$cursor_sandbox_sha" 755

if [[ "$mode" == --runtime ]]; then
  [[ "$(id -un)" == agentimpact-superset ]] || fail runtime_identity
  [[ ! -w /var/lib/agentimpact-superset ]] || fail runtime_root_must_be_readonly
  [[ ! -w /var/lib/agentimpact-superset/toolchains ]] || fail toolchain_must_be_readonly

  policy_file="$(mktemp "${TMPDIR:-/tmp}/cursor-sandbox-preflight.XXXXXX")"
  trap 'unlink "$policy_file"' EXIT
  chmod 0600 "$policy_file"
  printf '%s\n' \
    '{"sandbox":{"type":"workspace_readwrite","cwd":"/tmp"},"networkPolicyStrict":true}' \
    >"$policy_file"

  # --preflight-only exercises namespace, mount, Landlock and bubblewrap
  # availability, but deliberately does not exec /usr/bin/true.
  /usr/bin/timeout 20 "$cursor_root/cursorsandbox" \
    --policy "$policy_file" --preflight-only -- /usr/bin/true \
    || fail native_helper
fi

printf 'CURSOR_SANDBOX_PREFLIGHT=PASS mode=%s release=2026.09.08-6caf4ff\n' "${mode#--}"
