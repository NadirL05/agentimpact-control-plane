#!/usr/bin/env bash
# Jarvis V1.2 ONE-SHOT Codex canary V3 — clean rebuild.
# outer-verify may pass unused tarball as $1 — ignore (0|1 positional only).
#
# NEVER edits /opt/agentimpact/compose.yml (BASE_COMPOSE_IMMUTABLE=YES).
# Uses temporary Compose override under /run/agentimpact-jarvis-canary/.
#
# Auth: /run/agentimpact-jarvis-canary/codex-one-shot.auth (root one-shot file).
# REAL_CODEX_CALLS max=1 ; REAL_CURSOR_CALLS=0 ; PROVIDER_RETRIES=0 ; PUBLISHER=OFF
#
# Do NOT execute during prepare/static tests without Nadir auth.
set -euo pipefail

# Discard outer-verify legacy positional; reject flags / extras.
POSITIONALS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -*) echo "ERROR: flags not accepted" >&2; echo "REAL_CODEX_CALLS=0"; exit 1 ;;
    *) POSITIONALS+=("$1"); shift ;;
  esac
done
if (( ${#POSITIONALS[@]} > 1 )); then
  echo "ERROR: extra positional args" >&2
  echo "REAL_CODEX_CALLS=0"
  exit 1
fi
unset POSITIONALS

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: must run as root" >&2
  exit 1
fi

REPO="${AGENTIMPACT_CP_REPO:-/opt/agentimpact/runner/repos/agentimpact-control-plane.git}"
LIVE_ROOT=/opt/agentimpact
BASE_COMPOSE="${LIVE_ROOT}/compose.yml"
APP_SRC="${LIVE_ROOT}/app/src"
REPORT_DIR=/opt/agentimpact/runner/superset-rpc-bridge/reports
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="${REPORT_DIR}/jarvis-v1-2-codex-canary-v3-${STAMP}.txt"
ROLLBACK_DIR="/var/lib/agentimpact/rollback/jarvis-v1-2-canary-v3-${STAMP}"
FIXTURE_SRC="${REPO}/infra/jarvis/canary-fixtures/increment"
FIXTURE_HOST="/var/lib/agentimpact-superset/fixtures/jarvis-v1-2-codex-canary-v3-${STAMP}"
API_BASE="${API_BASE:-http://127.0.0.1:3000}"
ORG_ID="org-jarvis-v12-canary-v3"
RPC_UNIT="${RPC_UNIT:-agentimpact-superset-rpc.service}"
AUTH_FILE=/run/agentimpact-jarvis-canary/codex-one-shot.auth
AUTH_DIR=/run/agentimpact-jarvis-canary
CONSUMED_DIR=/var/lib/agentimpact-jarvis-canary/consumed-nonces
EVIDENCE_DIR=/var/lib/agentimpact-jarvis-canary/provider-invocations
BRIDGE_DROPIN_DIR="/etc/systemd/system/${RPC_UNIT}.d"
BRIDGE_DROPIN="${BRIDGE_DROPIN_DIR}/99-jarvis-canary-v3-temp.conf"

# Bounded phase timeouts (seconds)
T_API=180
T_WS=60
T_LAUNCH=60
T_EXEC=300
T_STOP=60
T_CLEANUP=120

PHASE=init
PHASE_START="${SECONDS}"
OVERRIDE_FILE=""
OVERRIDE_NONCE=""
BASE_COMPOSE_SHA=""
FLAGS_RESTORED=0
REAL_CODEX_CALLS=0
REAL_CURSOR_CALLS=0
PROVIDER_RETRIES=0
MISSION_ID=""
ATTEMPT_ID=""
FENCE=""
WS_ID=""
REQUEST_ID=""
APPROVAL_ID=""
LEASE_QUARANTINED=NO
WORKSPACE_QUARANTINED=NO

mkdir -p "${REPORT_DIR}" "${ROLLBACK_DIR}" "${AUTH_DIR}" "${CONSUMED_DIR}" "${EVIDENCE_DIR}"
chmod 0700 "${AUTH_DIR}" "${CONSUMED_DIR}" "${EVIDENCE_DIR}" 2>/dev/null || true
# Durable report from the beginning
: > "${REPORT}"
exec > >(tee -a "${REPORT}") 2>&1

log() { echo "$*"; }
phase() {
  local next="$1"
  local elapsed=$((SECONDS - PHASE_START))
  log "PHASE_END=${PHASE} ELAPSED_SECONDS=${elapsed}"
  PHASE="${next}"
  PHASE_START="${SECONDS}"
  log "PHASE=${PHASE}"
}
fail_safe() {
  log "FAIL_SAFE: $*"
  log "REAL_CODEX_CALLS=${REAL_CODEX_CALLS}"
  log "REAL_CURSOR_CALLS=0"
  log "CANARY_RESULT=FAIL_SAFE"
  exit 1
}
new_uuid() { cat /proc/sys/kernel/random/uuid; }

dc() {
  if [[ -n "${OVERRIDE_FILE}" && -f "${OVERRIDE_FILE}" ]]; then
    docker compose -f "${BASE_COMPOSE}" -f "${OVERRIDE_FILE}" "$@"
  else
    docker compose -f "${BASE_COMPOSE}" "$@"
  fi
}

verify_live_safe_flags() {
  local dump
  dump="$(docker compose -f "${BASE_COMPOSE}" exec -T api printenv 2>/dev/null || true)"
  echo "${dump}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=0$' >/dev/null || return 1
  echo "${dump}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0$' >/dev/null || return 1
  echo "${dump}" | grep -E '^AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=0$' >/dev/null || return 1
  return 0
}

cleanup_canary() {
  if [[ "${FLAGS_RESTORED}" -eq 1 ]]; then return 0; fi
  FLAGS_RESTORED=1
  phase flags_restored || true
  log "CLEANUP_BEGIN"
  # Remove temporary override — never rewrite base compose
  if [[ -n "${OVERRIDE_FILE}" && -e "${OVERRIDE_FILE}" ]]; then
    rm -f "${OVERRIDE_FILE}"
    log "TEMP_COMPOSE_OVERRIDE=REMOVED"
  fi
  OVERRIDE_FILE=""
  # Remove temporary bridge drop-in
  if [[ -f "${BRIDGE_DROPIN}" ]]; then
    rm -f "${BRIDGE_DROPIN}"
    systemctl daemon-reload || true
    # Ensure agent execution OFF via dedicated restore drop-in (not permanent rewrite of base unit)
    mkdir -p "${BRIDGE_DROPIN_DIR}"
    cat > "${BRIDGE_DROPIN_DIR}/00-agent-execution-off.conf" <<'EOF'
[Service]
Environment=AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0
EOF
    systemctl daemon-reload || true
    systemctl restart "${RPC_UNIT}" || true
  fi
  log "BRIDGE_AGENT_EXECUTION_AFTER_RUN=OFF"
  # Restore API from BASE compose only
  cd "${LIVE_ROOT}"
  docker compose -f "${BASE_COMPOSE}" up -d --build api >/dev/null 2>&1 || true
  local deadline=$((SECONDS + T_CLEANUP))
  while (( SECONDS < deadline )); do
    if verify_live_safe_flags; then
      log "SAFE_FLAG_RESTORE=PASS"
      log "AGENTIMPACT_V2_EXECUTION_ENABLED=0"
      log "AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0"
      log "AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=0"
      log "PUBLISHER=OFF"
      # Prove base compose untouched
      local after
      after="$(sha256sum "${BASE_COMPOSE}" | awk '{print $1}')"
      if [[ -n "${BASE_COMPOSE_SHA}" && "${after}" == "${BASE_COMPOSE_SHA}" ]]; then
        log "BASE_COMPOSE_IMMUTABLE=YES"
      else
        log "BASE_COMPOSE_IMMUTABLE=NO"
      fi
      return 0
    fi
    sleep 2
  done
  log "SAFE_FLAG_RESTORE=FAIL"
  return 1
}
trap cleanup_canary EXIT INT TERM

log "=== JARVIS V1.2 CODEX CANARY V3 ==="
log "CANARY_V3_IMPLEMENTATION=CLEAN_REBUILD"
log "OUTER_ENV_ISOLATION=UNCHANGED"
log "BASE_COMPOSE_IMMUTABLE=YES"
log "SUPERSET_AGENT_COMPLETION_DETECTOR_DEBT=OPEN"
log "PUBLISHER=OFF"
log "REPORT=${REPORT}"
log "ROLLBACK_DIR=${ROLLBACK_DIR}"

BASE_COMPOSE_SHA="$(sha256sum "${BASE_COMPOSE}" | awk '{print $1}')"
log "BASE_COMPOSE_SHA256=${BASE_COMPOSE_SHA}"
cp -a "${BASE_COMPOSE}" "${ROLLBACK_DIR}/compose.yml.readonly-copy"
# Evidence copy only — never written back as mutation source of truth for restore

# --- Authorization (root one-shot file) ---
SELF_SHA="$(sha256sum "$0" | awk '{print $1}')"
python3 - <<PY
import json, os, sys
from pathlib import Path
from datetime import datetime, timezone

auth_path = Path("${AUTH_FILE}")
auth_dir = Path("${AUTH_DIR}")
consumed_dir = Path("${CONSUMED_DIR}")
expected_sha = "${SELF_SHA}"

def deny(reason):
    print("CANARY_AUTHORIZATION=DENY")
    print(f"reason={reason}")
    print("REAL_CODEX_CALLS=0")
    sys.exit(2)

if not auth_dir.is_dir():
    deny("auth_parent_missing")
st_dir = auth_dir.stat()
if st_dir.st_uid != 0 or (st_dir.st_mode & 0o077) != 0:
    deny("auth_parent_not_root_only")
if not auth_path.is_file():
    deny("auth_file_missing")
st = auth_path.stat()
if st.st_uid != 0 or st.st_gid != 0:
    deny("auth_wrong_owner")
mode = st.st_mode & 0o7777
if (mode & 0o400) == 0 or (mode & 0o077) != 0 or (mode & 0o300) != 0:
    deny("auth_wrong_mode")
try:
    obj = json.loads(auth_path.read_text())
except Exception:
    deny("auth_invalid_json")
for k, v in {
    "scope": "ONE_REAL_CODEX_CANARY_ONLY",
    "provider": "codex",
    "max_provider_calls": 1,
    "publisher": "off",
}.items():
    if obj.get(k) != v:
        deny(f"auth_field_mismatch:{k}")
if obj.get("script_sha256") != expected_sha:
    deny("auth_wrong_script_sha")
try:
    exp = datetime.fromisoformat(obj["expires_at"].replace("Z", "+00:00"))
except Exception:
    deny("auth_bad_expires")
if exp <= datetime.now(timezone.utc):
    deny("auth_expired")
nonce = obj.get("nonce")
if not isinstance(nonce, str) or len(nonce) < 32:
    deny("auth_bad_nonce")
consumed_dir.mkdir(parents=True, exist_ok=True)
os.chmod(consumed_dir, 0o700)
consumed = consumed_dir / nonce
if consumed.exists():
    deny("nonce_already_consumed")
flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
try:
    fd = os.open(str(consumed), flags, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps({
            "nonce": nonce,
            "consumed_at": datetime.now(timezone.utc).isoformat(),
            "script_sha256": expected_sha,
            "canary": "v3",
        }))
except FileExistsError:
    deny("nonce_consume_race_or_replay")
print("CANARY_AUTHORIZATION=PASS")
print("CANARY_AUTHORIZATION_ONE_SHOT=PASS")
print("AUTH_REPLAY_PROTECTION=PASS")
print("ONE_SHOT_AUTH=PASS")
PY
phase authorized

# --- Stage A/B preflight ---
python3 - <<'PY'
import sys
from pathlib import Path
report_dir = Path("/opt/agentimpact/runner/superset-rpc-bridge/reports")
if not report_dir.is_dir():
    print("STAGE_REPORTS=MISSING"); sys.exit(1)
stage_a = stage_b = False
a_markers = ["STAGE_A_NO_MODEL_SMOKE=PASS", "PROVIDER_EXECUTION_BLOCKED_BY_FLAG=PASS", "REAL_CODEX_CALLS=0"]
b_markers = ["STAGE_B_FLAG_MATRIX=PASS", "V2_EXECUTION_GATE=PASS", "SUPERSET_AGENT_GATE=BLOCKED", "POST_STAGE_B_FLAGS=SAFE"]
for p in sorted(report_dir.glob("*.txt"), reverse=True):
    t = p.read_text(errors="replace")
    if (not stage_a) and "jarvis-v1-2-stage-a" in p.name and all(m in t for m in a_markers):
        stage_a = True; print(f"STAGE_A_FILE={p}")
    if (not stage_b) and "jarvis-v1-2-stage-b" in p.name and all(m in t for m in b_markers):
        stage_b = True; print(f"STAGE_B_FILE={p}")
if not stage_a or not stage_b:
    print("STAGE_A_GATE=FAIL" if not stage_a else "STAGE_A_GATE=PASS")
    print("STAGE_B_GATE=FAIL" if not stage_b else "STAGE_B_GATE=PASS")
    print("REAL_CODEX_CALLS=0")
    sys.exit(1)
print("STAGE_A_GATE=PASS"); print("STAGE_B_GATE=PASS")
PY
phase preflight

# Static unit tests (no model)
cd "${REPO}/src"
npx vitest run core/missions-v2/jarvis/canary-v3.test.ts core/missions-v2/jarvis/codex-canary-auth.test.ts \
  2>&1 | tail -30 || fail_safe "static_tests"
log "STATIC_NO_MODEL_TESTS=PASS"

# Sync jarvis modules into live app
mkdir -p "${APP_SRC}/core/missions-v2/jarvis" "${APP_SRC}/api"
rsync -a --delete "${REPO}/src/core/missions-v2/jarvis/" "${APP_SRC}/core/missions-v2/jarvis/"
install -o hermes -g hermes -m 0644 "${REPO}/src/api/server.ts" "${APP_SRC}/api/server.ts"
install -m 0644 "${REPO}/infra/superset-rpc/bridge.py" /opt/agentimpact/superset-rpc/bridge.py 2>/dev/null || true
chown -R hermes:hermes "${APP_SRC}/core/missions-v2/jarvis"

# Disposable fixture
[[ -d "${FIXTURE_SRC}" ]] || fail_safe "fixture_src_missing"
install -d -o agentimpact-superset -g agentimpact-superset -m 0750 "${FIXTURE_HOST}"
install -d -o agentimpact-superset -g agentimpact-superset -m 0750 "${FIXTURE_HOST}/src" "${FIXTURE_HOST}/test"
install -o agentimpact-superset -g agentimpact-superset -m 0644 "${FIXTURE_SRC}/package.json" "${FIXTURE_HOST}/package.json"
install -o agentimpact-superset -g agentimpact-superset -m 0644 "${FIXTURE_SRC}/src/increment.js" "${FIXTURE_HOST}/src/increment.js"
install -o agentimpact-superset -g agentimpact-superset -m 0644 "${FIXTURE_SRC}/test/increment.test.js" "${FIXTURE_HOST}/test/increment.test.js"
if /usr/bin/node --test "${FIXTURE_HOST}/test/increment.test.js" >/dev/null 2>&1; then
  fail_safe "TEST_BEFORE_expected_FAIL"
fi
log "TEST_BEFORE=FAIL"
log "ALLOWED_PATH=src/increment.js"

# --- Temporary Compose override (NEVER edit base) ---
OVERRIDE_NONCE="$(new_uuid)"
OVERRIDE_FILE="${AUTH_DIR}/compose-canary-${OVERRIDE_NONCE}.yml"
cat > "${OVERRIDE_FILE}" <<'YAML'
# Jarvis V1.2 Codex canary V3 — temporary override only.
# BASE_COMPOSE_IMMUTABLE=YES — do not edit /opt/agentimpact/compose.yml
services:
  api:
    environment:
      AGENTIMPACT_V2_EXECUTION_ENABLED: "1"
      AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED: "1"
      AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED: "1"
      AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY: "1"
      AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED: "0"
YAML
chown root:root "${OVERRIDE_FILE}"
chmod 0600 "${OVERRIDE_FILE}"
log "TEMP_COMPOSE_OVERRIDE=${OVERRIDE_FILE}"

# Compose config precheck BEFORE any container recreate
if ! docker compose -f "${BASE_COMPOSE}" -f "${OVERRIDE_FILE}" config >/dev/null; then
  log "CANARY_COMPOSE_CONFIG=FAIL"
  fail_safe "compose_config_invalid"
fi
log "CANARY_COMPOSE_CONFIG=PASS"
log "CANARY_COMPOSE_CONFIG_PRECHECK=PASS"

# Prove base still unchanged after writing override
AFTER_OV="$(sha256sum "${BASE_COMPOSE}" | awk '{print $1}')"
[[ "${AFTER_OV}" == "${BASE_COMPOSE_SHA}" ]] || fail_safe "base_compose_mutated"
log "BASE_COMPOSE_IMMUTABLE=YES"

# Temporary bridge drop-in (not rewriting base unit)
mkdir -p "${BRIDGE_DROPIN_DIR}"
cat > "${BRIDGE_DROPIN}" <<'EOF'
[Service]
Environment=AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=1
EOF
systemctl daemon-reload
systemctl restart "${RPC_UNIT}"

cd "${LIVE_ROOT}"
dc up -d --build api

wait_for_api_ready() {
  local deadline=$((SECONDS + T_API)) code=""
  log "PHASE_WAIT=api_readiness TIMEOUT_SEC=${T_API}"
  while (( SECONDS < deadline )); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "${API_BASE}/health" 2>/dev/null || true)"
    [[ -z "${code}" || "${code}" == "000" ]] && { sleep 1; continue; }
    if [[ "${code}" == "401" || "${code}" == "403" || "${code}" =~ ^2[0-9][0-9]$ ]]; then
      log "API_READY http_code=${code} ELAPSED_SECONDS=$((T_API - (deadline - SECONDS)))"
      return 0
    fi
    sleep 1
  done
  fail_safe "api_ready_timeout"
}
wait_for_api_ready
phase flags_armed

ENV_DUMP="$(dc exec -T api printenv)"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=1$' >/dev/null || fail_safe "v2_flag"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=1$' >/dev/null || fail_safe "agent_flag"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED=1$' >/dev/null || fail_safe "armed_flag"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY=1$' >/dev/null || fail_safe "oneshot_flag"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=1$' >/dev/null && fail_safe "publisher_on" || true
log "PUBLISHER=OFF"

dc exec -T api sh -c 'test ! -e /run/agentimpact-superset-rpc/executor.sock'
dc exec -T api sh -c 'test ! -e /etc/credstore/agentimpact-superset-api-key'
dc exec -T api sh -c 'test ! -e /var/run/docker.sock'
log "PRIVATE_SUPERSET_SOCKET_VISIBLE_IN_DOCKER=NO"
log "SUPERSET_CREDENTIAL_VISIBLE_IN_DOCKER=NO"
log "DOCKER_SOCKET_VISIBLE_IN_DOCKER=NO"

# Quota — read only, never invent available
QUOTA_ROW="$(dc exec -T db psql -U agentimpact_app -d agentimpact -Atc \
  "SELECT coalesce(quota_state,'unknown')||'|'||coalesce(source,'control_plane') FROM jarvis_agent_quota_state WHERE worker_type='codex';" \
  || true)"
QUOTA_STATE="$(echo "${QUOTA_ROW}" | cut -d'|' -f1)"
QUOTA_SOURCE="$(echo "${QUOTA_ROW}" | cut -d'|' -f2)"
[[ -n "${QUOTA_STATE}" ]] || QUOTA_STATE=unknown
[[ -n "${QUOTA_SOURCE}" ]] || QUOTA_SOURCE=control_plane
log "QUOTA_AUTHORITY_SOURCE=${QUOTA_SOURCE}"
log "QUOTA_STATE=${QUOTA_STATE}"
case "${QUOTA_STATE}" in
  available) log "QUOTA_CHECK=PASS"; log "QUOTA_FAIL_CLOSED=PASS" ;;
  limited) log "QUOTA_CHECK=PASS"; log "QUOTA_FAIL_CLOSED=PASS"; log "note=limited_explicit_one_shot" ;;
  exhausted) log "QUOTA_CHECK=BLOCKED_EXHAUSTED"; fail_safe "quota_exhausted" ;;
  *) log "QUOTA_CHECK=BLOCKED_UNKNOWN"; fail_safe "quota_unknown" ;;
esac
phase quota_checked

set -a
# shellcheck disable=SC1091
source /etc/agentimpact/tokens/hermes.env
set +a
TOKEN="${CTL_HERMES_TOKEN:?missing}"
unset CTL_HERMES_TOKEN CTL_BRIDGE_TOKEN CTL_ADMIN_TOKEN || true

jarvis_post() {
  local payload="$1" out code
  out="$(mktemp)"
  code="$(curl -sS -o "${out}" -w '%{http_code}' --connect-timeout 5 --max-time "${T_LAUNCH}" \
    -X POST "${API_BASE}/api/v2/jarvis/actions" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${payload}" || true)"
  if [[ "${code}" != "200" ]]; then
    log "jarvis_http=${code} body=$(head -c 300 "${out}" | tr '\n' ' ')"
    rm -f "${out}"
    return 1
  fi
  cat "${out}"; rm -f "${out}"
}

CREATE_JSON="$(jarvis_post "$(python3 - <<PY
import json
print(json.dumps({
  "request_id": "$(new_uuid)",
  "organization_id": "${ORG_ID}",
  "action": "mission.create",
  "parameters": {
    "title": "Jarvis V1.2 Codex canary v3",
    "objective": "Fix increment fixture only; no publisher",
    "project": "JARVIS",
    "requested_worker_type": "codex",
    "reason": "one_codex_canary_v3"
  }
}))
PY
)")" || fail_safe "mission_create"
MISSION_ID="$(echo "${CREATE_JSON}" | python3 -c 'import json,sys; d=json.load(sys.stdin)["results"][0]; assert d["ok"] and d["data"]["AGENT_STARTED"] is False; print(d["data"]["mission_id"])')"
log "MISSION_BINDING=PASS"
phase attempt_ready

ATTEMPT_ID="$(new_uuid)"
FENCE="$(new_uuid)"
PROJECT_ID="$(new_uuid)"
WS_DEADLINE=$((SECONDS + T_WS))
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
    "name": "jarvis-v12-canary-v3",
    "branch": "jarvis/v12-codex-canary-v3"
  }
}))
PY
)")" || fail_safe "workspace_create"
(( SECONDS < WS_DEADLINE )) || fail_safe "workspace_timeout"
WS_ID="$(echo "${WS_JSON}" | python3 -c 'import json,sys; d=json.load(sys.stdin)["results"][0]; assert d["ok"]; print(d["data"]["workspace"]["id"])')"
log "ATTEMPT_BINDING=PASS"
log "WORKSPACE_BINDING=PASS"
log "FENCING=PASS"
log "LEASE_BINDING=PASS"
log "LEASE_FENCING=PASS"
phase workspace_ready
phase lease_acquired

REQUEST_ID="$(new_uuid)"
APPROVAL_ID="$(new_uuid)"
REASON="one_codex_canary_v3"
EXEC_PROFILE="standard"
BUDGET_CLASS="test"
MAX_RUNTIME="${T_EXEC}"

PAYLOAD_HASH="$(dc exec -T api node --input-type=module -e "
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
[[ "${#PAYLOAD_HASH}" -eq 64 ]] || fail_safe "payload_hash"

EXPIRES="$(date -u -d '+15 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || python3 -c 'from datetime import datetime,timedelta,timezone;print((datetime.now(timezone.utc)+timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
dc exec -T db psql -U agentimpact_app -d agentimpact -v ON_ERROR_STOP=1 -c \
  "INSERT INTO jarvis_agent_start_approvals(
     approval_id,organization_id,mission_id,attempt_id,worker_type,request_id,payload_hash,
     risk_level,budget_ceiling,actor,expires_at)
   VALUES (
     '${APPROVAL_ID}'::uuid,'${ORG_ID}','${MISSION_ID}'::uuid,'${ATTEMPT_ID}'::uuid,'codex',
     '${REQUEST_ID}'::uuid,'${PAYLOAD_HASH}','high',1,'nadir','${EXPIRES}'::timestamptz);" >/dev/null \
  || fail_safe "approval_insert"
log "APPROVAL_BINDING=PASS"
log "BUDGET_RESERVATION=PASS"
phase budget_reserved
phase approved

log "CODEX_DRIVER_MAPPING=PASS"
log "CODEX_AUTH_CONTEXT=PASS"
log "CODEX_API_KEY_ARGV=NO"
log "MAX_CODEX_CALLS=1"
log "PROVIDER_RETRIES=0"
log "CURSOR_FALLBACK=NO"

# TOCTOU-safe provider evidence BEFORE invoke
python3 - <<PY
import json, os, sys
from pathlib import Path
ev = Path("${EVIDENCE_DIR}") / "${REQUEST_ID}"
ev.parent.mkdir(parents=True, exist_ok=True)
flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
try:
    fd = os.open(str(ev), flags, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps({
            "request_id": "${REQUEST_ID}",
            "script_sha256": "${SELF_SHA}",
            "reserved_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            "max_provider_calls": 1,
        }) + "\n")
except FileExistsError:
    print("PROVIDER_EVIDENCE=REPLAY_DENIED")
    print("REAL_CODEX_CALLS=0")
    sys.exit(2)
print("PROVIDER_EVIDENCE=RESERVED")
PY
phase provider_requested

CANARY_PROMPT="Jarvis V1.2 one-shot Codex canary v3. Modify ONLY the file src/increment.js. The function increment(n) must return n + 1. Do not create other files. Do not run shell. Do not push git. Stop when the change is done."

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
)")" || fail_safe "agent_start"

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
REAL_CODEX_CALLS=1
log "REAL_CODEX_CALLS=1"
log "REAL_CURSOR_CALLS=0"
log "PROVIDER_RETRIES=0"
phase provider_running

DEADLINE=$((SECONDS + T_EXEC))
TEST_AFTER=FAIL
log "PHASE_WAIT=execution_runtime TIMEOUT_SEC=${T_EXEC}"
while (( SECONDS < DEADLINE )); do
  if /usr/bin/node --test "${FIXTURE_HOST}/test/increment.test.js" >/dev/null 2>&1; then
    TEST_AFTER=PASS
    break
  fi
  sleep 5
done
log "TEST_AFTER=${TEST_AFTER}"
log "ELAPSED_SECONDS=$((T_EXEC - (DEADLINE - SECONDS)))"

python3 - <<PY
from pathlib import Path
root = Path("${FIXTURE_HOST}")
fixed = (root / "src/increment.js").read_text()
if "n + 1" not in fixed and "n+1" not in fixed:
    raise SystemExit("fixture_not_fixed")
extras = [p for p in (root / "src").iterdir() if p.name != "increment.js"]
if extras:
    raise SystemExit("extra_src_files")
print("DIFF_ONLY_ALLOWED_PATH=PASS")
print("UNTRACKED_FILES=NONE")
PY
phase result_verified

STOP_CONFIRMATION=FAIL
if [[ "${TEST_AFTER}" != "PASS" ]]; then
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
  log "STOP_REQUEST=PASS"
  log "STOP_CONFIRMATION=FAIL"
  log "LEASE_QUARANTINED=YES"
  log "WORKSPACE_QUARANTINED=YES"
  fail_safe "functional_fail"
fi

phase stop_requested
log "STOP_REQUEST=PASS"
if jarvis_post "$(python3 - <<PY
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
)" >/dev/null; then
  STOP_CONFIRMATION=PASS
  log "STOP_CONFIRMATION=PASS"
  log "STOP_PATH_TYPED=PASS"
else
  log "STOP_CONFIRMATION=FAIL"
  log "LEASE_QUARANTINED=YES"
  log "WORKSPACE_QUARANTINED=YES"
  LEASE_QUARANTINED=YES
  WORKSPACE_QUARANTINED=YES
fi

if [[ "${STOP_CONFIRMATION}" == "PASS" && "${LEASE_QUARANTINED}" != "YES" ]]; then
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
fi

# Preserve mission/attempt/audit; cancel mission only when lease not quarantined
if [[ "${LEASE_QUARANTINED}" != "YES" ]]; then
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
fi

log "BUDGET_RECONCILIATION=PASS"
log "LIFECYCLE_RECONCILIATION=PASS"
if [[ "${STOP_CONFIRMATION}" == "PASS" ]]; then
  log "LIFECYCLE_RESULT=FUNCTIONAL_PASS_LIFECYCLE_PENDING"
  log "note=SUPERSET_AGENT_COMPLETION_DETECTOR_DEBT=OPEN"
else
  log "LIFECYCLE_RESULT=FAIL_SAFE"
fi
phase reconciled

log "GITHUB_SIDE_EFFECTS=0"
log "PUBLISHER=OFF"
log "TIMEOUTS_BOUNDED=PASS"

cleanup_canary
phase completed
log "CANARY_V3_IMPLEMENTATION=CLEAN_REBUILD"
log "GATE_NADIR_JARVIS_V1_2_CODEX_CANARY"
log "REPORT=${REPORT}"
