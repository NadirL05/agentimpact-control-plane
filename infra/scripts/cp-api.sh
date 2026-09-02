#!/usr/bin/env bash
# Client HTTP authentifié vers le control plane AgentImpact.
#
# Usage:
#   cp-api.sh <role> <method> <path> [body_file]
#
# Rôles : hermes | bridge | admin
# Charge le token depuis /etc/agentimpact/tokens/<role>.env (jamais accessible au runner).
# Le token n'apparaît jamais dans argv (curl --config, fichier 0600).

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

CURL_CFG="$(mktemp)"
chmod 600 "$CURL_CFG"
cleanup() {
  rm -f "$CURL_CFG"
}
trap cleanup EXIT

{
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"
  echo 'header = "Accept: application/json"'
  printf 'request = "%s"\n' "$METHOD"
  printf 'url = "%s"\n' "$URL"
} >"$CURL_CFG"

if [ -n "$BODY_FILE" ]; then
  {
    echo 'header = "Content-Type: application/json"'
    printf 'data = "@%s"\n' "$BODY_FILE"
  } >>"$CURL_CFG"
fi

if [ "${CP_API_STATUS:-}" = "1" ]; then
  curl --silent --show-error --max-time 20 --config "$CURL_CFG" -w '\n%{http_code}'
else
  curl --silent --show-error --max-time 20 --config "$CURL_CFG"
fi
