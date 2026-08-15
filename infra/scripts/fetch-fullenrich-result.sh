#!/usr/bin/env bash
set -euo pipefail

: "${DB_PASSWORD:?DB_PASSWORD not set}"
: "${DB_USER:=agentimpact_app}"
: "${DB_NAME:=agentimpact}"
: "${FULLENRICH_API_KEY:?FULLENRICH_API_KEY not set}"
: "${FULLENRICH_BASE_URL:=https://app.fullenrich.com/api/v2}"

ENRICHMENT_ID="${1:?Usage: fetch-fullenrich-result.sh <enrichment_id>}"

response="$(
  curl -s -X GET "${FULLENRICH_BASE_URL}/bulk/${ENRICHMENT_ID}" \
    -H "Authorization: Bearer ${FULLENRICH_API_KEY}"
)"

echo "$response" | jq -c .
