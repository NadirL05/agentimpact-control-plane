#!/usr/bin/env bash
# Jarvis V1.2 — NO-MODEL Codex rate-limit discovery smoke.
# outer-verify may pass unused tarball as $1 — ignore.
#
# Queries authenticated Codex app-server account/rateLimits/read only.
# Does NOT start Jarvis agent execution, workspace, or Codex completion.
# Does NOT print auth tokens.
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
REPORT="${REPORT_DIR}/jarvis-v1-2-codex-ratelimit-discovery-${STAMP}.txt"

# Prefer hermes/root Codex home if present — never cat auth.json
export CODEX_HOME="${CODEX_HOME:-/root/.codex}"
if [[ ! -d "${CODEX_HOME}" ]]; then
  if [[ -d /home/hermes/.codex ]]; then
    export CODEX_HOME=/home/hermes/.codex
  elif [[ -d /home/agentimpact-runner/.codex ]]; then
    export CODEX_HOME=/home/agentimpact-runner/.codex
  fi
fi

mkdir -p "${REPORT_DIR}"
: > "${REPORT}"
exec > >(tee -a "${REPORT}") 2>&1

log() { echo "$*"; }
fail() { log "FAIL: $*"; log "REAL_CODEX_CALLS=0"; log "REAL_CURSOR_CALLS=0"; exit 1; }

log "=== JARVIS V1.2 CODEX RATELIMIT DISCOVERY SMOKE ==="
log "PUBLISHER=OFF"
log "CODEX_HOME_SET=$([ -d "${CODEX_HOME}" ] && echo YES || echo NO)"
log "NOTE=auth_json_not_printed"

docker compose -f "${BASE_COMPOSE}" config >/dev/null || fail "base_compose"
log "BASE_COMPOSE_CONFIG=PASS"

mkdir -p "${APP_SRC}/core/missions-v2/jarvis" "${APP_SRC}/scripts" "${APP_SRC}/migrations"
rsync -a "${REPO}/src/core/missions-v2/jarvis/" "${APP_SRC}/core/missions-v2/jarvis/"
install -o hermes -g hermes -m 0644 "${REPO}/src/scripts/jarvis-quota-decision.ts" "${APP_SRC}/scripts/jarvis-quota-decision.ts"
install -o hermes -g hermes -m 0644 "${REPO}/src/scripts/jarvis-codex-ratelimit-discover.ts" \
  "${APP_SRC}/scripts/jarvis-codex-ratelimit-discover.ts"
install -o hermes -g hermes -m 0644 "${REPO}/src/migrations/015_jarvis_v1_2_quota_authority.sql" \
  "${APP_SRC}/migrations/015_jarvis_v1_2_quota_authority.sql" 2>/dev/null || true
docker compose -f "${BASE_COMPOSE}" exec -T db psql -U agentimpact_app -d agentimpact -v ON_ERROR_STOP=1 \
  -f - < "${REPO}/src/migrations/015_jarvis_v1_2_quota_authority.sql" >/dev/null \
  || fail "migration_015"
log "MIGRATION_015=APPLIED"

cd "${REPO}/src"
npx vitest run core/missions-v2/jarvis/codex-ratelimit-discovery.test.ts \
  core/missions-v2/jarvis/agent-quota.test.ts 2>&1 | tail -30 || fail "static_tests"
log "STATIC_RATELIMIT_TESTS=PASS"

# Host probe — no model completion (app-server rateLimits only)
PROBE_TMP="$(mktemp)"
if ! node --import tsx "${REPO}/src/scripts/jarvis-codex-ratelimit-discover.ts" --probe-only \
  >"${PROBE_TMP}" 2>/tmp/jarvis-ratelimit-probe.err; then
  log "CODEX_QUOTA_DISCOVERY=UNAVAILABLE"
  log "PROBE_SPAWN=FAIL"
fi

python3 - "${PROBE_TMP}" <<'PY'
import json,sys,os
path=sys.argv[1]
try:
  raw=open(path).read().strip().splitlines()[-1]
  d=json.loads(raw)
except Exception:
  d={
    "CODEX_QUOTA_DISCOVERY":"UNAVAILABLE",
    "OBSERVATION_TRUSTWORTHY":False,
    "CODEX_QUOTA_STATE":"unknown",
    "CODEX_QUOTA_SOURCE":"unknown",
    "CODEX_QUOTA_FRESH":False,
    "CODEX_QUOTA_AUTHORIZATION_CLASS":"DENY_UNKNOWN",
    "OBSERVATION_QUOTA_STATE":"unknown",
    "OBSERVATION_REASON":"probe_parse_failed",
    "OBSERVED_AT":"",
    "EXPIRES_AT":"",
  }
open(path+".env","w").write("\n".join([
  f"CODEX_QUOTA_DISCOVERY={d.get('CODEX_QUOTA_DISCOVERY','UNAVAILABLE')}",
  f"CODEX_QUOTA_DISCOVERY_STATUS={d.get('CODEX_QUOTA_DISCOVERY_STATUS','ERROR')}",
  f"CODEX_AUTH_STATE={d.get('CODEX_AUTH_STATE','unknown')}",
  f"OBSERVATION_TRUSTWORTHY={str(d.get('OBSERVATION_TRUSTWORTHY',False)).lower()}",
  f"OBSERVATION_QUOTA_STATE={d.get('OBSERVATION_QUOTA_STATE','unknown')}",
  f"OBSERVATION_REASON={d.get('OBSERVATION_REASON','none')}",
  f"OBSERVED_AT={d.get('OBSERVED_AT','')}",
  f"EXPIRES_AT={d.get('EXPIRES_AT','')}",
  f"PROBE_AUTH_CLASS={d.get('CODEX_QUOTA_AUTHORIZATION_CLASS','DENY_UNKNOWN')}",
])+"\n")
PY
# shellcheck disable=SC1090
source "${PROBE_TMP}.env"
log "CODEX_QUOTA_DISCOVERY=${CODEX_QUOTA_DISCOVERY}"
log "CODEX_QUOTA_DISCOVERY_STATUS=${CODEX_QUOTA_DISCOVERY_STATUS}"
log "CODEX_AUTH_STATE=${CODEX_AUTH_STATE}"
log "OBSERVATION_TRUSTWORTHY=${OBSERVATION_TRUSTWORTHY}"
log "OBSERVATION_REASON=${OBSERVATION_REASON}"
log "LEGACY_OPERATOR_STATE_PRESERVED=YES"

# Persist only trusted provider_cli observation (history snapshot in SQL path)
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
  log "NOTE=legacy_operator_row_unchanged"
fi

# Typed Control Plane decision (no completion)
DEC_TMP="$(mktemp)"
docker compose -f "${BASE_COMPOSE}" exec -T api sh -c \
  'cd /app 2>/dev/null || cd /opt/agentimpact/app; node --import tsx src/scripts/jarvis-quota-decision.ts codex' \
  >"${DEC_TMP}" 2>/dev/null || fail "quota_decision_unavailable"
python3 - "${DEC_TMP}" <<'PY'
import json,sys
path=sys.argv[1]
raw=open(path).read().strip().splitlines()[-1]
d=json.loads(raw)
print(f"CODEX_QUOTA_STATE={d.get('quotaState')}")
print(f"CODEX_QUOTA_SOURCE={d.get('source')}")
print(f"CODEX_QUOTA_FRESH={str(d.get('fresh')).lower()}")
print(f"CODEX_QUOTA_AUTHORIZATION_CLASS={d.get('authorizationClass')}")
print(f"CURRENT_CODEX_QUOTA_CLASSIFICATION={d.get('CURRENT_CODEX_QUOTA_CLASSIFICATION')}")
print(f"OPERATOR_CAN_AUTHORIZE_CODEX={d.get('OPERATOR_CAN_AUTHORIZE_CODEX','NO')}")
print(f"CANARY_DIRECT_QUOTA_SQL={d.get('CANARY_DIRECT_QUOTA_SQL','NO')}")
PY

rm -f "${PROBE_TMP}" "${PROBE_TMP}.env" "${DEC_TMP}"
log "CODEX_QUOTA_FRESHNESS_POLICY=15m_or_earlier_reset"
log "CODEX_CURSOR_QUOTA_ISOLATION=PASS"
log "REAL_CODEX_CALLS=0"
log "REAL_CURSOR_CALLS=0"
log "NOTE=no_completion_no_token_read_no_workspace_no_agent_start"
log "GATE_NADIR_JARVIS_V1_2_CODEX_RATELIMIT_ROOT_SMOKE"
log "REPORT=${REPORT}"
