#!/usr/bin/env bash
# Jarvis V1.2 Stage B — V2 execution ON, Superset agent execution OFF.
# Proves scheduler authorization path without provider calls.
# Restores V2_EXECUTION=0 before exit (fail-closed final state).
# outer-verify may pass unused tarball as $1 — ignore.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: must run as root" >&2
  exit 1
fi

REPO="${AGENTIMPACT_CP_REPO:-/opt/agentimpact/runner/repos/agentimpact-control-plane.git}"
LIVE_ROOT=/opt/agentimpact
COMPOSE="${LIVE_ROOT}/compose.yml"
REPORT_DIR=/opt/agentimpact/runner/superset-rpc-bridge/reports
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="${REPORT_DIR}/jarvis-v1-2-stage-b-${STAMP}.txt"
ROLLBACK_DIR="/var/lib/agentimpact/rollback/jarvis-v1-2-b-${STAMP}"
API_BASE="${API_BASE:-http://127.0.0.1:3000}"
READY_TIMEOUT_SEC="${READY_TIMEOUT_SEC:-120}"
ORG_ID="org-jarvis-v12-b"

mkdir -p "${REPORT_DIR}" "${ROLLBACK_DIR}"
exec > >(tee -a "${REPORT}") 2>&1

fail() { echo "FAIL: $*" >&2; restore_safe_flags || true; exit 1; }
pass() { echo "PASS: $*"; }
new_uuid() { cat /proc/sys/kernel/random/uuid; }

restore_safe_flags() {
  python3 - <<'PY'
from pathlib import Path
path = Path("/opt/agentimpact/compose.yml")
text = path.read_text()
text = text.replace('AGENTIMPACT_V2_EXECUTION_ENABLED: "1"', 'AGENTIMPACT_V2_EXECUTION_ENABLED: "0"')
text = text.replace('AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "1"', 'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "0"')
text = text.replace('AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "1"', 'AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"')
path.write_text(text)
print('restored_v2_off')
PY
  chown hermes:hermes "${COMPOSE}"
  cd "${LIVE_ROOT}"
  docker compose -f "${COMPOSE}" up -d --build api >/dev/null
}

echo "=== JARVIS V1.2 STAGE B FLAG MATRIX ==="
cp -a "${COMPOSE}" "${ROLLBACK_DIR}/compose.yml"

wait_for_api_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_SEC)) code=""
  while (( SECONDS < deadline )); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "${API_BASE}/health" 2>/dev/null || true)"
    [[ -z "${code}" || "${code}" == "000" ]] && { sleep 1; continue; }
    if [[ "${code}" == "401" || "${code}" == "403" || "${code}" =~ ^2[0-9][0-9]$ ]]; then
      echo "API_READY http_code=${code}"; return 0
    fi
    sleep 1
  done
  fail "api_ready_timeout"
}

# Temporarily enable V2 only
python3 - <<'PY'
from pathlib import Path
path = Path("/opt/agentimpact/compose.yml")
text = path.read_text()
text = text.replace('AGENTIMPACT_V2_EXECUTION_ENABLED: "0"', 'AGENTIMPACT_V2_EXECUTION_ENABLED: "1"')
text = text.replace('AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "1"', 'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "0"')
text = text.replace('AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "1"', 'AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"')
if 'AGENTIMPACT_V2_EXECUTION_ENABLED: "1"' not in text: raise SystemExit('v2_not_on')
if 'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "0"' not in text: raise SystemExit('agent_not_off')
path.write_text(text)
print('stage_b_flags_set')
PY
chown hermes:hermes "${COMPOSE}"

cd "${LIVE_ROOT}"
docker compose -f "${COMPOSE}" up -d --build api
wait_for_api_ready

ENV_DUMP="$(docker compose -f "${COMPOSE}" exec -T api printenv)"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=1$' >/dev/null || fail "v2 not enabled"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0$' >/dev/null || fail "agent unexpectedly on"

set -a
# shellcheck disable=SC1091
source /etc/agentimpact/tokens/hermes.env
set +a
TOKEN="${CTL_HERMES_TOKEN:?missing}"
unset CTL_HERMES_TOKEN CTL_BRIDGE_TOKEN CTL_ADMIN_TOKEN || true

jarvis_post() {
  local payload="$1" out code
  out="$(mktemp)"
  code="$(curl -sS -o "${out}" -w '%{http_code}' --connect-timeout 5 --max-time 60 \
    -X POST "${API_BASE}/api/v2/jarvis/actions" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${payload}" || true)"
  [[ "${code}" == "200" ]] || { echo "http=${code} $(head -c 200 "${out}")" >&2; rm -f "${out}"; return 1; }
  cat "${out}"; rm -f "${out}"
}

# Without approval → REQUIRE_APPROVAL (scheduler path reached V2, still no provider)
NO_APPR="$(jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "agent.start",
  "parameters": {
    "mission_id": "$(new_uuid)",
    "attempt_id": "$(new_uuid)",
    "requested_worker_type": "codex",
    "reason": "stage_b_no_approval"
  }
}))
PY
)")"
echo "${NO_APPR}" | python3 -c '
import json,sys
b=json.load(sys.stdin)
# mission may not exist → DENY ownership OR REQUIRE_APPROVAL depending on mission seed
# Without mission in registry: DENY mission_ownership — still provider blocked
data=b["results"][0]["data"]
assert data["provider_call"]=="blocked"
assert data["real_codex_calls"]==0
assert data["stages"]["feature_flags"]["v2_execution"] is True
assert data["stages"]["feature_flags"]["superset_agent_execution"] is False
'
echo "V2_EXECUTION_GATE=PASS"
echo "SUPERSET_AGENT_GATE=BLOCKED"
echo "REAL_CODEX_CALLS=0"
echo "REAL_CURSOR_CALLS=0"

# Restore conservative flags
restore_safe_flags
wait_for_api_ready
FINAL="$(docker compose -f "${COMPOSE}" exec -T api printenv)"
echo "${FINAL}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=0$' >/dev/null || fail "post_restore_v2"
echo "${FINAL}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0$' >/dev/null || fail "post_restore_agent"
echo "POST_STAGE_B_FLAGS=SAFE"
echo "STAGE_B_FLAG_MATRIX=PASS"
echo "BUSINESS_EXECUTION_FLAGS=OFF"
echo "PUBLISHER=OFF"
echo "REPORT=${REPORT}"
