#!/usr/bin/env bash
# Declenche un enrichissement FullEnrich via le control plane AgentImpact.
#
# Contrairement a enrich-leads-fullenrich.sh (qui fait `docker exec ... psql` et
# ne tourne que sur l'hote), ce script passe par l'API : meme chemin de code,
# meme audit dans agent_actions, utilisable par Hermes.
#
# Usage :
#   fullenrich-enrich.sh <lead_uuid> [--dry-run]
#
# Sortie : JSON brut de l'API.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "Usage: $(basename "$0") <lead_uuid> [--dry-run]" >&2
  exit 64
}

[ $# -ge 1 ] || usage

LEAD_ID="$1"
shift

DRY_RUN="false"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="true" ;;
    *) usage ;;
  esac
done

if ! [[ "$LEAD_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "{\"success\":false,\"error\":\"invalid_lead_uuid\"}" >&2
  exit 65
fi

body_file=$(mktemp)
printf '{"lead_id":"%s","dry_run":%s}' "$LEAD_ID" "$DRY_RUN" >"$body_file"
response="$(
  CP_API_STATUS=1 "${SCRIPT_DIR}/cp-api.sh" hermes POST "/api/fullenrich/enrich" "$body_file"
)"
rm -f "$body_file"

body="$(printf '%s' "$response" | sed '$d')"
status="$(printf '%s' "$response" | tail -n1)"

printf '%s\n' "$body"

# 2xx -> succes, sinon code de sortie non nul pour que l'appelant s'en apercoive.
[ "${status:0:1}" = "2" ] || exit 1
