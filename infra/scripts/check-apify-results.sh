#!/bin/bash
# Récupérer les résultats Apify et mettre à jour la DB

APIFY_API_TOKEN="${APIFY_API_TOKEN:-}"
# Secret charge depuis /opt/agentimpact/.env (jamais en dur dans le code).
[ -f /opt/agentimpact/.env ] && . /opt/agentimpact/.env
: "${DB_PASSWORD:?DB_PASSWORD manquant dans /opt/agentimpact/.env}"
if [ -z "$APIFY_API_TOKEN" ]; then
  echo "❌ APIFY_API_TOKEN not set!"
  exit 1
fi

echo "📥 Fetching Apify results..."

# Récupérer les leads avec un run_id
LEADS=$(docker exec -e PGPASSWORD="$DB_PASSWORD" \
  agentimpact-db psql -U agentimpact_app -d agentimpact -t -c \
  "SELECT id, company_name, apify_run_id FROM leads WHERE apify_run_id IS NOT NULL AND enrichment_status = 'enriching';")

if [ -z "$(echo "$LEADS" | tr -d '[:space:]')" ]; then
  echo "✅ No pending enrichment results!"
  exit 0
fi

echo "📝 Leads to check:"
echo "$LEADS"
echo ""

echo "$LEADS" | while IFS='|' read -r lead_id company_name run_id; do
  company_name=$(echo "$company_name" | xargs)
  
  if [ -z "$run_id" ]; then
    continue
  fi
  
  echo "  → $company_name (run: $run_id)"
  
  # Vérifier le statut du run
  RUN_STATUS=$(curl -s \
    "https://api.apify.com/v2/actor-runs/$run_id" \
    -H "Authorization: Bearer $APIFY_API_TOKEN" | jq -r '.data.status')
  
  echo "     Status: $RUN_STATUS"
  
  if [ "$RUN_STATUS" != "SUCCEEDED" ]; then
    echo "     ⏳ Still running, skipping..."
    continue
  fi
  
  # Récupérer les résultats
  RESULTS=$(curl -s \
    "https://api.apify.com/v2/actor-runs/$run_id/dataset/items" \
    -H "Authorization: Bearer $APIFY_API_TOKEN")
  
  if [ -z "$RESULTS" ] || [ "$RESULTS" == "[]" ]; then
    echo "     ❌ No results found"
    docker exec -e PGPASSWORD="$DB_PASSWORD" \
      agentimpact-db psql -U agentimpact_app -d agentimpact \
      -c "UPDATE leads SET enrichment_status = 'failed' WHERE id = '$lead_id';"
    continue
  fi
  
  # Extraire les données pertinentes
  ENRICHED_DATA=$(echo "$RESULTS" | jq '.[0]')
  
  # Sauvegarder dans la DB (échapper les quotes)
  ENRICHED_JSON=$(echo "$ENRICHED_DATA" | jq -c . | sed "s/'/''/g")
  
  docker exec -e PGPASSWORD="$DB_PASSWORD" \
    agentimpact-db psql -U agentimpact_app -d agentimpact \
    -c "UPDATE leads SET enriched_data = '$ENRICHED_JSON', enrichment_status = 'enriched', last_enriched_at = CURRENT_TIMESTAMP WHERE id = '$lead_id';"
  
  echo "     ✅ Enriched!"
done

echo ""
echo "✅ Done!"
