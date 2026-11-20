#!/usr/bin/env bash
# Create root-owned one-shot authorization for Jarvis V1.2 Codex canary v2.
# Does NOT launch Codex / Cursor. Does NOT modify outer-verify.
#
# Usage (as root):
#   ./root-authorize-jarvis-v1-2-one-codex-canary.sh \
#     --script /path/to/root-run-jarvis-v1-2-codex-canary-armed-v2.sh \
#     [--ttl-seconds 900]
#
# Writes: /run/agentimpact-jarvis-canary/codex-one-shot.auth (0400 root:root)
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: must run as root" >&2
  exit 1
fi

SCRIPT_PATH=""
TTL_SECONDS=900
AUTH_DIR=/run/agentimpact-jarvis-canary
AUTH_FILE="${AUTH_DIR}/codex-one-shot.auth"
CONSUMED_DIR=/var/lib/agentimpact-jarvis-canary/consumed-nonces

while [[ $# -gt 0 ]]; do
  case "$1" in
    --script) SCRIPT_PATH="${2:?}"; shift 2 ;;
    --ttl-seconds) TTL_SECONDS="${2:?}"; shift 2 ;;
    *) echo "ERROR: unknown arg $1" >&2; exit 1 ;;
  esac
done

[[ -n "${SCRIPT_PATH}" ]] || { echo "ERROR: --script required" >&2; exit 1; }
[[ -f "${SCRIPT_PATH}" ]] || { echo "ERROR: script not found" >&2; exit 1; }
[[ "${TTL_SECONDS}" =~ ^[0-9]+$ ]] && (( TTL_SECONDS >= 60 && TTL_SECONDS <= 3600 )) \
  || { echo "ERROR: ttl must be 60..3600" >&2; exit 1; }

SCRIPT_SHA="$(sha256sum "${SCRIPT_PATH}" | awk '{print $1}')"
NONCE="$(cat /proc/sys/kernel/random/uuid)"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EXPIRES="$(date -u -d "+${TTL_SECONDS} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || python3 -c "from datetime import datetime,timedelta,timezone;print((datetime.now(timezone.utc)+timedelta(seconds=int('${TTL_SECONDS}'))).strftime('%Y-%m-%dT%H:%M:%SZ'))")"

mkdir -p "${AUTH_DIR}"
chmod 0700 "${AUTH_DIR}"
chown root:root "${AUTH_DIR}"
mkdir -p "${CONSUMED_DIR}"
chmod 0700 "${CONSUMED_DIR}"
chown root:root "${CONSUMED_DIR}"

TMP="$(mktemp "${AUTH_DIR}/.auth.XXXXXX")"
python3 - <<PY
import json
obj={
  "scope":"ONE_REAL_CODEX_CANARY_ONLY",
  "script_sha256":"${SCRIPT_SHA}",
  "provider":"codex",
  "max_provider_calls":1,
  "publisher":"off",
  "created_at":"${CREATED}",
  "expires_at":"${EXPIRES}",
  "nonce":"${NONCE}",
}
open("${TMP}","w").write(json.dumps(obj,separators=(",",":"),sort_keys=True)+"\n")
PY
chown root:root "${TMP}"
chmod 0400 "${TMP}"
mv -f "${TMP}" "${AUTH_FILE}"
chown root:root "${AUTH_FILE}"
chmod 0400 "${AUTH_FILE}"

# Never print nonce in a way that enables replay without the file — nonce is inside the file only.
echo "CANARY_AUTHORIZATION_FILE=CREATED"
echo "CANARY_AUTHORIZATION_PATH=${AUTH_FILE}"
echo "CANARY_SCOPE=ONE_REAL_CODEX_CANARY_ONLY"
echo "CANARY_PROVIDER=codex"
echo "CANARY_MAX_PROVIDER_CALLS=1"
echo "CANARY_SCRIPT_SHA256=${SCRIPT_SHA}"
echo "CANARY_CREATED_AT=${CREATED}"
echo "CANARY_EXPIRES_AT=${EXPIRES}"
echo "PUBLISHER=OFF"
echo "REAL_CODEX_CALLS=0"
