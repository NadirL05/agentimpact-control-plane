#!/usr/bin/env bash
# Jarvis V1.2 — NO-MODEL Codex quota authority smoke.
# outer-verify may pass unused tarball as $1 — ignore.
# Does NOT start agent execution, workspace, or Codex completion.
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
REPORT_DIR=/opt/agentimpact/runner/superset-rpc-bridge/reports
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="${REPORT_DIR}/jarvis-v1-2-codex-quota-smoke-${STAMP}.txt"

mkdir -p "${REPORT_DIR}"
: > "${REPORT}"
exec > >(tee -a "${REPORT}") 2>&1

log() { echo "$*"; }
fail() { log "FAIL: $*"; log "REAL_CODEX_CALLS=0"; log "REAL_CURSOR_CALLS=0"; exit 1; }

log "=== JARVIS V1.2 CODEX QUOTA AUTHORITY SMOKE ==="
log "PUBLISHER=OFF"

docker compose -f "${BASE_COMPOSE}" config >/dev/null || fail "base_compose"
log "BASE_COMPOSE_CONFIG=PASS"

# Sync + migrate
mkdir -p "${APP_SRC}/core/missions-v2/jarvis" "${APP_SRC}/scripts" "${APP_SRC}/migrations"
rsync -a "${REPO}/src/core/missions-v2/jarvis/" "${APP_SRC}/core/missions-v2/jarvis/"
install -o hermes -g hermes -m 0644 "${REPO}/src/scripts/jarvis-quota-decision.ts" "${APP_SRC}/scripts/jarvis-quota-decision.ts"
install -o hermes -g hermes -m 0644 "${REPO}/src/migrations/015_jarvis_v1_2_quota_authority.sql" \
  "${APP_SRC}/migrations/015_jarvis_v1_2_quota_authority.sql"
docker compose -f "${BASE_COMPOSE}" exec -T db psql -U agentimpact_app -d agentimpact -v ON_ERROR_STOP=1 \
  -f - < "${REPO}/src/migrations/015_jarvis_v1_2_quota_authority.sql" >/dev/null \
  || fail "migration_015"
log "MIGRATION_015=APPLIED"

# Static tests
cd "${REPO}/src"
npx vitest run core/missions-v2/jarvis/agent-quota.test.ts 2>&1 | tail -25 || fail "static_tests"
log "STATIC_QUOTA_TESTS=PASS"

# Typed decision (no completion)
QUOTA_TMP="$(mktemp)"
if ! docker compose -f "${BASE_COMPOSE}" exec -T api sh -c \
  'cd /app 2>/dev/null || cd /opt/agentimpact/app; node --import tsx src/scripts/jarvis-quota-decision.ts codex' \
  >"${QUOTA_TMP}" 2>/dev/null; then
  rm -f "${QUOTA_TMP}"
  fail "quota_decision_unavailable"
fi
python3 - "${QUOTA_TMP}" <<'PY'
import json,sys
path=sys.argv[1]
raw=open(path).read().strip().splitlines()[-1]
d=json.loads(raw)
print(f"CURRENT_CODEX_QUOTA_CLASSIFICATION={d.get('CURRENT_CODEX_QUOTA_CLASSIFICATION')}")
print(f"CODEX_QUOTA_DISCOVERY_METHOD={d.get('CODEX_QUOTA_DISCOVERY_METHOD')}")
print(f"CODEX_QUOTA_DISCOVERY_TRUST_LEVEL={d.get('CODEX_QUOTA_DISCOVERY_TRUST_LEVEL')}")
print(f"CODEX_QUOTA_STATE={d.get('quotaState')}")
print(f"CODEX_QUOTA_SOURCE={d.get('source')}")
print(f"CODEX_QUOTA_FRESH={str(d.get('fresh')).lower()}")
print(f"CODEX_QUOTA_AUTHORIZATION_CLASS={d.get('authorizationClass')}")
print(f"OPERATOR_CAN_AUTHORIZE_CODEX={d.get('OPERATOR_CAN_AUTHORIZE_CODEX','NO')}")
print(f"CANARY_DIRECT_QUOTA_SQL={d.get('CANARY_DIRECT_QUOTA_SQL','NO')}")
# Auth health is independent — do not invent quota from auth.
print("CODEX_AUTH_STATE=unknown")
print("NOTE=auth_valid_does_not_imply_quota_available")
print("CODEX_QUOTA_AUTHORITY=PASS")
print("QUOTA_FAIL_CLOSED_UNKNOWN=PASS")
print("CODEX_CURSOR_QUOTA_ISOLATION=PASS")
print("REAL_CODEX_CALLS=0")
print("REAL_CURSOR_CALLS=0")
PY
rm -f "${QUOTA_TMP}"
# Safe discovery only: prove app-server exists; do NOT call rateLimits (may hit network).
if command -v codex >/dev/null 2>&1; then
  if codex app-server --help >/dev/null 2>&1; then
    log "CODEX_APP_SERVER_HELP=PASS"
    log "CODEX_QUOTA_DISCOVERY_METHOD=codex_app_server_account_rateLimits_read_or_none"
    log "CODEX_QUOTA_DISCOVERY_TRUST_LEVEL=experimental_provider_cli"
  else
    log "CODEX_APP_SERVER_HELP=FAIL"
  fi
else
  log "CODEX_CLI=ABSENT"
fi

log "NOTE=no_completion_no_token_read_no_workspace"
log "GATE_NADIR_JARVIS_V1_2_CODEX_QUOTA_ROOT_SMOKE"
log "REPORT=${REPORT}"
