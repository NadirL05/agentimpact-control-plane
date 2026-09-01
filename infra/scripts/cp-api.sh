#!/usr/bin/env bash
# Client HTTP authentifié vers le control plane AgentImpact.
#
# Usage:
#   cp-api.sh <role> <method> <path> [body_file]
#
# Rôles : hermes | bridge | admin
# Charge le token depuis /etc/agentimpact/tokens/<role>.env (jamais accessible au runner).

set -euo pipefail

ROLE="${1:?role requis (hermes|bridge|admin)}"
METHOD="${2:?method HTTP requis}"
PATH_URL="${3:?chemin API requis (ex: /health)}"
BODY_FILE="${4:-}"

case "$ROLE" in
  hermes|bridge|admin) ;;
  *)
    echo '{"error":"invalid_role"}' >&2
    exit 64
    ;;
esac

ENV_FILE="/etc/agentimpact/tokens/${ROLE}.env"
TOKEN_VAR="CTL_${ROLE^^}_TOKEN"

if [ -z "${!TOKEN_VAR:-}" ]; then
  if [ ! -r "$ENV_FILE" ]; then
    echo '{"error":"token_file_unreadable"}' >&2
    exit 77
  fi
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

TOKEN="${!TOKEN_VAR:-}"
if [ -z "$TOKEN" ]; then
  echo '{"error":"token_missing_in_env_file"}' >&2
  exit 78
fi

API="${AGENTIMPACT_API_BASE:?AGENTIMPACT_API_BASE requis — pas de fallback implicite}"
URL="${API}${PATH_URL}"

CURL_ARGS=(--silent --show-error --max-time 20 -X "$METHOD" -H "Authorization: Bearer ${TOKEN}")

if [ -n "$BODY_FILE" ]; then
  CURL_ARGS+=(-H 'Content-Type: application/json' -d @"$BODY_FILE")
fi

if [ "${CP_API_STATUS:-}" = "1" ]; then
  curl "${CURL_ARGS[@]}" -w '\n%{http_code}' "$URL"
else
  curl "${CURL_ARGS[@]}" "$URL"
fi
