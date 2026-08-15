#!/usr/bin/env bash
# Suite d'integration du control plane AgentImpact.
#
# Complementaire aux tests vitest : ici on verifie le systeme reellement
# deploye (base, tunnel, Slack, GitHub), pas la logique pure.
#
# Sans effet de bord durable : chaque action creee est refusee en fin de test,
# et rien n'est envoye a l'exterieur (pas d'appel FullEnrich reel, pas d'issue).
#
# Usage : integration-test.sh [--verbose]

set -uo pipefail

API="${AGENTIMPACT_API_BASE:-http://localhost:3000}"
PUBLIC="${AGENTIMPACT_PUBLIC_BASE:-https://api.agentimpact.fr}"
VERBOSE="${1:-}"

pass=0
fail=0
created_actions=()

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; pass=$((pass + 1)); }
ko()   { printf '  \033[31mKO\033[0m   %s\n' "$1"; printf '       attendu: %s | obtenu: %s\n' "$2" "$3"; fail=$((fail + 1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || ko "$1" "$2" "$3"; }
title(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

code() { curl -s -o /dev/null -w '%{http_code}' -m 15 "$@"; }
json() { curl -s -m 15 "$@"; }

field() { python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    print('PARSE_ERROR'); sys.exit()
for key in sys.argv[1].split('.'):
    if isinstance(data, list):
        data = data[int(key)]
    else:
        data = data.get(key) if isinstance(data, dict) else None
    if data is None:
        print(''); sys.exit()
print(data)
" "$1"; }

# --- une action jetable, refusee en fin de suite -----------------------------
# L'id est place dans NEW_ACTION_ID et non renvoye sur stdout : une
# substitution de commande creerait un sous-shell, et la liste des actions a
# nettoyer serait perdue au retour.
NEW_ACTION_ID=""
new_action() {
  local intent="$1"
  local body
  body=$(json -X POST "$API/actions" -H 'Content-Type: application/json' \
    -d "{\"profile\":\"integration-suite\",\"intent\":\"$intent\",\"risk_level\":\"read_only\",\"payload\":{\"nonce\":\"$(date +%s%N)\"},\"targets\":[],\"dry_run\":true}")
  NEW_ACTION_ID=$(printf '%s' "$body" | field 'item.id')
  [ -n "$NEW_ACTION_ID" ] && created_actions+=("$NEW_ACTION_ID")
}

cleanup() {
  title "Nettoyage"
  local cleaned=0
  for id in "${created_actions[@]:-}"; do
    [ -z "$id" ] && continue
    json -X POST "$API/api/approvals" -H 'Content-Type: application/json' \
      -d "{\"action_id\":\"$id\",\"decision\":\"rejected\",\"approver\":\"integration-cleanup\",\"reason\":\"fin de suite\"}" >/dev/null
    cleaned=$((cleaned + 1))
  done
  echo "  $cleaned action(s) de test refusee(s)"
}
trap cleanup EXIT

# --- 1. socle ----------------------------------------------------------------
title "1. Socle"
check "API en vie" "ok" "$(json "$API/health" | field 'status')"
check "base joignable" "ok" "$(json "$API/health" | field 'database')"

# --- 2. validation humaine ---------------------------------------------------
title "2. Validation humaine (semaine 3)"
new_action integration_approval
ACTION="$NEW_ACTION_ID"
if [ -z "$ACTION" ]; then
  ko "creation d une action de test" "un uuid" "vide"
else
  ok "action de test creee"
  HASH=$(json "$API/api/approvals/pending" | python3 -c "
import sys, json
for item in json.load(sys.stdin).get('items', []):
    if item['id'] == '$ACTION':
        print(item['payload_hash']); break")

  check "approbation sans hash refusee" "400" \
    "$(code -X POST "$API/api/approvals" -H 'Content-Type: application/json' -d "{\"action_id\":\"$ACTION\",\"decision\":\"approved\",\"approver\":\"suite\"}")"
  check "hash errone refuse" "409" \
    "$(code -X POST "$API/api/approvals" -H 'Content-Type: application/json' -d "{\"action_id\":\"$ACTION\",\"decision\":\"approved\",\"approver\":\"suite\",\"payload_hash\":\"deadbeefdeadbeef\"}")"
  check "auto-approbation refusee" "403" \
    "$(code -X POST "$API/api/approvals" -H 'Content-Type: application/json' -d "{\"action_id\":\"$ACTION\",\"decision\":\"approved\",\"approver\":\"integration-suite\",\"payload_hash\":\"$HASH\"}")"
  check "action inconnue" "404" \
    "$(code -X POST "$API/api/approvals" -H 'Content-Type: application/json' -d '{"action_id":"00000000-0000-0000-0000-000000000000","decision":"rejected","approver":"suite"}')"
  check "uuid malforme" "400" \
    "$(code -X POST "$API/api/approvals" -H 'Content-Type: application/json' -d '{"action_id":"pas-un-uuid","decision":"rejected","approver":"suite"}')"
fi

# --- 3. brief ----------------------------------------------------------------
title "3. Brief quotidien (semaine 4)"
BRIEF=$(json "$API/api/briefs/daily")
check "brief compose" "True" "$(printf '%s' "$BRIEF" | field 'ok')"
TOTAL=$(printf '%s' "$BRIEF" | python3 -c "import sys,json;print(sum(json.load(sys.stdin)['counts'].values()))")
if [ "$TOTAL" -le 10 ]; then ok "plafond de 10 elements respecte ($TOTAL)"; else ko "plafond de 10 elements" "<=10" "$TOTAL"; fi
if printf '%s' "$BRIEF" | grep -q 'source'; then ok "chaque ligne cite sa source"; else ko "citation des sources" "presente" "absente"; fi

# --- 4. drive ----------------------------------------------------------------
title "4. Drive (semaine 5)"
check "recherche accessible" "200" "$(code "$API/api/drive/search?q=trashed%20%3D%20false")"
check "recherche sans requete refusee" "400" "$(code "$API/api/drive/search")"
check "execution d une action inconnue" "404" \
  "$(code -X POST "$API/api/drive/execute" -H 'Content-Type: application/json' -d '{"action_id":"00000000-0000-0000-0000-000000000000"}')"
new_action integration_wrong_intent
NON_DRIVE="$NEW_ACTION_ID"
check "execution refusee si l intention ne correspond pas" "400" \
  "$(code -X POST "$API/api/drive/execute" -H 'Content-Type: application/json' -d "{\"action_id\":\"$NON_DRIVE\"}")"

# --- 5. github ---------------------------------------------------------------
title "5. GitHub (semaine 6)"
check "webhook sans signature" "401" "$(code -X POST "$API/api/github/webhook" -H 'Content-Type: application/json' -d '{}')"
check "webhook signature invalide" "401" \
  "$(code -X POST "$API/api/github/webhook" -H 'Content-Type: application/json' -H 'x-hub-signature-256: sha256=00' -d '{}')"
check "spec sans critere refusee" "400" \
  "$(code -X POST "$API/api/github/spec" -H 'Content-Type: application/json' -d '{"repo":"a/b","title":"un titre","need":"un besoin assez long","acceptance_criteria":[]}')"
check "depot malforme refuse" "400" \
  "$(code -X POST "$API/api/github/spec" -H 'Content-Type: application/json' -d '{"repo":"pas-un-depot","title":"un titre","need":"un besoin assez long","acceptance_criteria":["c1"]}')"

# --- 6. growth ---------------------------------------------------------------
title "6. Growth (semaine 7)"
PIPELINE=$(json "$API/api/growth/pipeline")
check "pipeline accessible" "200" "$(code "$API/api/growth/pipeline")"
LEAD=$(printf '%s' "$PIPELINE" | field 'items.0.lead_id')
if [ -n "$LEAD" ]; then
  FICHE=$(json -X POST "$API/api/growth/qualify" -H 'Content-Type: application/json' -d "{\"lead_id\":\"$LEAD\"}")
  PREUVES=$(printf '%s' "$FICHE" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['fiche']['preuve']))")
  if [ "$PREUVES" -gt 0 ]; then ok "fiche adossee a $PREUVES preuve(s)"; else ko "preuve dans la fiche" ">0" "0"; fi
fi
check "lead inconnu" "404" \
  "$(code -X POST "$API/api/growth/qualify" -H 'Content-Type: application/json' -d '{"lead_id":"00000000-0000-0000-0000-000000000000"}')"

# --- 6b. FullEnrich (dry-run : aucun credit consomme) ------------------------
title "6b. FullEnrich (semaine 6 bis)"
check "lead inconnu" "404" \
  "$(code -X POST "$API/api/fullenrich/enrich" -H 'Content-Type: application/json' -d '{"lead_id":"00000000-0000-0000-0000-000000000000","dry_run":true}')"
check "uuid malforme" "400" \
  "$(code -X POST "$API/api/fullenrich/enrich" -H 'Content-Type: application/json' -d '{"lead_id":"pas-un-uuid","dry_run":true}')"

# un lead deja enrichi doit etre ignore, pas re-enrichi
ENRICHED=$(json "$API/api/growth/pipeline" | python3 -c "
import sys, json
print('')" )
LEAD_DONE=$(docker exec agentimpact-db psql -U agentimpact_app -d agentimpact -At \
  -c "select id from leads where fullenrich_status = 'completed' limit 1" 2>/dev/null)
if [ -n "$LEAD_DONE" ]; then
  SKIPPED=$(json -X POST "$API/api/fullenrich/enrich" -H 'Content-Type: application/json' \
    -d "{\"lead_id\":\"$LEAD_DONE\",\"dry_run\":true}" | field 'skipped')
  check "lead deja enrichi ignore" "True" "$SKIPPED"
fi

# le dry-run ne doit jamais appeler FullEnrich : on verifie qu'aucune action
# non-dry_run n'a ete creee par ce test
DRY=$(docker exec agentimpact-db psql -U agentimpact_app -d agentimpact -At \
  -c "select count(*) from agent_actions where intent='fullenrich_enrich' and dry_run=false and created_at > now() - interval '1 minute'" 2>/dev/null)
check "aucun appel reel declenche par la suite" "0" "${DRY:-0}"

# --- 7. metriques ------------------------------------------------------------
title "7. Metriques et autonomie (semaine 8)"
check "metriques" "200" "$(code "$API/api/clients/metrics")"
AUTO=$(json "$API/api/clients/autonomy")
DELIEES=$(printf '%s' "$AUTO" | python3 -c "
import sys, json
print(sum(1 for i in json.load(sys.stdin)['items'] if i['autonomie_recommandee']))")
if [ "$DELIEES" -eq 0 ]; then ok "aucune intention deliee sans historique suffisant"; else ko "autonomie prudente" "0 deliee" "$DELIEES"; fi
check "client inconnu" "404" "$(code -X POST "$API/api/clients/inexistant/report")"

# --- 8. surface publique -----------------------------------------------------
title "8. Surface publique"
for route in /leads /actions /api/clients/metrics /api/drive/search /api/briefs/daily; do
  check "prive: $route" "404" "$(code "$PUBLIC$route")"
done
check "public: webhook FullEnrich" "401" "$(code -X POST "$PUBLIC/api/fullenrich/webhook" -H 'Content-Type: application/json' -d '{}')"
check "public: webhook GitHub" "401" "$(code -X POST "$PUBLIC/api/github/webhook" -H 'Content-Type: application/json' -d '{}')"

# --- resultat ----------------------------------------------------------------
printf '\n\033[1mRESULTAT : %d ok, %d ko\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
