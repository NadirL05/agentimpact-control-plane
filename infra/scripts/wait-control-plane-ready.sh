#!/usr/bin/env bash
# Attend l'API control-plane (GET /health → 200 avec bridge token).
# Aucun secret dans les logs (codes HTTP uniquement).
# Usage : ExecStartPre= sur consumers Hermès/Ana (credentials systemd disponibles).
set -euo pipefail

BASE_URL="${CONTROL_PLANE_URL:-http://127.0.0.1:3000}"
BASE_URL="${BASE_URL%/}"
HEALTH_URL="${WAIT_CONTROL_PLANE_HEALTH_URL:-${BASE_URL}/health}"
TIMEOUT_SEC="${WAIT_CONTROL_PLANE_TIMEOUT_SEC:-90}"
INTERVAL_SEC="${WAIT_CONTROL_PLANE_INTERVAL_SEC:-2}"

TOKEN_FILE="${SLACK_ROUTER_BRIDGE_TOKEN_FILE:-}"
if [ -z "$TOKEN_FILE" ] && [ -n "${CREDENTIALS_DIRECTORY:-}" ]; then
  TOKEN_FILE="${CREDENTIALS_DIRECTORY}/gateway-bridge-token"
fi

if ! [[ "$TIMEOUT_SEC" =~ ^[0-9]+$ ]] || [ "$TIMEOUT_SEC" -lt 1 ] || [ "$TIMEOUT_SEC" -gt 300 ]; then
  echo "wait_control_plane_ready: invalid timeout" >&2
  exit 64
fi
if ! [[ "$INTERVAL_SEC" =~ ^[0-9]+$ ]] || [ "$INTERVAL_SEC" -lt 1 ] || [ "$INTERVAL_SEC" -gt 30 ]; then
  echo "wait_control_plane_ready: invalid interval" >&2
  exit 64
fi
if [ -z "$TOKEN_FILE" ] || [ ! -r "$TOKEN_FILE" ]; then
  echo "wait_control_plane_ready: token_file_missing" >&2
  exit 2
fi

token="$(tr -d '\r\n' <"$TOKEN_FILE")"
if [ -z "$token" ]; then
  echo "wait_control_plane_ready: token_empty" >&2
  exit 2
fi

deadline=$((SECONDS + TIMEOUT_SEC))
while [ "$SECONDS" -lt "$deadline" ]; do
  code="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 2 --max-time 5 \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/json" \
      "$HEALTH_URL" 2>/dev/null || echo "000"
  )"
  # Ne jamais journaliser le token ni le corps.
  if [ "$code" = "200" ]; then
    echo "wait_control_plane_ready: ok" >&2
    exit 0
  fi
  echo "wait_control_plane_ready: waiting http=${code}" >&2
  sleep "$INTERVAL_SEC"
done

echo "wait_control_plane_ready: timeout_sec=${TIMEOUT_SEC}" >&2
exit 1
