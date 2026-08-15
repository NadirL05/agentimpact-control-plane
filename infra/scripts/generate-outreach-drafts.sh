#!/bin/bash
# Générer des brouillons d'outreach pour les leads à contacter

# Secret charge depuis /opt/agentimpact/.env (jamais en dur dans le code).
[ -f /opt/agentimpact/.env ] && . /opt/agentimpact/.env
: "${DB_PASSWORD:?DB_PASSWORD manquant dans /opt/agentimpact/.env}"
DB_USER='agentimpact_app'
DB_NAME='agentimpact'

echo "📝 Generating outreach drafts..."

# Récupérer les leads à contacter
LEADS=$(docker exec -e PGPASSWORD="$DB_PASSWORD" \
  agentimpact-db psql -U "$DB_USER" -d "$DB_NAME" -t -c \
  "SELECT id, company_name, COALESCE(email, 'contact@company.com') FROM leads WHERE status IN ('new', 'qualified') ORDER BY created_at DESC LIMIT 5;")

# Pour chaque lead, créer un brouillon
echo "$LEADS" | while IFS='|' read -r lead_id company_name email; do
  # Nettoyer les variables
  company_name=$(echo "$company_name" | xargs)
  email=$(echo "$email" | xargs)
  
  if [ -z "$lead_id" ]; then
    continue
  fi
  
  echo "  → $company_name ($email)"
  
  # Créer un brouillon email
  docker exec -e PGPASSWORD="$DB_PASSWORD" \
    agentimpact-db psql -U "$DB_USER" -d "$DB_NAME" \
    -c "INSERT INTO outreach_drafts (lead_id, channel, subject, body, status) VALUES (
      '$lead_id',
      'email',
      'Optimisation de vos workflows ERP chez $company_name',
      'Bonjour,

J''ai remarqué que $company_name est en pleine croissance.

On aide les entreprises comme la vôtre à optimiser leurs workflows ERP avec l''IA et le DevOps.

Seriez-vous ouvert à un échange de 15 minutes ?

Bien à vous,
L''équipe AgentImpact',
      'draft'
    );" 2>/dev/null || true
done

echo "✅ Drafts generated!"

# Afficher les brouillons créés
echo ""
echo "📋 All drafts:"
docker exec -e PGPASSWORD="$DB_PASSWORD" \
  agentimpact-db psql -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT od.id, l.company_name, od.channel, od.status FROM outreach_drafts od JOIN leads l ON od.lead_id = l.id ORDER BY od.created_at DESC;"
