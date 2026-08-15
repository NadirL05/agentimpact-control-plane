#!/usr/bin/env bash
set -euo pipefail

: "${DB_PASSWORD:?DB_PASSWORD not set}"
: "${DB_USER:=agentimpact_app}"
: "${DB_NAME:=agentimpact}"
: "${FULLENRICH_API_KEY:?FULLENRICH_API_KEY not set}"
: "${FULLENRICH_BASE_URL:=https://app.fullenrich.com/api/v2}"
: "${FULLENRICH_WEBHOOK_URL:?FULLENRICH_WEBHOOK_URL not set}"

LEAD_ID="${1:?Usage: enrich-leads-fullenrich.sh <lead_uuid>}"
DRY_RUN="${2:-false}"

row="$(
  docker exec -e PGPASSWORD="$DB_PASSWORD" agentimpact-db \
    psql -U "$DB_USER" -d "$DB_NAME" -At -F '|' -c "
      SELECT
        id,
        COALESCE(contact_name, ''),
        COALESCE(company_name, ''),
        regexp_replace(COALESCE(website, ''), '^https?://(www\.)?', ''),
        COALESCE(linkedin_url, ''),
        COALESCE(fullenrich_status, '')
      FROM leads
      WHERE id = '$LEAD_ID';
    "
)"

[ -n "$row" ] || { echo "Lead not found"; exit 1; }

IFS='|' read -r id contact_name company_name domain linkedin_url fullenrich_status <<< "$row"

contact_name="$(printf '%s' "$contact_name" | xargs)"
company_name="$(printf '%s' "$company_name" | xargs)"
domain="$(printf '%s' "$domain" | xargs)"
linkedin_url="$(printf '%s' "$linkedin_url" | xargs)"
fullenrich_status="$(printf '%s' "$fullenrich_status" | xargs)"

if [ "$fullenrich_status" = "completed" ]; then
  echo "SKIP: Lead already enriched (status=completed)"
  exit 0
fi

read -r first_name last_name _ <<< "$contact_name"

if [ -z "$linkedin_url" ] && { [ -z "$first_name" ] || [ -z "$last_name" ]; }; then
  echo "BLOCKED: FullEnrich requires first_name + last_name + domain/company_name, or linkedin_url."
  exit 2
fi

payload="$(
  jq -n \
    --arg name "agentimpact-$id" \
    --arg webhook_url "$FULLENRICH_WEBHOOK_URL" \
    --arg first_name "$first_name" \
    --arg last_name "$last_name" \
    --arg domain "$domain" \
    --arg company_name "$company_name" \
    --arg linkedin_url "$linkedin_url" \
    --arg user_id "$id" \
    '{
      name: $name,
      webhook_url: $webhook_url,
      webhook_events: {
        contact_finished: $webhook_url
      },
      data: [{
        first_name: $first_name,
        last_name: $last_name,
        domain: $domain,
        company_name: $company_name,
        linkedin_url: $linkedin_url,
        enrich_fields: [
          "contact.work_emails",
          "contact.personal_emails",
          "contact.phones"
        ],
        custom: { user_id: $user_id }
      }]
    }'
)"

if [ "$DRY_RUN" = "true" ]; then
  echo "DRY_RUN payload:"
  echo "$payload"
  exit 0
fi

docker exec -e PGPASSWORD="$DB_PASSWORD" agentimpact-db \
  psql -U "$DB_USER" -d "$DB_NAME" -c "
    UPDATE leads
    SET
      fullenrich_status = 'pending',
      fullenrich_started_at = NOW(),
      fullenrich_error = NULL
    WHERE id = '$LEAD_ID';
  "

response="$(
  curl --fail-with-body --silent --show-error \
    -X POST "${FULLENRICH_BASE_URL}/contact/enrich/bulk" \
    -H "Authorization: Bearer ${FULLENRICH_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$payload"
)"

enrichment_id="$(printf '%s' "$response" | jq -r '.enrichment_id // empty')"

if [ -z "$enrichment_id" ]; then
  echo "ERROR: FullEnrich did not return enrichment_id"
  printf '%s\n' "$response"

  docker exec -e PGPASSWORD="$DB_PASSWORD" agentimpact-db \
    psql -U "$DB_USER" -d "$DB_NAME" -c "
      UPDATE leads
      SET
        fullenrich_status = 'failed',
        fullenrich_error = 'no_enrichment_id'
      WHERE id = '$LEAD_ID';
    "
  exit 1
fi

docker exec -e PGPASSWORD="$DB_PASSWORD" agentimpact-db \
  psql -U "$DB_USER" -d "$DB_NAME" -c "
    UPDATE leads
    SET
      fullenrich_enrichment_id = '$enrichment_id',
      fullenrich_last_response = jsonb_build_object('enrichment_id', '$enrichment_id')
    WHERE id = '$LEAD_ID';
  "

echo "OK: enrichment_id=$enrichment_id"
