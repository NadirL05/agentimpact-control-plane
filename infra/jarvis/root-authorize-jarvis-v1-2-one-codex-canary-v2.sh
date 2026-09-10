#!/usr/bin/env bash
# Create root-owned one-shot authorization for Jarvis V1.2 Codex canary armed-v2.
# OUTER-COMPAT: outer-verify-and-run.py execs verified scripts with legacy tarball as $1.
# This helper accepts/ignores exactly ONE bare positional (legacy tarball) and rejects
# any additional bare positionals. The ignored value NEVER influences authorization.
#
# Does NOT launch Codex / Cursor. Does NOT modify outer-verify.
#
# Usage (as root), typically via outer-verify:
#   outer-verify ... --script .../root-authorize-jarvis-v1-2-one-codex-canary-v2.sh
#   → receives: bash verified_copy /tmp/.../superset-linux-x64.tar.gz
#
# Direct (optional flags):
#   ./root-authorize-jarvis-v1-2-one-codex-canary-v2.sh [--script PATH] [--ttl-seconds N]
#   ./root-authorize-jarvis-v1-2-one-codex-canary-v2.sh --parse-only [same args...]
#
# Writes: /run/agentimpact-jarvis-canary/codex-one-shot.auth (0400 root:root)
set -euo pipefail

# Pinned armed canary V2 — authorization content is bound to this SHA only.
EXPECTED_CANARY_SHA256=f3aaa0081634d011e060936ae0517c1d234858626b033f29b635d5fb626c9e60
DEFAULT_SCRIPT=/opt/agentimpact/runner/superset-rpc-bridge/scripts/root-run-jarvis-v1-2-codex-canary-armed-v2.sh

SCRIPT_PATH="${DEFAULT_SCRIPT}"
TTL_SECONDS=900
PARSE_ONLY=0
AUTH_DIR=/run/agentimpact-jarvis-canary
AUTH_FILE="${AUTH_DIR}/codex-one-shot.auth"
CONSUMED_DIR=/var/lib/agentimpact-jarvis-canary/consumed-nonces

POSITIONALS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --script)
      SCRIPT_PATH="${2:?ERROR: --script requires a path}"
      shift 2
      ;;
    --ttl-seconds)
      TTL_SECONDS="${2:?ERROR: --ttl-seconds requires a value}"
      shift 2
      ;;
    --parse-only)
      PARSE_ONLY=1
      shift
      ;;
    --*)
      echo "ERROR: unknown flag $1" >&2
      exit 1
      ;;
    *)
      POSITIONALS+=("$1")
      shift
      ;;
  esac
done

if (( ${#POSITIONALS[@]} > 1 )); then
  echo "ERROR: extra positional args (only one legacy outer-verify tarball arg allowed)" >&2
  echo "AUTH_HELPER_EXTRA_ARGS_DENIED=PASS"
  exit 1
fi

LEGACY_TARBALL_PRESENT=0
LEGACY_TARBALL_VALUE=""
if (( ${#POSITIONALS[@]} == 1 )); then
  LEGACY_TARBALL_PRESENT=1
  LEGACY_TARBALL_VALUE="${POSITIONALS[0]}"
fi

[[ -n "${SCRIPT_PATH}" ]] || { echo "ERROR: --script required" >&2; exit 1; }
[[ "${TTL_SECONDS}" =~ ^[0-9]+$ ]] && (( TTL_SECONDS >= 60 && TTL_SECONDS <= 3600 )) \
  || { echo "ERROR: ttl must be 60..3600" >&2; exit 1; }

if [[ ! -f "${SCRIPT_PATH}" ]]; then
  echo "ERROR: script not found: ${SCRIPT_PATH}" >&2
  exit 1
fi

SCRIPT_SHA="$(sha256sum "${SCRIPT_PATH}" | awk '{print $1}')"
if [[ "${SCRIPT_SHA}" != "${EXPECTED_CANARY_SHA256}" ]]; then
  echo "ERROR: canary script sha256 mismatch (refusing to authorize wrong pin)" >&2
  echo "got=${SCRIPT_SHA}" >&2
  echo "expected=${EXPECTED_CANARY_SHA256}" >&2
  exit 1
fi

# Legacy tarball value is intentionally discarded and must never enter auth JSON.
unset LEGACY_TARBALL_VALUE

if [[ "${PARSE_ONLY}" -eq 1 ]]; then
  echo "AUTH_HELPER_PARSE_ONLY=PASS"
  echo "AUTH_HELPER_OUTER_COMPAT=PASS"
  if [[ "${LEGACY_TARBALL_PRESENT}" -eq 1 ]]; then
    echo "AUTH_HELPER_LEGACY_POSITIONAL=ACCEPTED_IGNORED"
  else
    echo "AUTH_HELPER_LEGACY_POSITIONAL=ABSENT_OK"
  fi
  echo "AUTH_HELPER_LEGACY_INFLUENCES_AUTH=NO"
  echo "CANARY_SCRIPT_SHA256=${SCRIPT_SHA}"
  echo "CANARY_SCOPE=ONE_REAL_CODEX_CANARY_ONLY"
  echo "CANARY_PROVIDER=codex"
  echo "CANARY_MAX_PROVIDER_CALLS=1"
  echo "PUBLISHER=OFF"
  echo "REAL_CODEX_CALLS=0"
  echo "REAL_CURSOR_CALLS=0"
  echo "CODEX_EXECUTION=NO"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: must run as root (use --parse-only for static argv checks)" >&2
  exit 1
fi

NONCE="$(cat /proc/sys/kernel/random/uuid)"
CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EXPIRES="$(date -u -d "+${TTL_SECONDS} seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || python3 -c "from datetime import datetime,timedelta,timezone;print((datetime.now(timezone.utc)+timedelta(seconds=int('${TTL_SECONDS}'))).strftime('%Y-%m-%dT%H:%M:%SZ'))")"

mkdir -p "${AUTH_DIR}"
chmod 0700 "${AUTH_DIR}"
chown root:root "${AUTH_DIR}"
mkdir -p "${CONSUMED_DIR}"
chmod 0700 "${CONSUMED_DIR}"
chown root:root "${CONSUMED_DIR}"

TMP="$(mktemp "${AUTH_DIR}/.auth.XXXXXX")"
# Authorization JSON: explicit fields only. Legacy tarball MUST NOT appear.
python3 - <<PY
import json
obj={
  "scope":"ONE_REAL_CODEX_CANARY_ONLY",
  "script_sha256":"${SCRIPT_SHA}",
  "provider":"codex",
  "max_provider_calls":1,
  "publisher":"off",
  "created_at":"${CREATED}",
  "expires_at":"${EXPIRES}",
  "nonce":"${NONCE}",
}
open("${TMP}","w").write(json.dumps(obj,separators=(",",":"),sort_keys=True)+"\n")
PY
chown root:root "${TMP}"
chmod 0400 "${TMP}"
mv -f "${TMP}" "${AUTH_FILE}"
chown root:root "${AUTH_FILE}"
chmod 0400 "${AUTH_FILE}"

echo "CANARY_AUTHORIZATION_FILE=CREATED"
echo "CANARY_AUTHORIZATION_PATH=${AUTH_FILE}"
echo "CANARY_SCOPE=ONE_REAL_CODEX_CANARY_ONLY"
echo "CANARY_PROVIDER=codex"
echo "CANARY_MAX_PROVIDER_CALLS=1"
echo "CANARY_SCRIPT_SHA256=${SCRIPT_SHA}"
echo "CANARY_CREATED_AT=${CREATED}"
echo "CANARY_EXPIRES_AT=${EXPIRES}"
echo "AUTH_HELPER_OUTER_COMPAT=PASS"
echo "AUTH_HELPER_LEGACY_INFLUENCES_AUTH=NO"
echo "PUBLISHER=OFF"
echo "REAL_CODEX_CALLS=0"
echo "REAL_CURSOR_CALLS=0"
