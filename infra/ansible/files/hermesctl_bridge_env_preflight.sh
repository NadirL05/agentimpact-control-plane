#!/usr/bin/env bash
# Préflight bridge.env — états de cycle de vie sécurisés (sans lire le contenu).
# Usage: hermesctl_bridge_env_preflight.sh <path>
set -euo pipefail

f="${1:-}"
if [ -z "$f" ]; then
  echo "missing_bridge_env_path" >&2
  exit 1
fi

if [ ! -e "$f" ]; then
  echo "missing_bridge_env" >&2
  exit 1
fi
if [ -L "$f" ]; then
  echo "invalid_bridge_env_preflight" >&2
  exit 1
fi
if [ ! -f "$f" ]; then
  echo "invalid_bridge_env_preflight" >&2
  exit 1
fi

perms=$(stat -c '%a' "$f")
owner=$(stat -c '%U:%G' "$f")
group=$(((perms / 10) % 10))
other=$((perms % 10))

case "$owner" in
  root:root|root:agentimpact-ctl)
    if [ "$group" -ge 4 ] || [ "$other" -ge 4 ]; then
      echo "unsafe_bridge_preflight" >&2
      exit 1
    fi
    ;;
  agentimpact-ctl:agentimpact-ctl)
    if ! getent passwd agentimpact-ctl >/dev/null 2>&1; then
      echo "missing_agentimpact_ctl_user" >&2
      exit 1
    fi
    if ! getent group agentimpact-ctl >/dev/null 2>&1; then
      echo "missing_agentimpact_ctl_group" >&2
      exit 1
    fi
    if [ "$perms" != "400" ]; then
      echo "unexpected_bridge_mode_preflight" >&2
      exit 1
    fi
    if [ "$group" -ne 0 ] || [ "$other" -ne 0 ]; then
      echo "unsafe_bridge_preflight" >&2
      exit 1
    fi
    ;;
  *)
    echo "unexpected_bridge_owner_preflight:${owner}" >&2
    exit 1
    ;;
esac

echo "bridge_env_preflight=ok"
