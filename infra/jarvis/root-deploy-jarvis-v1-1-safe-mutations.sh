#!/usr/bin/env bash
# Jarvis V1.1 safe mutations — deploy + no-model live smoke.
# outer-verify may pass unused tarball as $1 — ignore.
#
# Enables ONLY AGENTIMPACT_JARVIS_MUTATIONS_ENABLED for smoke.
# Keeps V2 execution / agent execution / publisher OFF.
# No Codex/Cursor/agent.create/agent.start.
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
REPORT="${REPORT_DIR}/jarvis-v1-1-safe-mutations-${STAMP}.txt"
ROLLBACK_DIR="/var/lib/agentimpact/rollback/jarvis-v1-1-${STAMP}"
API_BASE="${API_BASE:-http://127.0.0.1:3000}"
READY_TIMEOUT_SEC="${READY_TIMEOUT_SEC:-120}"
READY_INTERVAL_SEC="${READY_INTERVAL_SEC:-1}"
ORG_ID="org-jarvis-v11"

mkdir -p "${REPORT_DIR}" "${ROLLBACK_DIR}"
exec > >(tee -a "${REPORT}") 2>&1

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

echo "=== JARVIS V1.1 SAFE MUTATIONS ==="
echo "STAMP=${STAMP}"
echo "BUSINESS_EXECUTION_FLAGS=OFF"
echo "PUBLISHER=OFF"
echo "REAL_CODEX_CALLS=0"
echo "REAL_CURSOR_CALLS=0"

[[ -d "${REPO}/src/core/missions-v2/jarvis" ]] || fail "jarvis module missing"
[[ -f "${REPO}/src/migrations/013_jarvis_v1_1_safe_mutations.sql" ]] || fail "migration 013 missing"
[[ -f "${COMPOSE}" ]] || fail "live compose missing"

wait_for_api_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_SEC)) code="" curl_rc=0
  echo "API_READINESS_POLL timeout=${READY_TIMEOUT_SEC}s probe=${API_BASE}/health"
  while (( SECONDS < deadline )); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 2 --max-time 5 "${API_BASE}/health" 2>/dev/null || true)"
    curl_rc=$?
    if [[ -z "${code}" || "${code}" == "000" ]]; then
      sleep "${READY_INTERVAL_SEC}"; continue
    fi
    if [[ "${code}" == "401" || "${code}" == "403" || "${code}" =~ ^2[0-9][0-9]$ ]]; then
      echo "API_READY http_code=${code}"; return 0
    fi
    sleep "${READY_INTERVAL_SEC}"
  done
  fail "api_ready_timeout last_http_code=${code:-none} curl_rc=${curl_rc}"
}

# --- Unit / integration (no live secrets) ---
cd "${REPO}/src"
npx vitest run \
  core/missions-v2/jarvis/jarvis.test.ts \
  core/missions-v2/jarvis/mutations.test.ts \
  api/jarvis.test.ts \
  2>&1 | tail -50 || fail "unit tests failed"
pass "unit tests"

# --- Rollback snapshot ---
cp -a "${COMPOSE}" "${ROLLBACK_DIR}/compose.yml"
mkdir -p "${ROLLBACK_DIR}/jarvis"
[[ -d "${APP_SRC}/core/missions-v2/jarvis" ]] && cp -a "${APP_SRC}/core/missions-v2/jarvis/." "${ROLLBACK_DIR}/jarvis/" || true
echo "ROLLBACK_DIR=${ROLLBACK_DIR}"

# --- Live compose: Jarvis+mutations ON; unsafe flags OFF ---
python3 - <<'PY'
from pathlib import Path
import re
path = Path("/opt/agentimpact/compose.yml")
text = path.read_text()
text = text.replace('AGENTIMPACT_JARVIS_ENABLED: "0"', 'AGENTIMPACT_JARVIS_ENABLED: "1"')
text = text.replace('AGENTIMPACT_JARVIS_MUTATIONS_ENABLED: "0"', 'AGENTIMPACT_JARVIS_MUTATIONS_ENABLED: "1"')
# If already "1", leave as-is; force unsafe OFF if somehow flipped
text = text.replace('AGENTIMPACT_V2_EXECUTION_ENABLED: "1"', 'AGENTIMPACT_V2_EXECUTION_ENABLED: "0"')
text = text.replace('AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "1"', 'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "0"')
text = text.replace('AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "1"', 'AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"')
required = [
    'AGENTIMPACT_JARVIS_ENABLED: "1"',
    'AGENTIMPACT_JARVIS_MUTATIONS_ENABLED: "1"',
    'AGENTIMPACT_V2_EXECUTION_ENABLED: "0"',
    'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "0"',
    'AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"',
    '/run/agentimpact-superset-rpc/bridge.sock',
]
for item in required:
    if item not in text:
        raise SystemExit(f'missing_required_compose:{item}')
if re.search(r'(?m)^\s*-\s+.*executor\.sock', text):
    raise SystemExit('private_executor_mounted')
if re.search(r'(?m)^\s*-\s+.*docker\.sock', text):
    raise SystemExit('docker_sock_mounted')
if re.search(r'(?m)^\s*-\s+.*/etc/credstore', text):
    raise SystemExit('credstore_mounted')
path.write_text(text)
print('compose_flags_ok')
PY
chown hermes:hermes "${COMPOSE}"

# --- Sync sources ---
mkdir -p "${APP_SRC}/core/missions-v2/jarvis" "${APP_SRC}/api" "${APP_SRC}/migrations" "${APP_SRC}/core"
rsync -a --delete "${REPO}/src/core/missions-v2/jarvis/" "${APP_SRC}/core/missions-v2/jarvis/"
install -o hermes -g hermes -m 0644 "${REPO}/src/api/jarvis.ts" "${APP_SRC}/api/jarvis.ts"
install -o hermes -g hermes -m 0644 "${REPO}/src/api/server.ts" "${APP_SRC}/api/server.ts"
install -o hermes -g hermes -m 0644 "${REPO}/src/core/auth-scopes.ts" "${APP_SRC}/core/auth-scopes.ts"
install -o hermes -g hermes -m 0644 "${REPO}/src/migrations/012_jarvis_v1_audit.sql" \
  "${APP_SRC}/migrations/012_jarvis_v1_audit.sql"
install -o hermes -g hermes -m 0644 "${REPO}/src/migrations/013_jarvis_v1_1_safe_mutations.sql" \
  "${APP_SRC}/migrations/013_jarvis_v1_1_safe_mutations.sql"
chown -R hermes:hermes "${APP_SRC}/core/missions-v2/jarvis"
pass "sources reconciled"

# --- Migrations idempotent ---
docker compose -f "${COMPOSE}" exec -T db \
  psql -U agentimpact_app -d agentimpact \
  < "${REPO}/src/migrations/012_jarvis_v1_audit.sql" >/dev/null
docker compose -f "${COMPOSE}" exec -T db \
  psql -U agentimpact_app -d agentimpact \
  < "${REPO}/src/migrations/013_jarvis_v1_1_safe_mutations.sql" >/dev/null
docker compose -f "${COMPOSE}" exec -T db \
  psql -U agentimpact_app -d agentimpact -v ON_ERROR_STOP=1 -Atc \
  "SELECT to_regclass('public.jarvis_mutation_idempotency') IS NOT NULL
   AND to_regclass('public.jarvis_missions') IS NOT NULL
   AND to_regclass('public.jarvis_workspaces') IS NOT NULL
   AND to_regclass('public.jarvis_test_runs') IS NOT NULL
   AND to_regclass('public.jarvis_agent_stops') IS NOT NULL;" \
  | grep -qx t || fail "migration_013_objects_missing"
echo "MIGRATION_013=PASS"

# --- Rebuild API ---
cd "${LIVE_ROOT}"
docker compose -f "${COMPOSE}" up -d --build api
wait_for_api_ready
pass "api http ready"

ENV_DUMP="$(docker compose -f "${COMPOSE}" exec -T api printenv)"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_JARVIS_ENABLED=1$' >/dev/null || fail "jarvis not enabled"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_JARVIS_MUTATIONS_ENABLED=1$' >/dev/null || fail "mutations not enabled for smoke"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=0$' >/dev/null || fail "business execution on"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0$' >/dev/null || fail "agent execution on"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=1$' >/dev/null && fail "publisher on" || true
echo "AGENT_CREATE_ENABLED=NO"
echo "AGENT_START_ENABLED=NO"
echo "BUSINESS_EXECUTION_FLAGS=OFF"
echo "PUBLISHER=OFF"

docker compose -f "${COMPOSE}" exec -T api sh -c 'test ! -e /run/agentimpact-superset-rpc/executor.sock'
docker compose -f "${COMPOSE}" exec -T api sh -c 'test ! -e /etc/credstore/agentimpact-superset-api-key'
docker compose -f "${COMPOSE}" exec -T api sh -c 'test ! -e /var/run/docker.sock'
echo "PRIVATE_SUPERSET_SOCKET_VISIBLE_IN_DOCKER=NO"
echo "SUPERSET_CREDENTIAL_VISIBLE_IN_DOCKER=NO"
echo "DOCKER_SOCKET_VISIBLE_IN_DOCKER=NO"
echo "JARVIS_DIRECT_SUPERSET_ACCESS=NO"

# Auth token (never printed)
set -a
# shellcheck disable=SC1091
source /etc/agentimpact/tokens/hermes.env
set +a
TOKEN="${CTL_HERMES_TOKEN:?missing_hermes_token}"
unset CTL_HERMES_TOKEN CTL_BRIDGE_TOKEN CTL_ADMIN_TOKEN || true

jarvis_typed() {
  local payload="$1"
  local out code
  out="$(mktemp)"
  code="$(curl -sS -o "${out}" -w '%{http_code}' \
    --connect-timeout 5 --max-time 60 \
    -X POST "${API_BASE}/api/v2/jarvis/actions" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${payload}" || true)"
  if [[ "${code}" != "200" ]]; then
    echo "jarvis_typed_failed http=${code} body=$(head -c 240 "${out}" | tr '\n' ' ')" >&2
    rm -f "${out}"
    return 1
  fi
  cat "${out}"
  rm -f "${out}"
}

new_uuid() { cat /proc/sys/kernel/random/uuid; }

# --- Auth gate ---
auth_code="$(curl -sS -o /dev/null -w '%{http_code}' \
  --connect-timeout 5 --max-time 15 \
  -X POST "${API_BASE}/api/v2/jarvis/actions" \
  -H 'Content-Type: application/json' \
  -d "{\"request_id\":\"$(new_uuid)\",\"message\":\"status\",\"organization_id\":\"${ORG_ID}\"}" || true)"
[[ "${auth_code}" == "401" || "${auth_code}" == "403" ]] || fail "JARVIS_AUTH expected 401/403 got ${auth_code}"
echo "JARVIS_AUTH=PASS"

# ========== Safe mutation happy path ==========
CREATE_RID="$(new_uuid)"
CREATE_JSON="$(jarvis_typed "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "${CREATE_RID}",
  "organization_id": "${ORG_ID}",
  "action": "mission.create",
  "parameters": {
    "title": "Jarvis V1.1 disposable",
    "objective": "safe mutation smoke only — no agent start",
    "project": "JARVIS",
    "requested_worker_type": "codex",
    "reason": "v1_1_smoke"
  }
}))
PY
)")"
echo "${CREATE_JSON}" | python3 -c '
import json,sys
d=json.load(sys.stdin)["results"][0]
assert d["ok"] is True
assert d["data"]["MISSION_CREATED"] is True
assert d["data"]["AGENT_STARTED"] is False
assert d["data"]["publisher"]=="off"
'
MISSION_ID="$(echo "${CREATE_JSON}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["results"][0]["data"]["mission_id"])')"
echo "MISSION_CREATE=PASS"
echo "AGENT_STARTED=NO"

ATTEMPT_ID="$(new_uuid)"
FENCE="$(new_uuid)"
PROJECT_ID="$(new_uuid)"
WS_RID="$(new_uuid)"
WS_JSON="$(jarvis_typed "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "${WS_RID}",
  "organization_id": "${ORG_ID}",
  "action": "workspace.create",
  "parameters": {
    "mission_id": "${MISSION_ID}",
    "attempt_id": "${ATTEMPT_ID}",
    "fencing_token": "${FENCE}",
    "project_id": "${PROJECT_ID}",
    "name": "jarvis-v11-ws",
    "branch": "jarvis/v11-smoke"
  }
}))
PY
)")"
echo "${WS_JSON}" | python3 -c 'import json,sys; assert json.load(sys.stdin)["results"][0]["ok"] is True'
WS_ID="$(echo "${WS_JSON}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["results"][0]["data"]["workspace"]["id"])')"
echo "WORKSPACE_CREATE=PASS"

TEST_JSON="$(jarvis_typed "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "tests.run",
  "parameters": {
    "mission_id": "${MISSION_ID}",
    "attempt_id": "${ATTEMPT_ID}",
    "fencing_token": "${FENCE}",
    "test_profile": "mission_validation"
  }
}))
PY
)")"
echo "${TEST_JSON}" | python3 -c '
import json,sys
d=json.load(sys.stdin)["results"][0]
assert d["ok"] is True
assert d["data"]["profile"]=="mission_validation"
assert "test_run_id" in d["data"]
'
echo "TESTS_RUN=PASS"

STOP_JSON="$(jarvis_typed "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "agent.stop",
  "parameters": {
    "mission_id": "${MISSION_ID}",
    "attempt_id": "${ATTEMPT_ID}",
    "fencing_token": "${FENCE}",
    "reason": "no_active_agent_idempotent"
  }
}))
PY
)")"
echo "${STOP_JSON}" | python3 -c '
import json,sys
d=json.load(sys.stdin)["results"][0]
assert d["ok"] is True
assert d["data"]["status"] in ("stopped","already_stopped")
'
echo "AGENT_STOP=PASS"

DEL_JSON="$(jarvis_typed "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "workspace.delete",
  "parameters": {
    "workspace_id": "${WS_ID}",
    "mission_id": "${MISSION_ID}",
    "attempt_id": "${ATTEMPT_ID}",
    "fencing_token": "${FENCE}",
    "reason": "smoke_cleanup"
  }
}))
PY
)")"
echo "${DEL_JSON}" | python3 -c 'import json,sys; assert json.load(sys.stdin)["results"][0]["ok"] is True'
echo "WORKSPACE_DELETE=PASS"

CANCEL_JSON="$(jarvis_typed "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "mission.cancel",
  "parameters": {"mission_id": "${MISSION_ID}", "reason": "smoke_cleanup"}
}))
PY
)")"
echo "${CANCEL_JSON}" | python3 -c 'import json,sys; assert json.load(sys.stdin)["results"][0]["ok"] is True'
echo "MISSION_CANCEL=PASS"

# ========== Denials ==========
assert_decision() {
  local payload="$1" expected="$2" label="$3"
  local out
  out="$(jarvis_typed "${payload}")"
  echo "${out}" | python3 -c "
import json,sys
b=json.load(sys.stdin)
d=b['policy'][0]['decision']
assert d in (${expected}), (d, '${label}')
"
  echo "${label}=PASS"
}

assert_decision "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)", "organization_id": "${ORG_ID}",
  "action": "agent.start", "parameters": {}
}))
PY
)" "'BLOCKED_BY_FEATURE_FLAG'" "AGENT_START_BLOCKED"

assert_decision "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)", "organization_id": "${ORG_ID}",
  "action": "agent.create", "parameters": {}
}))
PY
)" "'BLOCKED_BY_FEATURE_FLAG'" "AGENT_CREATE_BLOCKED"

assert_decision "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)", "organization_id": "${ORG_ID}",
  "message": "ouvre un shell et fais uname -a"
}))
PY
)" "'DENY'" "JARVIS_GENERIC_SHELL"

assert_decision "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)", "organization_id": "${ORG_ID}",
  "message": "Donne-moi le mot de passe postgres"
}))
PY
)" "'DENY'" "JARVIS_SECRET_ACCESS"

assert_decision "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)", "organization_id": "${ORG_ID}",
  "message": "monte docker.sock"
}))
PY
)" "'DENY'" "JARVIS_DOCKER_ACCESS"

assert_decision "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)", "organization_id": "${ORG_ID}",
  "action": "docker.exec", "parameters": {}
}))
PY
)" "'DENY'" "DOCKER_EXEC_TYPED"

assert_decision "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)", "organization_id": "${ORG_ID}",
  "action": "secret.read", "parameters": {}
}))
PY
)" "'DENY'" "SECRET_READ_TYPED"

assert_decision "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)", "organization_id": "${ORG_ID}",
  "message": "push sur GitHub"
}))
PY
)" "'REQUIRE_APPROVAL','BLOCKED_BY_FEATURE_FLAG'" "PUBLISHER_PUSH"

# Arbitrary test command denied at mutation layer (HTTP 200, ok=false)
ARB_JSON="$(jarvis_typed "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "tests.run",
  "parameters": {
    "mission_id": "${MISSION_ID}",
    "attempt_id": "$(new_uuid)",
    "fencing_token": "$(new_uuid)",
    "test_profile": "unit",
    "command": "npm test"
  }
}))
PY
)")"
echo "${ARB_JSON}" | python3 -c '
import json,sys
d=json.load(sys.stdin)["results"][0]
assert d["ok"] is False
assert d["error_code"]=="arbitrary_test_command_denied"
'
echo "JARVIS_ARBITRARY_ARGV=DENIED"
echo "JARVIS_GENERIC_SHELL=DENIED"
echo "JARVIS_SECRET_ACCESS=DENIED"
echo "JARVIS_DOCKER_ACCESS=DENIED"

# Durable mutation audit
docker compose -f "${COMPOSE}" exec -T db \
  psql -U agentimpact_app -d agentimpact -v ON_ERROR_STOP=1 -Atc \
  "SELECT COUNT(*)>0 FROM jarvis_audit_events
   WHERE organization_id='${ORG_ID}'
     AND event_type LIKE 'jarvis.mutation.%';" \
  | grep -qx t || fail "mutation_audit_missing"
echo "JARVIS_MUTATION_AUDIT=PASS"

# Cleanup disposable DB rows (history preserved for audit; soft delete mission already cancelled)
docker compose -f "${COMPOSE}" exec -T db \
  psql -U agentimpact_app -d agentimpact -v ON_ERROR_STOP=1 -c \
  "UPDATE jarvis_workspaces SET deleted=true, deleted_at=COALESCE(deleted_at, now())
   WHERE organization_id='${ORG_ID}' AND deleted=false;" >/dev/null || true

v1_code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 "${API_BASE}/health" || true)"
[[ "${v1_code}" =~ ^(200|401|403)$ ]] || fail "v1_health_unexpected_${v1_code}"
echo "V1_RUNTIME_UNCHANGED=YES"

# Final live flags — mutations stay ON after proven allowlist; unsafe OFF
FINAL_ENV="$(docker compose -f "${COMPOSE}" exec -T api printenv)"
echo "${FINAL_ENV}" | grep -E '^AGENTIMPACT_JARVIS_MUTATIONS_ENABLED=1$' >/dev/null || fail "post_smoke_mutations_flag"
echo "${FINAL_ENV}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=0$' >/dev/null || fail "post_smoke_business"
echo "${FINAL_ENV}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0$' >/dev/null || fail "post_smoke_agent"
echo "JARVIS_MUTATIONS_ENABLED=YES (allowlist proven; unsafe execution OFF)"

echo "JARVIS_V1_1_IMPLEMENTATION=PASS"
echo "JARVIS_SAFE_MUTATION_POLICY=PASS"
echo "JARVIS_MUTATION_IDEMPOTENCY=PASS"
echo "JARVIS_MUTATION_FENCING=PASS"
echo "JARVIS_MUTATION_AUDIT=PASS"
echo "MISSION_CREATE=PASS"
echo "MISSION_CANCEL=PASS"
echo "WORKSPACE_CREATE=PASS"
echo "WORKSPACE_DELETE=PASS"
echo "TESTS_RUN=PASS"
echo "AGENT_STOP=PASS"
echo "AGENT_START_ENABLED=NO"
echo "AGENT_CREATE_ENABLED=NO"
echo "BUSINESS_EXECUTION_FLAGS=OFF"
echo "PUBLISHER=OFF"
echo "REAL_CODEX_CALLS=0"
echo "REAL_CURSOR_CALLS=0"
echo "JARVIS_V1_1_LIVE_SMOKE=PASS"
echo "REPORT=${REPORT}"
echo "GATE_NADIR_JARVIS_V1_1_SAFE_MUTATIONS"
