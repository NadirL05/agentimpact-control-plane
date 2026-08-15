#!/usr/bin/env bash
set -euo pipefail

: "${DB_PASSWORD:?DB_PASSWORD not set}"
: "${DB_USER:=agentimpact_app}"
: "${DB_NAME:=agentimpact}"

LEAD_ID="${1:?Usage: dry-run-fullenrich.sh <lead_uuid>}"

row="$(
  docker exec -e PGPASSWORD="$DB_PASSWORD" agentimpact-db \
    psql -U "$DB_USER" -d "$DB_NAME" -At -F '|' -c "
      SELECT
        id,
        COALESCE(contact_name, ''),
        COALESCE(company_name, ''),
        regexp_replace(COALESCE(website, ''), '^https?://(www\.)?', ''),
        COALESCE(linkedin_url, '')
      FROM leads
      WHERE id = '$LEAD_ID';
    "
)"

[ -n "$row" ] || { echo "Lead not found"; exit 1; }

IFS='|' read -r id contact_name company_name domain linkedin_url <<< "$row"

contact_name="$(printf '%s' "$contact_name" | xargs)"
company_name="$(printf '%s' "$company_name" | xargs)"
domain="$(printf '%s' "$domain" | xargs)"
linkedin_url="$(printf '%s' "$linkedin_url" | xargs)"

read -r first_name last_name _ <<< "$contact_name"

if [ -z "$linkedin_url" ] && { [ -z "$first_name" ] || [ -z "$last_name" ]; }; then
  echo "BLOCKED: FullEnrich requires first_name + last_name + domain/company_name, or linkedin_url."
  echo "Lead: $company_name"
  echo "Domain: $domain"
  exit 2
fi

jq -n \
  --arg name "agentimpact-dry-run-$id" \
  --arg first_name "$first_name" \
  --arg last_name "$last_name" \
  --arg domain "$domain" \
  --arg company_name "$company_name" \
  --arg linkedin_url "$linkedin_url" \
  --arg user_id "$id" \
  '{
    name: $name,
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
