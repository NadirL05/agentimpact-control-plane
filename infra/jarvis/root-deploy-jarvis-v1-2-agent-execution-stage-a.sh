#!/usr/bin/env bash
# Jarvis V1.2 Stage A — no-model agent.start pipeline (flags OFF).
# outer-verify may pass unused tarball as $1 — ignore.
# Does NOT enable V2 execution, Superset agent execution, or publisher.
# Does NOT call Codex/Cursor.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: must run as root" >&2
  exit 1
fi

REPO="${AGENTIMPACT_CP_REPO:-/opt/agentimpact/runner/repos/agentimpact-control-plane.git}"
LIVE_ROOT=/opt/agentimpact
COMPOSE="${LIVE_ROOT}/compose.yml"
APP_SRC="${LIVE_ROOT}/app/src"
REPORT_DIR=/opt/agentimpact/runner/superset-rpc-bridge/reports
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="${REPORT_DIR}/jarvis-v1-2-stage-a-${STAMP}.txt"
ROLLBACK_DIR="/var/lib/agentimpact/rollback/jarvis-v1-2-a-${STAMP}"
API_BASE="${API_BASE:-http://127.0.0.1:3000}"
READY_TIMEOUT_SEC="${READY_TIMEOUT_SEC:-120}"
ORG_ID="org-jarvis-v12"

mkdir -p "${REPORT_DIR}" "${ROLLBACK_DIR}"
exec > >(tee -a "${REPORT}") 2>&1

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
new_uuid() { cat /proc/sys/kernel/random/uuid; }

echo "=== JARVIS V1.2 STAGE A (NO MODEL) ==="
echo "AGENTIMPACT_V2_EXECUTION_ENABLED=0"
echo "AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0"
echo "PUBLISHER=OFF"
echo "REAL_CODEX_CALLS=0"
echo "REAL_CURSOR_CALLS=0"

[[ -d "${REPO}/src/core/missions-v2/jarvis" ]] || fail "jarvis missing"
[[ -f "${REPO}/src/migrations/014_jarvis_v1_2_agent_start.sql" ]] || fail "migration 014 missing"

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
  fail "api_ready_timeout last=${code:-none}"
}

cd "${REPO}/src"
npx vitest run core/missions-v2/jarvis/ 2>&1 | tail -40 || fail "unit tests"
pass "unit tests"

cp -a "${COMPOSE}" "${ROLLBACK_DIR}/compose.yml"
echo "ROLLBACK_DIR=${ROLLBACK_DIR}"

# Force safe flags: Jarvis+mutations ON; execution/agent/publisher OFF
python3 - <<'PY'
from pathlib import Path
import re
path = Path("/opt/agentimpact/compose.yml")
text = path.read_text()
text = text.replace('AGENTIMPACT_JARVIS_ENABLED: "0"', 'AGENTIMPACT_JARVIS_ENABLED: "1"')
# Keep mutations as currently live (prefer 1 if already); do not force off
if 'AGENTIMPACT_JARVIS_MUTATIONS_ENABLED:' not in text:
    raise SystemExit('mutations_flag_missing')
text = text.replace('AGENTIMPACT_V2_EXECUTION_ENABLED: "1"', 'AGENTIMPACT_V2_EXECUTION_ENABLED: "0"')
text = text.replace('AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "1"', 'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "0"')
text = text.replace('AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "1"', 'AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"')
for req in [
  'AGENTIMPACT_JARVIS_ENABLED: "1"',
  'AGENTIMPACT_V2_EXECUTION_ENABLED: "0"',
  'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "0"',
  'AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"',
]:
  if req not in text: raise SystemExit(f'missing:{req}')
if re.search(r'(?m)^\s*-\s+.*executor\.sock', text): raise SystemExit('executor_mounted')
path.write_text(text)
print('compose_ok')
PY
chown hermes:hermes "${COMPOSE}"

mkdir -p "${APP_SRC}/core/missions-v2/jarvis" "${APP_SRC}/api" "${APP_SRC}/migrations"
rsync -a --delete "${REPO}/src/core/missions-v2/jarvis/" "${APP_SRC}/core/missions-v2/jarvis/"
install -o hermes -g hermes -m 0644 "${REPO}/src/api/jarvis.ts" "${APP_SRC}/api/jarvis.ts"
install -o hermes -g hermes -m 0644 "${REPO}/src/api/server.ts" "${APP_SRC}/api/server.ts"
install -o hermes -g hermes -m 0644 "${REPO}/src/migrations/014_jarvis_v1_2_agent_start.sql" \
  "${APP_SRC}/migrations/014_jarvis_v1_2_agent_start.sql"
chown -R hermes:hermes "${APP_SRC}/core/missions-v2/jarvis"

docker compose -f "${COMPOSE}" exec -T db psql -U agentimpact_app -d agentimpact \
  < "${REPO}/src/migrations/014_jarvis_v1_2_agent_start.sql" >/dev/null
docker compose -f "${COMPOSE}" exec -T db psql -U agentimpact_app -d agentimpact -Atc \
  "SELECT to_regclass('public.jarvis_agent_start_approvals') IS NOT NULL;" | grep -qx t \
  || fail "migration_014_missing"
pass "migration 014"

cd "${LIVE_ROOT}"
docker compose -f "${COMPOSE}" up -d --build api
wait_for_api_ready

ENV_DUMP="$(docker compose -f "${COMPOSE}" exec -T api printenv)"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=0$' >/dev/null || fail "v2 on"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0$' >/dev/null || fail "agent on"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=1$' >/dev/null && fail "publisher on" || true
echo "BUSINESS_EXECUTION_FLAGS=OFF"
echo "PUBLISHER=OFF"

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

# NL intent → typed agent.start → blocked before provider
NL_JSON="$(jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "message": "lance Codex sur cette mission"
}))
PY
)")"
echo "${NL_JSON}" | python3 -c '
import json,sys
b=json.load(sys.stdin)
assert b["actions"][0]["action"]=="agent.start"
assert b["actions"][0]["parameters"].get("requested_worker_type")=="codex"
d=b["policy"][0]["decision"]
assert d=="BLOCKED_BY_FEATURE_FLAG", d
data=b["results"][0]["data"]
assert data["provider_call"]=="blocked"
assert data["real_codex_calls"]==0
assert data["stages"]["policy_evaluated"] is True
assert data["stages"]["scheduler"] in ("evaluated","blocked")
'
echo "JARVIS_AGENT_START_TYPED=PASS"
echo "AGENT_START_POLICY=PASS"
echo "SCHEDULER_AGENT_START=PASS"
echo "PROVIDER_EXECUTION_BLOCKED_BY_FLAG=PASS"
echo "REAL_CODEX_CALLS=0"
echo "REAL_CURSOR_CALLS=0"

# Create disposable mission (safe mutation) then typed agent.start — still flag-blocked
CREATE_JSON="$(jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "mission.create",
  "parameters": {
    "title": "Jarvis V1.2 stage A",
    "objective": "agent start pipeline without provider",
    "project": "JARVIS",
    "requested_worker_type": "codex",
    "reason": "stage_a"
  }
}))
PY
)")"
MISSION_ID="$(echo "${CREATE_JSON}" | python3 -c 'import json,sys; d=json.load(sys.stdin)["results"][0]; assert d["ok"]; print(d["data"]["mission_id"])')"

TYPED_JSON="$(jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "agent.start",
  "parameters": {
    "mission_id": "${MISSION_ID}",
    "attempt_id": "$(new_uuid)",
    "requested_worker_type": "codex",
    "reason": "stage_a_typed"
  }
}))
PY
)")"
echo "${TYPED_JSON}" | python3 -c '
import json,sys
b=json.load(sys.stdin)
assert b["policy"][0]["decision"]=="BLOCKED_BY_FEATURE_FLAG"
assert b["results"][0]["data"]["provider_call"]=="blocked"
assert b["results"][0]["data"]["real_codex_calls"]==0
assert b["results"][0]["data"]["stages"]["policy_evaluated"] is True
assert b["results"][0]["data"]["stages"]["approval"]=="required"
'

echo "STAGE_A_NO_MODEL_SMOKE=PASS"
echo "BUSINESS_EXECUTION_FLAGS=OFF"
echo "PUBLISHER=OFF"
echo "REPORT=${REPORT}"
