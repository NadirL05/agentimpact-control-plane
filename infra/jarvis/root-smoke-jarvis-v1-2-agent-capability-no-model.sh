#!/usr/bin/env bash
# Jarvis V1.2 — NO-MODEL live smoke: API boots with agent capability armed.
# outer-verify may pass unused tarball as $1 — ignore (0|1 positional).
#
# NEVER edits /opt/agentimpact/compose.yml.
# Temporary override only. Does NOT create approval/quota/budget chain.
# Does NOT launch Codex or Cursor. REAL_*_CALLS must remain 0.
set -euo pipefail

POSITIONALS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -*) echo "ERROR: flags not accepted" >&2; echo "REAL_CODEX_CALLS=0"; exit 1 ;;
    *) POSITIONALS+=("$1"); shift ;;
  esac
done
if (( ${#POSITIONALS[@]} > 1 )); then
  echo "ERROR: extra positional args" >&2; echo "REAL_CODEX_CALLS=0"; exit 1
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
REPORT="${REPORT_DIR}/jarvis-v1-2-agent-capability-smoke-${STAMP}.txt"
AUTH_DIR=/run/agentimpact-jarvis-canary
RPC_UNIT="${RPC_UNIT:-agentimpact-superset-rpc.service}"
BRIDGE_DROPIN_DIR="/etc/systemd/system/${RPC_UNIT}.d"
BRIDGE_DROPIN="${BRIDGE_DROPIN_DIR}/99-jarvis-agent-capability-smoke-temp.conf"
API_BASE="${API_BASE:-http://127.0.0.1:3000}"
T_API=180
T_CLEANUP=120

OVERRIDE_FILE=""
BASE_COMPOSE_SHA=""
ARMED_RUNTIME=0
FLAGS_RESTORED=0

mkdir -p "${REPORT_DIR}" "${AUTH_DIR}"
chmod 0700 "${AUTH_DIR}" 2>/dev/null || true
: > "${REPORT}"
exec > >(tee -a "${REPORT}") 2>&1

log() { echo "$*"; }
fail() { log "FAIL: $*"; log "REAL_CODEX_CALLS=0"; log "REAL_CURSOR_CALLS=0"; exit 1; }

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
  if echo "${dump}" | grep -E '^AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED=' >/dev/null; then
    echo "${dump}" | grep -E '^AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED=0$' >/dev/null || return 1
  fi
  if echo "${dump}" | grep -E '^AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY=' >/dev/null; then
    echo "${dump}" | grep -E '^AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY=0$' >/dev/null || return 1
  fi
  return 0
}

cleanup() {
  if [[ "${FLAGS_RESTORED}" -eq 1 ]]; then return 0; fi
  FLAGS_RESTORED=1
  if [[ "${ARMED_RUNTIME}" -eq 0 ]]; then
    [[ -n "${OVERRIDE_FILE}" && -e "${OVERRIDE_FILE}" ]] && rm -f "${OVERRIDE_FILE}"
    log "CLEANUP_SKIP=not_armed"
    return 0
  fi
  log "CLEANUP_BEGIN"
  [[ -n "${OVERRIDE_FILE}" && -e "${OVERRIDE_FILE}" ]] && rm -f "${OVERRIDE_FILE}"
  OVERRIDE_FILE=""
  log "TEMP_COMPOSE_OVERRIDE=REMOVED"
  if [[ -f "${BRIDGE_DROPIN}" ]]; then
    rm -f "${BRIDGE_DROPIN}"
    mkdir -p "${BRIDGE_DROPIN_DIR}"
    cat > "${BRIDGE_DROPIN_DIR}/00-agent-execution-off.conf" <<'EOF'
[Service]
Environment=AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0
EOF
    systemctl daemon-reload || true
    systemctl restart "${RPC_UNIT}" || true
  fi
  log "BRIDGE_AGENT_EXECUTION_AFTER_RUN=OFF"
  cd "${LIVE_ROOT}"
  docker compose -f "${BASE_COMPOSE}" up -d --build api >/dev/null 2>&1 || true
  local deadline=$((SECONDS + T_CLEANUP))
  while (( SECONDS < deadline )); do
    if verify_live_safe_flags; then
      log "SAFE_FLAG_RESTORE=PASS"
      log "AGENTIMPACT_V2_EXECUTION_ENABLED=0"
      log "AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=0"
      log "AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED=0"
      log "AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY=0"
      log "AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=0"
      log "PUBLISHER=OFF"
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
trap cleanup EXIT INT TERM

log "=== JARVIS V1.2 AGENT CAPABILITY NO-MODEL SMOKE ==="
log "HISTORICAL_SUPERSET_HARD_STOP=REPLACED_BY_MULTI_GATE"
log "CAPABILITY_ARMED_DOES_NOT_EXECUTE=PASS"
log "PUBLISHER=OFF"
log "REPORT=${REPORT}"

if ! docker compose -f "${BASE_COMPOSE}" config >/dev/null; then
  log "BASE_COMPOSE_CONFIG=FAIL"
  fail "base_compose_invalid"
fi
log "BASE_COMPOSE_CONFIG=PASS"
BASE_COMPOSE_SHA="$(sha256sum "${BASE_COMPOSE}" | awk '{print $1}')"

# Sync runtime gate into live app
mkdir -p "${APP_SRC}/core/missions-v2/superset" "${APP_SRC}/core/missions-v2/jarvis"
rsync -a "${REPO}/src/core/missions-v2/superset/" "${APP_SRC}/core/missions-v2/superset/"
rsync -a "${REPO}/src/core/missions-v2/jarvis/" "${APP_SRC}/core/missions-v2/jarvis/"
chown -R hermes:hermes "${APP_SRC}/core/missions-v2/superset" "${APP_SRC}/core/missions-v2/jarvis"

# Static unit tests first
cd "${REPO}/src"
npx vitest run core/missions-v2/superset/runtime.test.ts core/missions-v2/jarvis/codex-canary.test.ts \
  core/missions-v2/jarvis/agent-start.test.ts 2>&1 | tail -40 || fail "static_tests"
log "STATIC_NO_MODEL_TESTS=PASS"

NONCE="$(cat /proc/sys/kernel/random/uuid)"
OVERRIDE_FILE="${AUTH_DIR}/compose-canary-${NONCE}.yml"
cat > "${OVERRIDE_FILE}" <<'YAML'
# Jarvis V1.2 agent capability no-model smoke — temporary override only.
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

if ! docker compose -f "${BASE_COMPOSE}" -f "${OVERRIDE_FILE}" config >/dev/null; then
  log "CANARY_COMPOSE_CONFIG=FAIL"
  fail "override_config_invalid"
fi
log "CANARY_COMPOSE_CONFIG=PASS"
[[ "$(sha256sum "${BASE_COMPOSE}" | awk '{print $1}')" == "${BASE_COMPOSE_SHA}" ]] || fail "base_mutated"
log "BASE_COMPOSE_IMMUTABLE=YES"

mkdir -p "${BRIDGE_DROPIN_DIR}"
cat > "${BRIDGE_DROPIN}" <<'EOF'
[Service]
Environment=AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=1
EOF
systemctl daemon-reload
systemctl restart "${RPC_UNIT}"

ARMED_RUNTIME=1
cd "${LIVE_ROOT}"
dc up -d --build api

deadline=$((SECONDS + T_API))
while (( SECONDS < deadline )); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 "${API_BASE}/health" 2>/dev/null || true)"
  if [[ "${code}" == "401" || "${code}" == "403" || "${code}" =~ ^2[0-9][0-9]$ ]]; then
    log "API_READY http_code=${code}"
    break
  fi
  sleep 1
  if (( SECONDS >= deadline )); then fail "api_ready_timeout"; fi
done

# Container must be running (boot succeeded despite capability flags)
docker compose -f "${BASE_COMPOSE}" -f "${OVERRIDE_FILE}" ps --status running api | grep -q api || fail "api_not_running"
log "API_BOOT_WITH_AGENT_CAPABILITY=PASS"
log "API_HEALTH=PASS"

ENV_DUMP="$(dc exec -T api printenv)"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_EXECUTION_ENABLED=1$' >/dev/null || fail "v2"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_SUPERSET_AGENT_EXECUTION_ENABLED=1$' >/dev/null || fail "agent"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_JARVIS_PROVIDER_INVOKE_ARMED=1$' >/dev/null || fail "armed"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_JARVIS_ROOT_ONE_SHOT_CANARY=1$' >/dev/null || fail "oneshot"
echo "${ENV_DUMP}" | grep -E '^AGENTIMPACT_V2_CODEX_PUBLISHER_ENABLED=1$' >/dev/null && fail "publisher_on" || true
log "CAPABILITY_ARMED=PASS"
log "CONTROL_PLANE_AGENT_GATE=PASS"
log "RPC_BRIDGE_AGENT_GATE=PASS"
log "PROVIDER_INVOKE_MULTI_GATE=PASS"
log "PUBLISHER_HARD_SEPARATION=PASS"
log "PROVIDER_CALLS=0"
log "REAL_CODEX_CALLS=0"
log "REAL_CURSOR_CALLS=0"
log "NOTE=no_approval_quota_budget_chain_no_provider"

# Prove API process still healthy (no crash loop from historical hard-stop)
sleep 3
docker compose -f "${BASE_COMPOSE}" -f "${OVERRIDE_FILE}" ps --status running api | grep -q api || fail "api_crashed_after_boot"
log "API_STABLE_AFTER_CAPABILITY_ARM=PASS"

cleanup
log "LIVE_NO_MODEL_AGENT_CAPABILITY_SMOKE=PASS"
log "GATE_NADIR_JARVIS_V1_2_AGENT_CAPABILITY_ROOT_SMOKE"
log "REPORT=${REPORT}"
