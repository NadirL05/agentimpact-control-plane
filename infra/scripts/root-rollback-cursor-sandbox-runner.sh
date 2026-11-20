#!/usr/bin/env bash
set -Eeuo pipefail

test_mode=0
if [[ "${AGENTIMPACT_TEST_ONLY:-0}" == 1 ]]; then
  [[ "$(id -u)" != 0 ]] || { echo 'test mode refuses root' >&2; exit 2; }
  test_root="$(realpath -e "${AGENTIMPACT_TEST_ROOT:?}")"
  case "$test_root" in /tmp/*|/var/tmp/*) ;; *) echo 'unsafe test root' >&2; exit 2;; esac
  test_mode=1
  export PATH="$test_root/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  rollback_root="$test_root/rollback/nadir-26-cursor-sandbox"
  apparmor_profile="$test_root/etc/apparmor.d/agentimpact-cursor-sandbox"
  host_dropin="$test_root/etc/systemd/system/agentimpact-superset-host.service.d/50-cursor-sandbox.conf"
  private_dropin="$test_root/etc/systemd/system/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf"
  preflight="$test_root/usr/local/libexec/agentimpact-cursor-sandbox-preflight"
  rollback_command="$test_root/usr/local/sbin/agentimpact-cursor-sandbox-rollback"
  apparmor_profiles="$test_root/apparmor-profiles"
  lock_file="$test_root/runner.lock"
else
  export PATH=/usr/sbin:/usr/bin:/sbin:/bin
  rollback_root=/var/lib/agentimpact/rollback/nadir-26-cursor-sandbox
  apparmor_profile=/etc/apparmor.d/agentimpact-cursor-sandbox
  host_dropin=/etc/systemd/system/agentimpact-superset-host.service.d/50-cursor-sandbox.conf
  private_dropin=/etc/systemd/system/agentimpact-superset-private.service.d/50-cursor-toolchain-readonly.conf
  preflight=/usr/local/libexec/agentimpact-cursor-sandbox-preflight
  rollback_command=/usr/local/sbin/agentimpact-cursor-sandbox-rollback
  apparmor_profiles=/sys/kernel/security/apparmor/profiles
  lock_file=/run/lock/agentimpact-cursor-sandbox-runner.lock
fi
readonly test_mode rollback_root apparmor_profile host_dropin private_dropin
readonly preflight rollback_command apparmor_profiles lock_file
readonly host_unit=agentimpact-superset-host.service
readonly private_unit=agentimpact-superset-private.service

dry_run=0
bundle=""

fail() {
  printf 'CURSOR_SANDBOX_ROLLBACK=FAIL reason=%s\n' "$1" >&2
  exit 2
}

usage() {
  echo "usage: $0 [--dry-run] [--bundle PATH]" >&2
  exit 64
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --bundle)
      (($# >= 2)) || usage
      bundle="$2"
      shift
      ;;
    *) usage ;;
  esac
  shift
done

if [[ -z "$bundle" ]]; then
  [[ -L "$rollback_root/current" ]] || fail current_bundle_missing
  bundle="$(readlink -e "$rollback_root/current")" || fail current_bundle_invalid
fi
[[ -d "$bundle" && ! -L "$bundle" ]] || fail bundle_invalid
bundle="$(realpath -e "$bundle")"

if ((dry_run == 0)); then
  if ((test_mode == 0)); then
    [[ "$(id -u)" == 0 ]] || fail root_required
    expected_owner=0
    expected_group=0
  else
    expected_owner="$(id -u)"
    expected_group="$(id -g)"
  fi
  if [[ "${AGENTIMPACT_CURSOR_SANDBOX_LOCK_HELD:-0}" != 1 ]]; then
    exec 9>"$lock_file"
    flock -n 9 || fail operation_in_progress
  fi
  case "$bundle" in
    "$rollback_root"/*) ;;
    *) fail bundle_outside_rollback_root ;;
  esac
  [[ "$(stat -c '%u:%g:%a' "$bundle")" == "$expected_owner:$expected_group:700" ]] \
    || fail bundle_permissions
fi

[[ -f "$bundle/BACKUP_COMPLETE" ]] || fail backup_incomplete
[[ -f "$bundle/SHA256SUMS" ]] || fail backup_checksums_missing
(cd "$bundle" && sha256sum -c SHA256SUMS >/dev/null) || fail backup_checksum_mismatch

for label in apparmor host-dropin private-dropin preflight rollback-command; do
  previous=0
  absent=0
  [[ -e "$bundle/$label.previous" || -L "$bundle/$label.previous" ]] && previous=1
  [[ -f "$bundle/$label.absent" ]] && absent=1
  ((previous + absent == 1)) || fail "backup_state_${label}"
  if [[ -L "$bundle/$label.previous" ]]; then
    [[ -f "$bundle/$label.symlink.sha256" ]] || fail "missing_symlink_hash_${label}"
    actual_link_hash="$(readlink "$bundle/$label.previous" | sha256sum | awk '{print $1}')"
    [[ "$actual_link_hash" == "$(<"$bundle/$label.symlink.sha256")" ]] \
      || fail "symlink_hash_${label}"
  elif [[ -e "$bundle/$label.symlink.sha256" ]]; then
    fail "unexpected_symlink_hash_${label}"
  fi
done
for state_file in host.was-active private.was-active host.restrict-namespaces.before apparmor.was-loaded; do
  [[ -f "$bundle/$state_file" ]] || fail "missing_${state_file//./_}"
done

if ((dry_run == 1)); then
  printf 'CURSOR_SANDBOX_ROLLBACK_DRY_RUN=PASS bundle=%s\n' "$bundle"
  exit 0
fi

if [[ -f "$bundle/ROLLED_BACK" ]]; then
  printf 'CURSOR_SANDBOX_ROLLBACK=ALREADY_ROLLED_BACK bundle=%s\n' "$bundle"
  exit 0
fi

echo 'AGENT_INTERRUPTION=YES action=cursor_sandbox_rollback services=Superset_host_and_private_executor'
systemctl stop "$host_unit"
systemctl stop "$private_unit"

restore_target() {
  local label="$1" target="$2" temporary
  if [[ -e "$bundle/$label.previous" || -L "$bundle/$label.previous" ]]; then
    install -d -m 0755 "$(dirname "$target")"
    temporary="$(mktemp --tmpdir="$(dirname "$target")" ".nadir26-${label}.XXXXXX")"
    unlink "$temporary"
    cp -a "$bundle/$label.previous" "$temporary"
    mv -fT "$temporary" "$target"
  elif [[ -e "$target" || -L "$target" ]]; then
    unlink "$target"
  fi
}

profile_loaded() {
  grep -q '^agentimpact-cursor-sandbox ' "$apparmor_profiles"
}

if [[ "$(<"$bundle/apparmor.was-loaded")" == yes ]]; then
  restore_target apparmor "$apparmor_profile"
  apparmor_parser -r "$apparmor_profile"
else
  if profile_loaded; then
    apparmor_parser -R "$apparmor_profile"
  fi
  restore_target apparmor "$apparmor_profile"
fi

restore_target host-dropin "$host_dropin"
restore_target private-dropin "$private_dropin"
restore_target preflight "$preflight"
restore_target rollback-command "$rollback_command"

systemctl daemon-reload
actual_namespaces="$(systemctl show "$host_unit" -p RestrictNamespaces --value)"
expected_namespaces="$(<"$bundle/host.restrict-namespaces.before")"
[[ "$actual_namespaces" == "$expected_namespaces" ]] || fail restrict_namespaces_not_restored

if [[ "$(<"$bundle/private.was-active")" == active ]]; then
  systemctl start "$private_unit"
else
  systemctl stop "$private_unit"
fi
if [[ "$(<"$bundle/host.was-active")" == active ]]; then
  systemctl start "$host_unit"
else
  systemctl stop "$host_unit"
fi

install -m 0600 /dev/null "$bundle/ROLLED_BACK"
printf 'CURSOR_SANDBOX_ROLLBACK=PASS bundle=%s\n' "$bundle"
