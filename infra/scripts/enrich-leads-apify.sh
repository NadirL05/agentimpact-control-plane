#!/usr/bin/env bash
set -euo pipefail

: "${APIFY_API_TOKEN:?APIFY_API_TOKEN not set}"
: "${DB_PASSWORD:?DB_PASSWORD not set}"
: "${DB_USER:=agentimpact_app}"
: "${DB_NAME:=agentimpact}"

LIMIT="${1:-1}"

LEADS=$(
  docker exec -e PGPASSWORD="$DB_PASSWORD" agentimpact-db \
    psql -U "$DB_USER" -d "$DB_NAME" -At -F '|' -c \
    "SELECT id, company_name, COALESCE(website, ''), COALESCE(contact_name, '')
     FROM leads
     WHERE enrichment_status = 'pending'
     ORDER BY created_at ASC
     LIMIT ${LIMIT};"
)

if [ -z "$LEADS" ]; then
  echo "No pending leads to enrich."
  exit 0
fi

printf '%s\n' "$LEADS" | while IFS='|' read -r lead_id company_name website contact_name; do
  lead_id="$(printf '%s' "$lead_id" | xargs)"
  company_name="$(printf '%s' "$company_name" | xargs)"
  website="$(printf '%s' "$website" | xargs)"
  contact_name="$(printf '%s' "$contact_name" | xargs)"

  [ -n "$lead_id" ] || continue
  echo "Dry-run candidate: $lead_id | $company_name | $website | $contact_name"
done
