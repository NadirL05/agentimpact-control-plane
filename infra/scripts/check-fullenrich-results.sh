#!/bin/bash
# Récupérer les résultats Full Enrich

FULLENRICH_API_KEY="${FULLENRICH_API_KEY:-}"
# Secret charge depuis /opt/agentimpact/.env (jamais en dur dans le code).
[ -f /opt/agentimpact/.env ] && . /opt/agentimpact/.env
: "${DB_PASSWORD:?DB_PASSWORD manquant dans /opt/agentimpact/.env}"
if [ -z "$FULLENRICH_API_KEY" ]; then
  echo "❌ FULLENRICH_API_KEY not set!"
  exit 1
fi

echo "📥 Fetching Full Enrich results..."

# Récupérer les leads en cours
LEADS=$(docker exec -e PGPASSWORD="$DB_PASSWORD" \
  agentimpact-db psql -U agentimpact_app -d agentimpact -t -c \
  "SELECT id, company_name, fullenrich_id FROM leads WHERE fullenrich_id IS NOT NULL AND fullenrich_status = 'enriching';")

if [ -z "$(echo "$LEADS" | tr -d '[:space:]')" ]; then
  echo "✅ No pending Full Enrich results!"
  exit 0
fi

echo "$LEADS" | while IFS='|' read -r lead_id company_name fe_id; do
  company_name=$(echo "$company_name" | xargs)
  
  if [ -z "$fe_id" ]; then
    continue
  fi
  
  echo "  → $company_name (id: $fe_id)"
  
  # Récupérer les résultats
  RESULTS=$(curl -s \
    "https://api.fullenrich.com/v1/enrich/$fe_id" \
    -H "Authorization: Bearer $FULLENRICH_API_KEY")
  
  STATUS=$(echo "$RESULTS" | jq -r '.status // "unknown"')
  
  echo "     Status: $STATUS"
  
  if [ "$STATUS" != "completed" ]; then
    echo "     ⏳ Still processing..."
    continue
  fi
  
  # Sauvegarder les données
  ENRICHED_DATA=$(echo "$RESULTS" | jq -c '.data // {}' | sed "s/'/''/g")
  
  docker exec -e PGPASSWORD="$DB_PASSWORD" \
    agentimpact-db psql -U agentimpact_app -d agentimpact \
    -c "UPDATE leads SET fullenrich_data = '$ENRICHED_DATA', fullenrich_status = 'enriched', fullenriched_at = CURRENT_TIMESTAMP WHERE id = '$lead_id';"
  
  echo "     ✅ Enriched!"
done

echo ""
echo "✅ Done!"
