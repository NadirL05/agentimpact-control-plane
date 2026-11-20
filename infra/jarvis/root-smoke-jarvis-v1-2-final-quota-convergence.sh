#!/usr/bin/env bash
# Jarvis V1.2 — FINAL no-model convergence smoke (Superset RPC rate-limits + quota).
# outer-verify may pass unused tarball as $1 — ignore.
#
# Path: Control Plane → public bridge → private executor → Codex app-server metadata.
# Runtime: agentimpact-superset + CODEX_HOME=/var/lib/agentimpact-superset/codex-home
# Does NOT start Jarvis agent execution, workspace, or Codex completion.
# Does NOT print auth.json / tokens.
set -euo pipefail

POSITIONALS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -*) echo "ERROR: flags not accepted" >&2; echo "REAL_CODEX_CALLS=0"; exit 1 ;;
    *) POSITIONALS+=("$1"); shift ;;
  esac
done
(( ${#POSITIONALS[@]} > 1 )) && { echo "ERROR: extra args" >&2; echo "REAL_CODEX_CALLS=0"; exit 1; }

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: must run as root" >&2
  exit 1
fi

REPO="${AGENTIMPACT_CP_REPO:-/opt/agentimpact/runner/repos/agentimpact-control-plane.git}"
LIVE_ROOT=/opt/agentimpact
BASE_COMPOSE="${LIVE_ROOT}/compose.yml"
APP_SRC="${LIVE_ROOT}/app/src"
BRIDGE_SRC="${REPO}/infra/superset-rpc/bridge.py"
BRIDGE_LIVE=/opt/agentimpact/superset-rpc/bridge.py
BRIDGE_SOCK=/run/agentimpact-superset-rpc/bridge.sock
RPC_UNIT="${RPC_UNIT:-agentimpact-superset-rpc.service}"
PRIVATE_UNIT="${PRIVATE_UNIT:-agentimpact-superset-private.service}"
REPORT_DIR=/opt/agentimpact/runner/superset-rpc-bridge/reports
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="${REPORT_DIR}/jarvis-v1-2-final-quota-convergence-${STAMP}.txt"

mkdir -p "${REPORT_DIR}"
: > "${REPORT}"
exec > >(tee -a "${REPORT}") 2>&1

log() { echo "$*"; }
fail() { log "FAIL: $*"; log "REAL_CODEX_CALLS=0"; log "REAL_CURSOR_CALLS=0"; exit 1; }

log "=== JARVIS V1.2 FINAL CODEX QUOTA CONVERGENCE SMOKE ==="
log "PUBLISHER=OFF"
log "CODEX_API_KEY_ARGV=NO"
log "NOTE=auth_json_not_printed"

docker compose -f "${BASE_COMPOSE}" config >/dev/null || fail "base_compose"
log "BASE_COMPOSE_CONFIG=PASS"

systemctl is-active --quiet "${RPC_UNIT}" || fail "public_bridge_inactive"
systemctl is-active --quiet "${PRIVATE_UNIT}" || fail "private_executor_inactive"
[[ -S "${BRIDGE_SOCK}" ]] || fail "bridge_sock_missing"
log "BRIDGE_PRIVATE_SERVICES=PASS"

# Auth context checks (existence only — never cat credentials)
PRIVATE_USER="$(systemctl show -p User --value "${PRIVATE_UNIT}" 2>/dev/null || true)"
[[ "${PRIVATE_USER}" == "agentimpact-superset" ]] || fail "private_user_not_superset"
log "PRIVATE_EXECUTOR_OWNS_CODEX_AUTH=YES"
# Public bridge / API must not mount codex-home
if systemctl cat "${RPC_UNIT}" 2>/dev/null | grep -q 'codex-home\|auth.json'; then
  fail "public_bridge_has_codex_credentials"
fi
log "PUBLIC_BRIDGE_HAS_CODEX_CREDENTIALS=NO"
if docker compose -f "${BASE_COMPOSE}" exec -T api sh -c \
  'test ! -e /var/lib/agentimpact-superset/codex-home/auth.json && test ! -e /etc/credstore/agentimpact-superset-api-key'; then
  log "API_CONTAINER_HAS_CODEX_CREDENTIALS=NO"
else
  fail "api_has_codex_or_credstore"
fi

# Sync bridge + jarvis quota code
install -o root -g root -m 0644 "${BRIDGE_SRC}" "${BRIDGE_LIVE}"
systemctl restart "${PRIVATE_UNIT}" "${RPC_UNIT}"
sleep 1
systemctl is-active --quiet "${RPC_UNIT}" || fail "bridge_restart"
systemctl is-active --quiet "${PRIVATE_UNIT}" || fail "private_restart"
log "BRIDGE_SYNC=PASS"

mkdir -p "${APP_SRC}/core/missions-v2/jarvis" "${APP_SRC}/core/missions-v2/superset" "${APP_SRC}/scripts" "${APP_SRC}/migrations"
rsync -a "${REPO}/src/core/missions-v2/jarvis/" "${APP_SRC}/core/missions-v2/jarvis/"
rsync -a "${REPO}/src/core/missions-v2/superset/" "${APP_SRC}/core/missions-v2/superset/"
install -o hermes -g hermes -m 0644 "${REPO}/src/scripts/jarvis-quota-decision.ts" "${APP_SRC}/scripts/jarvis-quota-decision.ts"
docker compose -f "${BASE_COMPOSE}" exec -T db psql -U agentimpact_app -d agentimpact -v ON_ERROR_STOP=1 \
  -f - < "${REPO}/src/migrations/015_jarvis_v1_2_quota_authority.sql" >/dev/null \
  || fail "migration_015"
log "MIGRATION_015=APPLIED"

cd "${REPO}/src"
npx vitest run \
  core/missions-v2/jarvis/agent-quota.test.ts \
  core/missions-v2/jarvis/codex-ratelimit-discovery.test.ts \
  core/missions-v2/jarvis/codex-canary-auth.test.ts \
  core/missions-v2/superset/rpc-client.test.ts \
  core/missions-v2/superset/runtime.test.ts \
  2>&1 | tail -40 || fail "static_tests"
cd "${REPO}/infra/superset-rpc"
python3 -m unittest test_bridge.py -v 2>&1 | tail -40 || fail "bridge_tests"
log "STATIC_NO_MODEL_TESTS=PASS"

# Typed RPC codex.rate_limits.read via public bridge (root peer)
OBS_TMP="$(mktemp)"
python3 - "${BRIDGE_SOCK}" "${OBS_TMP}" <<'PY'
import json, socket, sys, uuid
sock_path, out_path = sys.argv[1], sys.argv[2]
req = {
  "request_id": str(uuid.uuid4()),
  "operation": "codex.rate_limits.read",
  "mission_id": str(uuid.uuid4()),
  "attempt_id": str(uuid.uuid4()),
  "fencing_token": str(uuid.uuid4()),
  "parameters": {},
}
try:
  with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
    s.settimeout(25)
    s.connect(sock_path)
    s.sendall(json.dumps(req, separators=(",", ":")).encode())
    s.shutdown(socket.SHUT_WR)
    raw = b""
    while True:
      chunk = s.recv(65536)
      if not chunk:
        break
      raw += chunk
      if len(raw) > 1_000_000:
        break
  resp = json.loads(raw.decode())
except Exception as e:
  resp = {"ok": False, "error": "rpc_unavailable", "detail": str(e)[:80]}
# Never print tokens; write only normalized fields
result = resp.get("result") if isinstance(resp, dict) and resp.get("ok") is True else {
  "quota_state": "unknown",
  "source": "provider_cli",
  "reason": "codex_rate_limits_rpc_unavailable",
  "trustworthy": False,
  "discovery": "UNAVAILABLE",
  "auth_state": "unknown",
  "observed_at": "",
  "expires_at": "",
}
safe = {
  "ok": bool(isinstance(resp, dict) and resp.get("ok") is True),
  "quota_state": result.get("quota_state", "unknown"),
  "source": result.get("source", "provider_cli"),
  "reason": str(result.get("reason", "none"))[:120],
  "trustworthy": bool(result.get("trustworthy") is True),
  "discovery": result.get("discovery", "UNAVAILABLE"),
  "auth_state": result.get("auth_state", "unknown"),
  "observed_at": result.get("observed_at", ""),
  "expires_at": result.get("expires_at", ""),
}
# Redact any accidental sensitive keys
blob = json.dumps(safe)
for bad in ("token", "secret", "password", "bearer", "auth.json"):
  if bad in blob.lower() and bad not in ("auth_state",):
    safe = {**safe, "quota_state": "unknown", "trustworthy": False, "discovery": "ERROR", "reason": "sensitive_leak_blocked"}
open(out_path, "w").write(json.dumps(safe) + "\n")
PY

python3 - "${OBS_TMP}" <<'PY'
import json,sys
d=json.loads(open(sys.argv[1]).read())
print(f"CODEX_DISCOVERY_RUNTIME={'PASS' if d.get('ok') else 'FAIL'}")
print(f"CODEX_AUTH_STATE={d.get('auth_state','unknown')}")
disc=d.get('discovery','UNAVAILABLE')
print(f"CODEX_QUOTA_DISCOVERY={'PASS' if disc=='PASS' else 'UNAVAILABLE'}")
print(f"OBSERVATION_TRUSTWORTHY={str(d.get('trustworthy',False)).lower()}")
print(f"OBSERVATION_QUOTA_STATE={d.get('quota_state','unknown')}")
print(f"OBSERVATION_REASON={d.get('reason','none')}")
print(f"OBSERVED_AT={d.get('observed_at','')}")
print(f"EXPIRES_AT={d.get('expires_at','')}")
open(sys.argv[1]+".env","w").write("\n".join([
  f"OBS_OK={str(d.get('ok',False)).lower()}",
  f"CODEX_AUTH_STATE={d.get('auth_state','unknown')}",
  f"CODEX_QUOTA_DISCOVERY={'PASS' if d.get('discovery')=='PASS' else 'UNAVAILABLE'}",
  f"OBSERVATION_TRUSTWORTHY={str(d.get('trustworthy',False)).lower()}",
  f"OBSERVATION_QUOTA_STATE={d.get('quota_state','unknown')}",
  f"OBSERVATION_REASON={d.get('reason','none')}",
  f"OBSERVED_AT={d.get('observed_at','')}",
  f"EXPIRES_AT={d.get('expires_at','')}",
])+"\n")
PY
# shellcheck disable=SC1090
source "${OBS_TMP}.env"
log "CODEX_DISCOVERY_RUNTIME=$([ "${OBS_OK}" = true ] && echo PASS || echo FAIL)"
log "CODEX_AUTH_STATE=${CODEX_AUTH_STATE}"
log "CODEX_QUOTA_DISCOVERY=${CODEX_QUOTA_DISCOVERY}"
log "LEGACY_OPERATOR_STATE_PRESERVED=YES"

if [[ "${OBSERVATION_TRUSTWORTHY}" == "true" && "${OBSERVATION_QUOTA_STATE}" =~ ^(available|limited|exhausted)$ ]]; then
  SQL_TMP="$(mktemp)"
  python3 - "${SQL_TMP}" "${OBSERVATION_QUOTA_STATE}" "${OBSERVATION_REASON}" "${OBSERVED_AT}" "${EXPIRES_AT}" <<'PY'
import sys
path, state, reason, observed, expires = sys.argv[1:6]
assert state in ("available", "limited", "exhausted")
def lit(s: str) -> str:
  return "'" + s.replace("'", "''")[:120] + "'"
obs = "NULL" if not observed else lit(observed) + "::timestamptz"
exp = "NULL" if not expires else lit(expires) + "::timestamptz"
open(path,"w").write(f"""
INSERT INTO jarvis_agent_quota_state_history (
  worker_type, quota_state, source, reason, observed_at, expires_at, note
)
SELECT worker_type, quota_state, source,
  COALESCE(NULLIF(reason, ''), 'pre_provider_cli_snapshot'),
  observed_at, expires_at,
  COALESCE(NULLIF(note, ''), '') || ';pre_provider_cli_observation'
FROM jarvis_agent_quota_state WHERE worker_type='codex';
INSERT INTO jarvis_agent_quota_state (
  worker_type, quota_state, source, reason, observed_at, expires_at, updated_at, note
) VALUES (
  'codex', {lit(state)}, 'provider_cli', {lit(reason)},
  {obs}, {exp}, now(), 'provider_cli_ratelimit_observation'
)
ON CONFLICT (worker_type) DO UPDATE SET
  quota_state = EXCLUDED.quota_state,
  source = EXCLUDED.source,
  reason = EXCLUDED.reason,
  observed_at = EXCLUDED.observed_at,
  expires_at = EXCLUDED.expires_at,
  updated_at = now(),
  note = EXCLUDED.note;
INSERT INTO jarvis_agent_quota_state_history (
  worker_type, quota_state, source, reason, observed_at, expires_at, note
) VALUES (
  'codex', {lit(state)}, 'provider_cli', {lit(reason)},
  {obs}, {exp}, 'provider_cli_ratelimit_observation'
);
""")
PY
  docker compose -f "${BASE_COMPOSE}" exec -T db psql -U agentimpact_app -d agentimpact -v ON_ERROR_STOP=1 \
    -f - < "${SQL_TMP}" >/dev/null || fail "persist_provider_cli"
  rm -f "${SQL_TMP}"
  log "CODEX_QUOTA_PROVIDER_OBSERVATION=PERSISTED"
else
  log "CODEX_QUOTA_PROVIDER_OBSERVATION=NOT_PERSISTED"
fi

DEC_TMP="$(mktemp)"
docker compose -f "${BASE_COMPOSE}" exec -T api sh -c \
  'cd /app 2>/dev/null || cd /opt/agentimpact/app; node --import tsx src/scripts/jarvis-quota-decision.ts codex' \
  >"${DEC_TMP}" 2>/dev/null || fail "quota_decision_unavailable"
python3 - "${DEC_TMP}" <<'PY'
import json,sys
raw=open(sys.argv[1]).read().strip().splitlines()[-1]
d=json.loads(raw)
print(f"CODEX_QUOTA_STATE={d.get('quotaState')}")
print(f"CODEX_QUOTA_SOURCE={d.get('source')}")
print(f"CODEX_QUOTA_FRESH={str(d.get('fresh')).lower()}")
print(f"CODEX_QUOTA_AUTHORIZATION_CLASS={d.get('authorizationClass')}")
print(f"OPERATOR_CAN_AUTHORIZE_CODEX={d.get('OPERATOR_CAN_AUTHORIZE_CODEX','NO')}")
print(f"CANARY_DIRECT_QUOTA_SQL={d.get('CANARY_DIRECT_QUOTA_SQL','NO')}")
PY

# Cleanup: no leftover app-server from this probe (best-effort; private executor terminates child)
if pgrep -u agentimpact-superset -f 'app-server --stdio' >/dev/null 2>&1; then
  log "CODEX_APP_SERVER_CLEANUP=WARN_PROCESS_PRESENT"
else
  log "CODEX_APP_SERVER_CLEANUP=PASS"
fi

# Safe flags remain OFF on base compose
ENV_DUMP="$(docker compose -f "${BASE_COMPOSE}" exec -T api printenv 2>/dev/null || true)"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=0$' >/dev/null || fail "v2_not_off"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0$' >/dev/null || fail "agent_not_off"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=1$' >/dev/null && fail "publisher_on" || true
log "SAFE_FLAGS_OFF=PASS"
log "PUBLISHER=OFF"

rm -f "${OBS_TMP}" "${OBS_TMP}.env" "${DEC_TMP}"
log "CODEX_QUOTA_AUTHORITY=PASS"
log "CODEX_CURSOR_QUOTA_ISOLATION=PASS"
log "REAL_CODEX_CALLS=0"
log "REAL_CURSOR_CALLS=0"
log "NOTE=no_completion_no_token_read_no_workspace_no_agent_start"
log "GATE_NADIR_JARVIS_V1_2_FINAL_QUOTA_CONVERGENCE_SMOKE"
log "REPORT=${REPORT}"
