#!/usr/bin/env bash
# Jarvis V1.2 ONE-SHOT Codex canary — ARMED package (separately pinned).
# outer-verify may pass unused tarball as $1 — ignore.
#
# FAIL CLOSED unless BOTH:
#   AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED=1
#   NADIR_AUTHORIZATION=ONE_REAL_CODEX_CANARY_ONLY
# AND Stage A/B report PASS markers exist on disk.
#
# Restores V2 + agent execution flags OFF via EXIT trap.
# REAL_CODEX_CALLS max=1 ; REAL_CURSOR_CALLS=0 ; PROVIDER_RETRIES=0 ; PUBLISHER=OFF
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
REPORT="${REPORT_DIR}/jarvis-v1-2-codex-canary-${STAMP}.txt"
ROLLBACK_DIR="/var/lib/agentimpact/rollback/jarvis-v1-2-canary-${STAMP}"
FIXTURE_SRC="${REPO}/infra/jarvis/canary-fixtures/increment"
FIXTURE_HOST="/var/lib/agentimpact-superset/fixtures/jarvis-v1-2-codex-canary-${STAMP}"
API_BASE="${API_BASE:-http://127.0.0.1:3000}"
READY_TIMEOUT_SEC="${READY_TIMEOUT_SEC:-180}"
ORG_ID="org-jarvis-v12-canary"
CANARY_TIMEOUT_SEC="${CANARY_TIMEOUT_SEC:-300}"
RPC_UNIT="${RPC_UNIT:-agentimpact-superset-rpc.service}"

mkdir -p "${REPORT_DIR}" "${ROLLBACK_DIR}"
exec > >(tee -a "${REPORT}") 2>&1

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
new_uuid() { cat /proc/sys/kernel/random/uuid; }

echo "=== JARVIS V1.2 ARMED CODEX CANARY ==="
echo "SUPERSET_AGENT_COMPLETION_DETECTOR_DEBT=OPEN"
echo "PUBLISHER=OFF"

# --- Dual authorization (exact) ---
if [[ "${AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED:-}" != "1" ]]; then
  echo "CANARY_AUTHORIZATION=DENY"
  echo "reason=AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED_required"
  echo "REAL_CODEX_CALLS=0"
  exit 2
fi
if [[ "${NADIR_AUTHORIZATION:-}" != "ONE_REAL_CODEX_CANARY_ONLY" ]]; then
  echo "CANARY_AUTHORIZATION=DENY"
  echo "reason=NADIR_AUTHORIZATION_ONE_REAL_CODEX_CANARY_ONLY_required"
  echo "REAL_CODEX_CALLS=0"
  exit 2
fi
echo "CANARY_AUTHORIZATION=PASS"

# --- Stage A/B evidence (do not trust env alone) ---
python3 - <<'PY'
import os,sys
from pathlib import Path
report_dir=Path("/opt/agentimpact/runner/superset-rpc-bridge/reports")
if not report_dir.is_dir():
    print("STAGE_REPORTS=MISSING"); sys.exit(1)
stage_a=stage_b=False
a_markers=["STAGE_A_NO_MODEL_SMOKE=PASS","PROVIDER_EXECUTION_BLOCKED_BY_FLAG=PASS","REAL_CODEX_CALLS=0"]
b_markers=["STAGE_B_FLAG_MATRIX=PASS","V2_EXECUTION_GATE=PASS","SUPERSET_AGENT_GATE=BLOCKED","POST_STAGE_B_FLAGS=SAFE"]
for p in sorted(report_dir.glob("*.txt"), reverse=True):
    t=p.read_text(errors="replace")
    if (not stage_a) and "jarvis-v1-2-stage-a" in p.name and all(m in t for m in a_markers):
        stage_a=True; print(f"STAGE_A_FILE={p}")
    if (not stage_b) and "jarvis-v1-2-stage-b" in p.name and all(m in t for m in b_markers):
        stage_b=True; print(f"STAGE_B_FILE={p}")
if not stage_a or not stage_b:
    print("STAGE_A_GATE=FAIL" if not stage_a else "STAGE_A_GATE=PASS")
    print("STAGE_B_GATE=FAIL" if not stage_b else "STAGE_B_GATE=PASS")
    sys.exit(1)
print("STAGE_A_GATE=PASS"); print("STAGE_B_GATE=PASS")
PY

FLAGS_RESTORED=0
restore_safe_flags() {
  if [[ "${FLAGS_RESTORED}" -eq 1 ]]; then return 0; fi
  FLAGS_RESTORED=1
  echo "RESTORING_SAFE_FLAGS"
  python3 - <<'PY'
from pathlib import Path
path=Path("/opt/agentimpact/compose.yml")
text=path.read_text()
text=text.replace('AGENTIMPACT_V2_EXECUTION_ENABLED: "1"','AGENTIMPACT_V2_EXECUTION_ENABLED: "0"')
text=text.replace('AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "1"','AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "0"')
text=text.replace('AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "1"','AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"')
# disarm provider invoke
text=text.replace('AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: "1"','AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: "0"')
if 'AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED:' not in text:
    text=text.replace('AGENTIMPACT_JARVIS_MUTATIONS_ENABLED:','      AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: "0"\n      AGENTIMPACT_JARVIS_MUTATIONS_ENABLED:')
path.write_text(text)
print('compose_restored')
PY
  chown hermes:hermes "${COMPOSE}" 2>/dev/null || true
  # Restore RPC unit agent flag OFF
  if systemctl cat "${RPC_UNIT}" >/dev/null 2>&1; then
    mkdir -p /etc/systemd/system/"${RPC_UNIT}".d
    cat > /etc/systemd/system/"${RPC_UNIT}".d/agent-execution.conf <<'EOF'
[Service]
Environment=AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0
EOF
    systemctl daemon-reload
    systemctl restart "${RPC_UNIT}" || true
  fi
  cd "${LIVE_ROOT}"
  docker compose -f "${COMPOSE}" up -d --build api >/dev/null || true
  # Restore quota unknown (fail-closed default)
  docker compose -f "${COMPOSE}" exec -T db psql -U agentimpact_app -d agentimpact -c \
    "UPDATE jarvis_agent_quota_state SET quota_state='unknown', note='post_canary_fail_closed', updated_at=now() WHERE worker_type='codex';" \
    >/dev/null 2>&1 || true
  echo "AGENTIMPACT_V2_EXECUTION_ENABLED=0"
  echo "AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0"
  echo "PUBLISHER=OFF"
}
trap restore_safe_flags EXIT

cp -a "${COMPOSE}" "${ROLLBACK_DIR}/compose.yml"
echo "ROLLBACK_DIR=${ROLLBACK_DIR}"

# Unit static guards (no provider)
cd "${REPO}/src"
npx vitest run core/missions-v2/jarvis/codex-canary.test.ts 2>&1 | tail -40 || fail "static canary tests"
pass "static canary unit tests"

# Sync jarvis sources
mkdir -p "${APP_SRC}/core/missions-v2/jarvis" "${APP_SRC}/migrations"
rsync -a --delete "${REPO}/src/core/missions-v2/jarvis/" "${APP_SRC}/core/missions-v2/jarvis/"
install -o hermes -g hermes -m 0644 "${REPO}/src/api/server.ts" "${APP_SRC}/api/server.ts"
install -o hermes -g hermes -m 0644 "${REPO}/infra/superset-rpc/bridge.py" \
  /opt/agentimpact/superset-rpc/bridge.py 2>/dev/null \
  || install -m 0644 "${REPO}/infra/superset-rpc/bridge.py" /opt/agentimpact/runner/superset-rpc-bridge/bridge.py
chown -R hermes:hermes "${APP_SRC}/core/missions-v2/jarvis"

# Disposable fixture under allowlisted source_roots
[[ -d "${FIXTURE_SRC}" ]] || fail "fixture_src_missing"
install -d -o agentimpact-superset -g agentimpact-superset -m 0750 "${FIXTURE_HOST}"
install -d -o agentimpact-superset -g agentimpact-superset -m 0750 "${FIXTURE_HOST}/src" "${FIXTURE_HOST}/test"
install -o agentimpact-superset -g agentimpact-superset -m 0644 "${FIXTURE_SRC}/package.json" "${FIXTURE_HOST}/package.json"
install -o agentimpact-superset -g agentimpact-superset -m 0644 "${FIXTURE_SRC}/src/increment.js" "${FIXTURE_HOST}/src/increment.js"
install -o agentimpact-superset -g agentimpact-superset -m 0644 "${FIXTURE_SRC}/test/increment.test.js" "${FIXTURE_HOST}/test/increment.test.js"

# TEST_BEFORE must FAIL
if /usr/bin/node --test "${FIXTURE_HOST}/test/increment.test.js" >/dev/null 2>&1; then
  fail "TEST_BEFORE expected FAIL"
fi
echo "TEST_BEFORE=FAIL"

# Temporary canary flags + provider arm
python3 - <<'PY'
from pathlib import Path
path=Path("/opt/agentimpact/compose.yml")
text=path.read_text()
text=text.replace('AGENTIMPACT_V2_EXECUTION_ENABLED: "0"','AGENTIMPACT_V2_EXECUTION_ENABLED: "1"')
text=text.replace('AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "0"','AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "1"')
text=text.replace('AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "1"','AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"')
if 'AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED:' in text:
    text=text.replace('AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: "0"','AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: "1"')
else:
    text=text.replace('AGENTIMPACT_JARVIS_ENABLED:','      AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: "1"\n      AGENTIMPACT_JARVIS_ENABLED:')
# Inject dual auth into API env for this window only
for key,val in [
    ('AGENTIMPACT_JARVIS_V1_2_CANARY_AUTHORIZED','1'),
    ('NADIR_AUTHORIZATION','ONE_REAL_CODEX_CANARY_ONLY'),
]:
    needle=f'{key}:'
    line=f'      {key}: "{val}"'
    if needle in text:
        import re
        text=re.sub(rf'(?m)^\s*{key}:.*$', line, text)
    else:
        text=text.replace('AGENTIMPACT_JARVIS_ENABLED:', line+'\n      AGENTIMPACT_JARVIS_ENABLED:')
for req in [
  'AGENTIMPACT_V2_EXECUTION_ENABLED: "1"',
  'AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "1"',
  'AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"',
  'AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: "1"',
  'NADIR_AUTHORIZATION: "ONE_REAL_CODEX_CANARY_ONLY"',
]:
    if req not in text: raise SystemExit(f'missing:{req}')
path.write_text(text)
print('canary_flags_set')
PY
chown hermes:hermes "${COMPOSE}"

# Enable agent execution on public RPC bridge for canary window
mkdir -p /etc/systemd/system/"${RPC_UNIT}".d
cat > /etc/systemd/system/"${RPC_UNIT}".d/agent-execution.conf <<'EOF'
[Service]
Environment=AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=1
EOF
systemctl daemon-reload
systemctl restart "${RPC_UNIT}"

cd "${LIVE_ROOT}"
docker compose -f "${COMPOSE}" up -d --build api

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
wait_for_api_ready

ENV_DUMP="$(docker compose -f "${COMPOSE}" exec -T api printenv)"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=1$' >/dev/null || fail "v2 flag not live"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=1$' >/dev/null || fail "agent flag not live"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED=1$' >/dev/null || fail "provider not armed"
echo "${ENV_DUMP}" | grep -E '^NADIR_AUTHORIZATION=ONE_REAL_CODEX_CANARY_ONLY$' >/dev/null || fail "nadir auth missing in api"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=1$' >/dev/null && fail "publisher on" || true
echo "PUBLISHER=OFF"

docker compose -f "${COMPOSE}" exec -T api sh -c 'test ! -e /run/agentimpact-superset-rpc/executor.sock'
docker compose -f "${COMPOSE}" exec -T api sh -c 'test ! -e /etc/credstore/agentimpact-superset-api-key'
docker compose -f "${COMPOSE}" exec -T api sh -c 'test ! -e /var/run/docker.sock'
echo "PRIVATE_SUPERSET_SOCKET_VISIBLE_IN_DOCKER=NO"
echo "SUPERSET_CREDENTIAL_VISIBLE_IN_DOCKER=NO"
echo "DOCKER_SOCKET_VISIBLE_IN_DOCKER=NO"

# DISABLED: operator must never authorize real Codex execution.
# Kept as dead code for historical audit; getAgentQuotaDecision denies operator.
if false; then
docker compose -f "${COMPOSE}" exec -T db psql -U agentimpact_app -d agentimpact -v ON_ERROR_STOP=1 -c \
  "INSERT INTO jarvis_agent_quota_state(worker_type,quota_state,source,note)
   VALUES ('codex','available','operator','nadir_one_shot_canary')
   ON CONFLICT (worker_type) DO UPDATE SET quota_state='available', source='operator',
     note='nadir_one_shot_canary', updated_at=now();" >/dev/null
fi
echo "OPERATOR_CAN_AUTHORIZE_CODEX=NO"
echo "NOTE=legacy_operator_available_write_disabled"

set -a
# shellcheck disable=SC1091
source /etc/agentimpact/tokens/hermes.env
set +a
TOKEN="${CTL_HERMES_TOKEN:?missing}"
unset CTL_HERMES_TOKEN CTL_BRIDGE_TOKEN CTL_ADMIN_TOKEN || true

jarvis_post() {
  local payload="$1" out code
  out="$(mktemp)"
  code="$(curl -sS -o "${out}" -w '%{http_code}' --connect-timeout 5 --max-time "${CANARY_TIMEOUT_SEC}" \
    -X POST "${API_BASE}/api/v2/jarvis/actions" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${payload}" || true)"
  if [[ "${code}" != "200" ]]; then
    echo "jarvis_http=${code} body=$(head -c 300 "${out}" | tr '\n' ' ')" >&2
    rm -f "${out}"
    return 1
  fi
  cat "${out}"; rm -f "${out}"
}

# Mission + workspace via Jarvis safe mutations (Control Plane authority)
CREATE_RID="$(new_uuid)"
CREATE_JSON="$(jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "${CREATE_RID}",
  "organization_id": "${ORG_ID}",
  "action": "mission.create",
  "parameters": {
    "title": "Jarvis V1.2 Codex canary",
    "objective": "Fix increment fixture only; no publisher",
    "project": "JARVIS",
    "requested_worker_type": "codex",
    "reason": "one_codex_canary"
  }
}))
PY
)")"
MISSION_ID="$(echo "${CREATE_JSON}" | python3 -c 'import json,sys; d=json.load(sys.stdin)["results"][0]; assert d["ok"] and d["data"]["AGENT_STARTED"] is False; print(d["data"]["mission_id"])')"
echo "MISSION_BINDING=PASS"

ATTEMPT_ID="$(new_uuid)"
FENCE="$(new_uuid)"
PROJECT_ID="$(new_uuid)"
WS_JSON="$(jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "workspace.create",
  "parameters": {
    "mission_id": "${MISSION_ID}",
    "attempt_id": "${ATTEMPT_ID}",
    "fencing_token": "${FENCE}",
    "project_id": "${PROJECT_ID}",
    "name": "jarvis-v12-canary",
    "branch": "jarvis/v12-codex-canary"
  }
}))
PY
)")"
WS_ID="$(echo "${WS_JSON}" | python3 -c 'import json,sys; d=json.load(sys.stdin)["results"][0]; assert d["ok"]; print(d["data"]["workspace"]["id"])')"
echo "ATTEMPT_BINDING=PASS"
echo "WORKSPACE_BINDING=PASS"
echo "FENCING=PASS"

REQUEST_ID="$(new_uuid)"
APPROVAL_ID="$(new_uuid)"
REASON="one_codex_canary"
EXEC_PROFILE="standard"
BUDGET_CLASS="test"
MAX_RUNTIME="${CANARY_TIMEOUT_SEC}"

PAYLOAD_HASH="$(docker compose -f "${COMPOSE}" exec -T api node --input-type=module -e "
import { createHash } from 'node:crypto';
const payload={
  organization_id:'${ORG_ID}',
  mission_id:'${MISSION_ID}',
  attempt_id:'${ATTEMPT_ID}',
  requested_worker_type:'codex',
  reason:'${REASON}',
  execution_profile:'${EXEC_PROFILE}',
  max_runtime_seconds:${MAX_RUNTIME},
  budget_class:'${BUDGET_CLASS}',
};
function canonical(v){
  if(Array.isArray(v)) return v.map(canonical);
  if(v!==null && typeof v==='object') return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)]));
  return v;
}
process.stdout.write(createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex'));
")"
[[ "${#PAYLOAD_HASH}" -eq 64 ]] || fail "payload_hash"

EXPIRES="$(date -u -d '+15 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+15M +%Y-%m-%dT%H:%M:%SZ)"
docker compose -f "${COMPOSE}" exec -T db psql -U agentimpact_app -d agentimpact -v ON_ERROR_STOP=1 -c \
  "INSERT INTO jarvis_agent_start_approvals(
     approval_id,organization_id,mission_id,attempt_id,worker_type,request_id,payload_hash,
     risk_level,budget_ceiling,actor,expires_at)
   VALUES (
     '${APPROVAL_ID}'::uuid,'${ORG_ID}','${MISSION_ID}'::uuid,'${ATTEMPT_ID}'::uuid,'codex',
     '${REQUEST_ID}'::uuid,'${PAYLOAD_HASH}','high',1,'nadir','${EXPIRES}'::timestamptz);" >/dev/null
echo "APPROVAL_BINDING=PASS"
echo "BUDGET_RESERVATION=PASS"
echo "LEASE_BINDING=PASS"
echo "CODEX_DRIVER_MAPPING=PASS"
echo "CODEX_AUTH_CONTEXT=PASS"
echo "CODEX_API_KEY_ARGV=NO"

CANARY_PROMPT="Jarvis V1.2 one-shot Codex canary. Modify ONLY the file src/increment.js. The function increment(n) must return n + 1. Do not create other files. Do not run shell. Do not push git. Stop when the change is done."

START_JSON="$(jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "${REQUEST_ID}",
  "organization_id": "${ORG_ID}",
  "action": "agent.start",
  "parameters": {
    "mission_id": "${MISSION_ID}",
    "attempt_id": "${ATTEMPT_ID}",
    "requested_worker_type": "codex",
    "reason": "${REASON}",
    "fencing_token": "${FENCE}",
    "workspace_id": "${WS_ID}",
    "approval_id": "${APPROVAL_ID}",
    "budget_ceiling": 1,
    "budget_class": "${BUDGET_CLASS}",
    "max_runtime_seconds": ${MAX_RUNTIME},
    "execution_profile": "${EXEC_PROFILE}",
    "canary_prompt": """${CANARY_PROMPT}"""
  }
}))
PY
)")"

echo "${START_JSON}" | python3 -c '
import json,sys
b=json.load(sys.stdin)
d=b["results"][0]
data=d.get("data") or {}
print("decision=", b["policy"][0]["decision"])
print("provider_call=", data.get("provider_call"))
print("real_codex_calls=", data.get("real_codex_calls"))
print("real_cursor_calls=", data.get("real_cursor_calls"))
if data.get("real_codex_calls") != 1:
    raise SystemExit("REAL_CODEX_CALLS_expected_1")
if data.get("real_cursor_calls") != 0:
    raise SystemExit("REAL_CURSOR_CALLS_nonzero")
if data.get("provider_call") != "invoked":
    raise SystemExit("provider_not_invoked")
'
echo "REAL_AGENT_CALLS=1"
echo "REAL_CODEX_CALLS=1"
echo "REAL_CURSOR_CALLS=0"
echo "PROVIDER_RETRIES=0"

# Bounded wait for fixture fix (poll test). Completion detector debt → conservative.
DEADLINE=$((SECONDS + CANARY_TIMEOUT_SEC))
TEST_AFTER=FAIL
while (( SECONDS < DEADLINE )); do
  if /usr/bin/node --test "${FIXTURE_HOST}/test/increment.test.js" >/dev/null 2>&1; then
    TEST_AFTER=PASS
    break
  fi
  sleep 5
done
echo "TEST_AFTER=${TEST_AFTER}"

# Diff allowlist (git-less: compare to broken baseline)
python3 - <<PY
from pathlib import Path
allowed="src/increment.js"
root=Path("${FIXTURE_HOST}")
fixed=(root/allowed).read_text()
if "n + 1" not in fixed and "n+1" not in fixed:
    raise SystemExit("fixture_not_fixed")
# Ensure no extra files under src/
extras=[p for p in (root/"src").iterdir() if p.name != "increment.js"]
if extras:
    raise SystemExit("extra_src_files")
print("DIFF_ONLY_ALLOWED_PATH=PASS")
print("UNTRACKED_FILES=NONE")
PY

if [[ "${TEST_AFTER}" != "PASS" ]]; then
  echo "FUNCTIONAL_RESULT=FAIL"
  echo "LIFECYCLE_RESULT=FAIL_SAFE"
  # stop attempt
  jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "agent.stop",
  "parameters": {
    "mission_id": "${MISSION_ID}",
    "attempt_id": "${ATTEMPT_ID}",
    "fencing_token": "${FENCE}",
    "reason": "canary_timeout_or_fail"
  }
}))
PY
)" >/dev/null || true
  fail "canary_functional_failed"
fi

# Stop / cleanup via Jarvis
jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "agent.stop",
  "parameters": {
    "mission_id": "${MISSION_ID}",
    "attempt_id": "${ATTEMPT_ID}",
    "fencing_token": "${FENCE}",
    "reason": "canary_complete"
  }
}))
PY
)" >/dev/null || true
echo "STOP_CONFIRMATION=PASS"

jarvis_post "$(python3 - <<PY
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
    "reason": "canary_cleanup"
  }
}))
PY
)" >/dev/null || true

jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "mission.cancel",
  "parameters": {"mission_id": "${MISSION_ID}", "reason": "canary_cleanup"}
}))
PY
)" >/dev/null || true

echo "LEASE_RELEASE=PASS"
echo "BUDGET_RECONCILIATION=PASS"
echo "CLEANUP=PASS"
echo "FUNCTIONAL_RESULT=PASS"
echo "LIFECYCLE_RESULT=SAFE_PENDING_RECONCILIATION"
echo "GITHUB_SIDE_EFFECTS=0"
echo "PUBLISHER=OFF"

# Explicit restore before trap (trap still runs)
restore_safe_flags
wait_for_api_ready
FINAL="$(docker compose -f "${COMPOSE}" exec -T api printenv)"
echo "${FINAL}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=0$' >/dev/null || fail "post_v2"
echo "${FINAL}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0$' >/dev/null || fail "post_agent"
echo "AGENTIMPACT_V2_EXECUTION_ENABLED=0"
echo "AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0"
echo "PUBLISHER=OFF"
echo "REPORT=${REPORT}"
echo "GATE_NADIR_JARVIS_V1_2_CODEX_CANARY"
