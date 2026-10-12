#!/usr/bin/env bash
set -Eeuo pipefail

readonly host_unit=agentimpact-superset-host.service
readonly private_unit=agentimpact-superset-private.service

test_mode=0
if [[ "${AGENTIMPACT_TEST_ONLY:-0}" == 1 ]]; then
  [[ "$(id -u)" != 0 ]] || { echo 'test mode refuses root' >&2; exit 2; }
  test_root="$(realpath -e "${AGENTIMPACT_TEST_ROOT:?}")"
  case "$test_root" in /tmp/*|/var/tmp/*) ;; *) echo 'unsafe test root' >&2; exit 2;; esac
  test_mode=1
  expected_owner="$(id -u)"
  expected_group="$(id -g)"
  export PATH="$test_root/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  staging_root="$test_root/staging"
  rollback_root="$test_root/rollback/nadir-26-cursor-sandbox"
  apparmor_profile="$test_root/etc/apparmor.d/agentimpact-cursor-sandbox"
  host_dropin="$test_root/etc/systemd/system/agentimpact-superset-host.service.d/50-cursor-sandbox.conf"
  private_dropin="$test_root/etc/systemd/system/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf"
  preflight="$test_root/usr/local/libexec/agentimpact-cursor-sandbox-preflight"
  rollback_command="$test_root/usr/local/sbin/agentimpact-cursor-sandbox-rollback"
  apparmor_profiles="$test_root/apparmor-profiles"
  lock_file="$test_root/runner.lock"
else
  expected_owner=0
  expected_group=0
  export PATH=/usr/sbin:/usr/bin:/sbin:/bin
  staging_root=/var/lib/agentimpact-staging
  rollback_root=/var/lib/agentimpact/rollback/nadir-26-cursor-sandbox
  apparmor_profile=/etc/apparmor.d/agentimpact-cursor-sandbox
  host_dropin=/etc/systemd/system/agentimpact-superset-host.service.d/50-cursor-sandbox.conf
  private_dropin=/etc/systemd/system/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf
  preflight=/usr/local/libexec/agentimpact-cursor-sandbox-preflight
  rollback_command=/usr/local/sbin/agentimpact-cursor-sandbox-rollback
  apparmor_profiles=/sys/kernel/security/apparmor/profiles
  lock_file=/run/lock/agentimpact-cursor-sandbox-runner.lock
fi
readonly test_mode expected_owner expected_group staging_root rollback_root apparmor_profile host_dropin
readonly private_dropin preflight rollback_command apparmor_profiles lock_file

[[ "${1:-}" == --ack-agent-interruption && $# == 1 ]] || {
  echo "usage: sudo $0 --ack-agent-interruption" >&2
  exit 64
}
if ((test_mode == 0)); then
  [[ "$(id -u)" == 0 ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=root_required' >&2; exit 2; }
fi
exec 9>"$lock_file"
flock -n 9 || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=operation_in_progress' >&2; exit 2; }

script_path="$(realpath -e "${BASH_SOURCE[0]}")"
repo="$(git -C "$(dirname "$script_path")" rev-parse --show-toplevel)"
repo="$(realpath -e "$repo")"
case "$repo" in
  "$staging_root"/nadir-26-*) ;;
  *) echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=root_owned_staging_required' >&2; exit 2 ;;
esac
[[ "$(stat -c '%u:%g' "$repo")" == "$expected_owner:$expected_group" ]] \
  || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=staging_owner' >&2; exit 2; }
unsafe="$(find "$repo" -xdev \( ! -uid "$expected_owner" -o ! -gid "$expected_group" -o -perm /022 \) -print -quit)"
[[ -z "$unsafe" ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=staging_permissions' >&2; exit 2; }
if git -C "$repo" symbolic-ref -q HEAD >/dev/null; then
  echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=detached_head_required' >&2
  exit 2
fi
sha="$(git -C "$repo" rev-parse --verify HEAD)"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=invalid_commit' >&2; exit 2; }
[[ "$repo" == "$staging_root/nadir-26-$sha" ]] \
  || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=staging_sha_mismatch' >&2; exit 2; }
[[ -z "$(git -C "$repo" status --porcelain)" ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=staging_dirty' >&2; exit 2; }
origin="$(git -C "$repo" remote get-url origin)"
case "$origin" in
  https://github.com/NadirL05/agentimpact-control-plane|https://github.com/NadirL05/agentimpact-control-plane.git) ;;
  *) echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=unexpected_origin' >&2; exit 2 ;;
esac

readonly source_profile="$repo/infra/apparmor/agentimpact-cursor-sandbox"
readonly source_host_dropin="$repo/infra/systemd/agentimpact-superset-host.service.d/50-cursor-sandbox.conf"
readonly source_private_dropin="$repo/infra/systemd/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf"
readonly source_preflight="$repo/infra/scripts/cursor-sandbox-preflight.sh"
readonly source_rollback="$repo/infra/scripts/root-rollback-cursor-sandbox-runner.sh"

check_source() {
  local path="$1" actual_mode allowed_mode
  shift
  [[ -f "$path" && ! -L "$path" ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=source_missing' >&2; exit 2; }
  [[ "$(stat -c '%u:%g' "$path")" == "$expected_owner:$expected_group" ]] \
    || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=source_identity' >&2; exit 2; }
  actual_mode="$(stat -c '%a' "$path")"
  for allowed_mode in "$@"; do
    [[ "$actual_mode" == "$allowed_mode" ]] && return 0
  done
  printf 'CURSOR_SANDBOX_INSTALL=FAIL reason=source_mode file=%s mode=%s\n' \
    "$(basename "$path")" "$actual_mode" >&2
  exit 2
}
check_source "$source_profile" 644 600
check_source "$source_host_dropin" 644 600
check_source "$source_private_dropin" 644 600
check_source "$source_preflight" 755 700
check_source "$source_rollback" 755 700

for command in apparmor_parser flock git grep install journalctl mktemp realpath runuser sha256sum systemctl; do
  command -v "$command" >/dev/null || { echo "CURSOR_SANDBOX_INSTALL=FAIL reason=missing_${command}" >&2; exit 2; }
done

show_property() {
  systemctl show "$host_unit" -p "$1" --value
}
[[ "$(show_property User)" == agentimpact-superset ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=host_user' >&2; exit 2; }
[[ "$(show_property Group)" == agentimpact-superset ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=host_group' >&2; exit 2; }
[[ "$(show_property NoNewPrivileges)" == yes ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=no_new_privileges' >&2; exit 2; }
[[ "$(show_property PrivateTmp)" == yes ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=private_tmp' >&2; exit 2; }
[[ "$(show_property ProtectSystem)" == strict ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=protect_system' >&2; exit 2; }
[[ -z "$(show_property CapabilityBoundingSet)" ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=capabilities_present' >&2; exit 2; }
[[ "$(systemctl is-active "$host_unit")" == active ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=host_not_active' >&2; exit 2; }

if ((test_mode == 1)); then
  "$source_preflight" --static
else
  runuser -u agentimpact-superset -- "$source_preflight" --static
fi
apparmor_parser -p "$source_profile" >/dev/null

profile_loaded() {
  grep -q '^agentimpact-cursor-sandbox ' "$apparmor_profiles"
}

namespaces_are_cursor_ready() {
  local actual expected
  actual="$(show_property RestrictNamespaces | tr ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ')"
  expected="$(printf '%s\n' user mnt pid ipc uts cgroup net | sort -u | tr '\n' ' ')"
  [[ "$actual" == "$expected" ]]
}

current_invocation_preflight_passed() {
  local invocation
  invocation="$(systemctl show "$host_unit" -p InvocationID --value)"
  [[ -n "$invocation" ]] || return 1
  journalctl -q -u "$host_unit" "_SYSTEMD_INVOCATION_ID=$invocation" --no-pager -o cat \
    | grep -Fq 'CURSOR_SANDBOX_PREFLIGHT=PASS mode=runtime'
}

if cmp -s "$source_profile" "$apparmor_profile" \
  && cmp -s "$source_host_dropin" "$host_dropin" \
  && cmp -s "$source_private_dropin" "$private_dropin" \
  && cmp -s "$source_preflight" "$preflight" \
  && cmp -s "$source_rollback" "$rollback_command" \
  && profile_loaded \
  && namespaces_are_cursor_ready \
  && current_invocation_preflight_passed; then
  printf 'CURSOR_SANDBOX_INSTALL=ALREADY_CONVERGED commit=%s\n' "$sha"
  exit 0
fi

echo 'AGENT_INTERRUPTION=YES action=cursor_sandbox_install services=Superset_host_and_private_executor'
echo 'All active Superset-hosted agents and terminals will be interrupted.'

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
bundle="$rollback_root/$timestamp-${sha:0:12}"
install -d -m 0700 -o "$expected_owner" -g "$expected_group" "$rollback_root"
[[ ! -e "$bundle" ]] || { echo 'CURSOR_SANDBOX_INSTALL=FAIL reason=rollback_bundle_exists' >&2; exit 2; }
install -d -m 0700 -o "$expected_owner" -g "$expected_group" "$bundle"

backup_target() {
  local label="$1" target="$2"
  if [[ -e "$target" || -L "$target" ]]; then
    cp -a "$target" "$bundle/$label.previous"
    if [[ -L "$target" ]]; then
      readlink "$target" | sha256sum | awk '{print $1}' >"$bundle/$label.symlink.sha256"
    fi
  else
    install -m 0600 /dev/null "$bundle/$label.absent"
  fi
}

backup_target apparmor "$apparmor_profile"
backup_target host-dropin "$host_dropin"
backup_target private-dropin "$private_dropin"
backup_target preflight "$preflight"
backup_target rollback-command "$rollback_command"
systemctl is-active "$host_unit" >"$bundle/host.was-active" || true
systemctl is-active "$private_unit" >"$bundle/private.was-active" || true
show_property RestrictNamespaces >"$bundle/host.restrict-namespaces.before"
if profile_loaded; then printf 'yes\n'; else printf 'no\n'; fi >"$bundle/apparmor.was-loaded"
printf '%s\n' "$sha" >"$bundle/source.commit"
(cd "$bundle" && find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%P\0' \
  | sort -z | xargs -0 sha256sum >SHA256SUMS)
install -m 0600 /dev/null "$bundle/BACKUP_COMPLETE"
ln -sfnT "$bundle" "$rollback_root/current"

mutated=0
rollback_on_error() {
  local status="${1:-$?}"
  trap - ERR INT TERM
  if ((mutated == 1)); then
    echo 'CURSOR_SANDBOX_INSTALL=ROLLING_BACK_AUTOMATICALLY' >&2
    if AGENTIMPACT_CURSOR_SANDBOX_LOCK_HELD=1 "$source_rollback" --bundle "$bundle"; then
      echo 'CURSOR_SANDBOX_INSTALL=AUTO_ROLLBACK_PASS' >&2
    else
      echo "CURSOR_SANDBOX_INSTALL=AUTO_ROLLBACK_FAIL bundle=$bundle" >&2
    fi
  fi
  exit "$status"
}
trap 'rollback_on_error $?' ERR
trap 'rollback_on_error 130' INT
trap 'rollback_on_error 143' TERM

atomic_install() {
  local source="$1" target="$2" mode="$3" temporary
  install -d -m 0755 "$(dirname "$target")"
  temporary="$(mktemp --tmpdir="$(dirname "$target")" .nadir26-install.XXXXXX)"
  install -m "$mode" -o "$expected_owner" -g "$expected_group" "$source" "$temporary"
  mv -fT "$temporary" "$target"
}

mutated=1
atomic_install "$source_preflight" "$preflight" 0755
if ((test_mode == 1)) && [[ "${AGENTIMPACT_TEST_FAIL_AFTER_FIRST_MUTATION:-0}" == 1 ]]; then
  false
fi
atomic_install "$source_rollback" "$rollback_command" 0755
atomic_install "$source_host_dropin" "$host_dropin" 0644
atomic_install "$source_private_dropin" "$private_dropin" 0644
atomic_install "$source_profile" "$apparmor_profile" 0644

apparmor_parser -r "$apparmor_profile"
systemctl daemon-reload
if [[ "$(<"$bundle/private.was-active")" == active ]]; then
  systemctl restart "$private_unit"
fi
systemctl restart "$host_unit"
systemctl is-active --quiet "$host_unit"
profile_loaded
namespaces_are_cursor_ready
[[ "$(show_property NoNewPrivileges)" == yes ]]
[[ "$(show_property PrivateTmp)" == yes ]]
[[ "$(show_property ProtectSystem)" == strict ]]
[[ -z "$(show_property CapabilityBoundingSet)" ]]
current_invocation_preflight_passed
cmp -s "$source_profile" "$apparmor_profile"
cmp -s "$source_host_dropin" "$host_dropin"
cmp -s "$source_private_dropin" "$private_dropin"
cmp -s "$source_preflight" "$preflight"

install -m 0600 /dev/null "$bundle/DEPLOYED"
trap - ERR INT TERM
printf 'CURSOR_SANDBOX_INSTALL=PASS commit=%s bundle=%s\n' "$sha" "$bundle"
echo 'CURSOR_SANDBOX_RUNTIME=PATCH_APPLIED_PREFLIGHT_PASS_NOT_LIVE_VERIFIED'
