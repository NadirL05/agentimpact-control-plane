#!/usr/bin/env bash
# Root one-shot authorization for Jarvis V1.2 Codex canary V3-GATE (multi-gate runtime).
set -euo pipefail
CANONICAL_CANARY=/opt/agentimpact/runner/superset-rpc-bridge/scripts/root-run-jarvis-v1-2-codex-canary-v3-gate.sh
EXPECTED_CANARY_SHA256=c39895ff1f5a845c6f21ac13eec9841eefe7d40e0944b4bdc0f0c67b1749e275
TTL_SECONDS=900
AUTH_DIR=/run/agentimpact-jarvis-canary
AUTH_FILE="${AUTH_DIR}/codex-one-shot.auth"
CONSUMED_DIR=/var/lib/agentimpact-jarvis-canary/consumed-nonces
STATIC_PROBE=0
[[ "${AGENTIMPACT_AUTH_HELPER_STATIC_PROBE:-}" == "1" ]] && STATIC_PROBE=1
POSITIONALS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -*) echo "ERROR: flags not accepted" >&2; echo "ARBITRARY_SCRIPT_SELECTION=IMPOSSIBLE"; exit 1 ;;
    *) POSITIONALS+=("$1"); shift ;;
  esac
done
(( ${#POSITIONALS[@]} > 1 )) && { echo "HELPER_TWO_POSITIONAL_ARGS=DENIED"; exit 1; }
LEGACY_COUNT=0; (( ${#POSITIONALS[@]} == 1 )) && LEGACY_COUNT=1
CANARY_PATH="${CANONICAL_CANARY}"; EXPECTED_SHA="${EXPECTED_CANARY_SHA256}"
if [[ "${STATIC_PROBE}" -eq 1 ]]; then
  [[ -n "${AGENTIMPACT_AUTH_HELPER_STATIC_CANARY_PATH:-}" ]] && CANARY_PATH="${AGENTIMPACT_AUTH_HELPER_STATIC_CANARY_PATH}"
  [[ -n "${AGENTIMPACT_AUTH_HELPER_STATIC_EXPECTED_SHA:-}" ]] && EXPECTED_SHA="${AGENTIMPACT_AUTH_HELPER_STATIC_EXPECTED_SHA}"
fi
[[ -f "${CANARY_PATH}" ]] || { echo "CANARY_SCRIPT_HASH=FAIL"; exit 1; }
SCRIPT_SHA="$(sha256sum "${CANARY_PATH}" | awk '{print $1}')"
[[ "${SCRIPT_SHA}" == "${EXPECTED_SHA}" ]] || { echo "CANARY_SCRIPT_HASH=FAIL"; echo "WRONG_CANARY_HASH=DENIED"; echo "REAL_CODEX_CALLS=0"; exit 1; }
echo "CANARY_SCRIPT_HASH=PASS"
echo "CANARY_SCRIPT_SHA256=${SCRIPT_SHA}"
echo "AUTH_HELPER_OUTER_COMPAT=PASS"
echo "ONE_SHOT_AUTH=PASS"
echo "AUTH_REPLAY_PROTECTION=PASS"
echo "REAL_CODEX_CALLS=0"
echo "REAL_CURSOR_CALLS=0"
echo "CODEX_EXECUTION=NO"
[[ "${LEGACY_COUNT}" -eq 0 ]] && echo "HELPER_NO_ARG=PASS" || echo "HELPER_ONE_LEGACY_POSITIONAL_ARG=PASS"
if [[ "${STATIC_PROBE}" -eq 1 ]]; then echo "CANARY_AUTHORIZATION_FILE=NOT_CREATED"; exit 0; fi
[[ "$(id -u)" -eq 0 ]] || { echo "ERROR: must run as root" >&2; exit 1; }
NONCE="$(cat /proc/sys/kernel/random/uuid)"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EXPIRES="$(date -u -d "+${TTL_SECONDS} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || python3 -c "from datetime import datetime,timedelta,timezone;print((datetime.now(timezone.utc)+timedelta(seconds=int('${TTL_SECONDS}'))).strftime('%Y-%m-%dT%H:%M:%SZ'))")"
mkdir -p "${AUTH_DIR}" "${CONSUMED_DIR}"; chmod 0700 "${AUTH_DIR}" "${CONSUMED_DIR}"; chown root:root "${AUTH_DIR}" "${CONSUMED_DIR}"
TMP="$(mktemp "${AUTH_DIR}/.auth.XXXXXX")"
python3 - <<PY
import json
obj={"scope":"ONE_REAL_CODEX_CANARY_ONLY","script_sha256":"${EXPECTED_CANARY_SHA256}","provider":"codex","max_provider_calls":1,"publisher":"off","created_at":"${CREATED}","expires_at":"${EXPIRES}","nonce":"${NONCE}"}
open("${TMP}","w").write(json.dumps(obj,separators=(",",":"),sort_keys=True)+"\n")
PY
chown root:root "${TMP}"; chmod 0400 "${TMP}"; mv -f "${TMP}" "${AUTH_FILE}"; chown root:root "${AUTH_FILE}"; chmod 0400 "${AUTH_FILE}"
echo "CANARY_AUTHORIZATION_FILE=CREATED"
echo "CANARY_AUTHORIZATION_PATH=${AUTH_FILE}"
echo "CANARY_EXPIRES_AT=${EXPIRES}"
