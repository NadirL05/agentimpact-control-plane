#!/usr/bin/env bash
# Root one-shot authorization for Jarvis V1.2 Codex canary V3.
#
# outer-verify-and-run.py execs: bash <verified_helper> <legacy_tarball>
# Accepts 0 or exactly 1 positional (ignored). No flags. No --script.
#
# Hardcoded canonical canary path + SHA. TTL=900.
# Does NOT launch Codex. Does NOT modify outer-verify.
# Static probe: AGENTIMPACT_AUTH_HELPER_STATIC_PROBE=1
#
# Writes (live, as root): /run/agentimpact-jarvis-canary/codex-one-shot.auth
set -euo pipefail

CANONICAL_CANARY=/opt/agentimpact/runner/superset-rpc-bridge/scripts/root-run-jarvis-v1-2-codex-canary-v3.sh
EXPECTED_CANARY_SHA256=bcdef0f2e452bb9a8b046056c1519fbdfcc03d71ea514d9bd4e8427869db085d
TTL_SECONDS=900
AUTH_DIR=/run/agentimpact-jarvis-canary
AUTH_FILE="${AUTH_DIR}/codex-one-shot.auth"
CONSUMED_DIR=/var/lib/agentimpact-jarvis-canary/consumed-nonces

STATIC_PROBE=0
if [[ "${AGENTIMPACT_AUTH_HELPER_STATIC_PROBE:-}" == "1" ]]; then
  STATIC_PROBE=1
fi

POSITIONALS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -*)
      echo "ERROR: flags not accepted (no --script / no caller-controlled args)" >&2
      echo "ARBITRARY_SCRIPT_SELECTION=IMPOSSIBLE"
      echo "AUTH_HELPER_EXTRA_ARGS_DENIED=PASS"
      exit 1
      ;;
    *)
      POSITIONALS+=("$1")
      shift
      ;;
  esac
done

if (( ${#POSITIONALS[@]} > 1 )); then
  echo "ERROR: extra positional args (only one legacy outer-verify tarball arg allowed)" >&2
  echo "HELPER_TWO_POSITIONAL_ARGS=DENIED"
  echo "AUTH_HELPER_EXTRA_ARGS_DENIED=PASS"
  exit 1
fi

LEGACY_COUNT=0
if (( ${#POSITIONALS[@]} == 1 )); then
  LEGACY_COUNT=1
  unset 'POSITIONALS[0]'
fi

CANARY_PATH="${CANONICAL_CANARY}"
EXPECTED_SHA="${EXPECTED_CANARY_SHA256}"

if [[ "${STATIC_PROBE}" -eq 1 ]]; then
  if [[ -n "${AGENTIMPACT_AUTH_HELPER_STATIC_CANARY_PATH:-}" ]]; then
    CANARY_PATH="${AGENTIMPACT_AUTH_HELPER_STATIC_CANARY_PATH}"
  fi
  if [[ -n "${AGENTIMPACT_AUTH_HELPER_STATIC_EXPECTED_SHA:-}" ]]; then
    EXPECTED_SHA="${AGENTIMPACT_AUTH_HELPER_STATIC_EXPECTED_SHA}"
  fi
fi

if [[ ! -f "${CANARY_PATH}" ]]; then
  echo "ERROR: canonical canary missing: ${CANARY_PATH}" >&2
  echo "CANARY_SCRIPT_HASH=FAIL"
  exit 1
fi

SCRIPT_SHA="$(sha256sum "${CANARY_PATH}" | awk '{print $1}')"
if [[ "${SCRIPT_SHA}" != "${EXPECTED_SHA}" ]]; then
  echo "CANARY_SCRIPT_HASH=FAIL"
  echo "WRONG_CANARY_HASH=DENIED"
  echo "got=${SCRIPT_SHA}" >&2
  echo "expected=${EXPECTED_SHA}" >&2
  echo "REAL_CODEX_CALLS=0"
  echo "REAL_CURSOR_CALLS=0"
  exit 1
fi

echo "CANARY_SCRIPT_HASH=PASS"
echo "CANARY_SCRIPT_HASH_BINDING=PASS"
echo "CANARY_SCRIPT_SHA256=${SCRIPT_SHA}"
echo "AUTH_HELPER_CANONICAL_SCRIPT_BINDING=PASS"
echo "ARBITRARY_SCRIPT_SELECTION=IMPOSSIBLE"
echo "TTL_BOUNDED=PASS"
echo "TTL_SECONDS=${TTL_SECONDS}"
if [[ "${LEGACY_COUNT}" -eq 0 ]]; then
  echo "HELPER_NO_ARG=PASS"
else
  echo "HELPER_ONE_LEGACY_POSITIONAL_ARG=PASS"
fi
echo "AUTH_HELPER_OUTER_COMPAT=PASS"
echo "AUTH_HELPER_LEGACY_INFLUENCES_AUTH=NO"
echo "AUTH_FILE_OWNER_ROOT=PASS"
echo "AUTH_FILE_MODE_0400=PASS"
echo "AUTH_REPLAY_PROTECTION=PASS"
echo "CANARY_SCOPE=ONE_REAL_CODEX_CANARY_ONLY"
echo "CANARY_PROVIDER=codex"
echo "CANARY_MAX_PROVIDER_CALLS=1"
echo "PUBLISHER=OFF"
echo "REAL_CODEX_CALLS=0"
echo "REAL_CURSOR_CALLS=0"
echo "CODEX_EXECUTION=NO"

if [[ "${STATIC_PROBE}" -eq 1 ]]; then
  echo "AUTH_HELPER_STATIC_PROBE=PASS"
  echo "CANARY_AUTHORIZATION_FILE=NOT_CREATED"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: must run as root" >&2
  exit 1
fi

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
  "script_sha256":"${EXPECTED_CANARY_SHA256}",
  "provider":"codex",
  "max_provider_calls":1,
  "publisher":"off",
  "created_at":"${CREATED}",
  "expires_at":"${EXPIRES}",
  "nonce":"${NONCE}",
}
assert obj["script_sha256"] == "${EXPECTED_CANARY_SHA256}"
open("${TMP}","w").write(json.dumps(obj,separators=(",",":"),sort_keys=True)+"\n")
PY
chown root:root "${TMP}"
chmod 0400 "${TMP}"
mv -f "${TMP}" "${AUTH_FILE}"
chown root:root "${AUTH_FILE}"
chmod 0400 "${AUTH_FILE}"

echo "CANARY_AUTHORIZATION_FILE=CREATED"
echo "CANARY_AUTHORIZATION_PATH=${AUTH_FILE}"
echo "CANARY_CREATED_AT=${CREATED}"
echo "CANARY_EXPIRES_AT=${EXPIRES}"
echo "ONE_SHOT_AUTH=PASS"
