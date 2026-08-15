#!/usr/bin/env bash
# Consomme UNE mission in_progress ciblant dev-senior et la fait executer par
# Hermes (profil agentimpact-dev), dans son terminal Docker sandboxe.
#
# Isolation reelle : flock empeche deux instances concurrentes ; la branche
# main est protegee cote GitHub (required PR + enforce_admins), donc meme un
# agent qui tente un push direct est rejete par GitHub lui-meme, pas par une
# convention qu'on espere respectee.
#
# Tourne en cron toutes les 3 minutes. Le -z est one-shot : Hermes s'arrete
# une fois la reponse produite, pas de session qui traine.

set -uo pipefail

API="${AGENTIMPACT_API_BASE:-http://localhost:3000}"
LOCK=/tmp/agentimpact-dev-mission.lock
HERMES="/usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main"
PROFILES_DIR=/opt/agentimpact/profiles

exec 9>"$LOCK"
flock -n 9 || { echo "deja en cours, skip"; exit 0; }

mission="$(
  curl --silent --show-error --max-time 15 \
    "${API}/missions?target_agent=dev-senior&status=in_progress&limit=1"
)"

MISSION_ID="$(printf '%s' "$mission" | python3 -c "
import sys, json
items = json.load(sys.stdin).get('items', [])
print(items[0]['id'] if items else '')
")"

[ -z "$MISSION_ID" ] && { echo "aucune mission en attente"; exit 0; }

TITLE="$(printf '%s' "$mission" | python3 -c "import sys,json;print(json.load(sys.stdin)['items'][0]['title'])")"
PAYLOAD="$(printf '%s' "$mission" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['items'][0]['payload']))")"
SOURCE_URL="$(printf '%s' "$mission" | python3 -c "import sys,json;print(json.load(sys.stdin)['items'][0].get('source_url') or '')")"

echo "mission ${MISSION_ID}: ${TITLE}"

PROMPT="$(cat <<PROMPT
Mission assignee via le control plane AgentImpact (id ${MISSION_ID}).

Titre : ${TITLE}
Contexte : ${PAYLOAD}
${SOURCE_URL:+Source : $SOURCE_URL}

Regles strictes, non negociables :
- Travaille sur une branche dediee, jamais sur main. GitHub refuse de toute
  facon tout push direct sur main (branche protegee, PR obligatoire, CI
  obligatoire) : ce n'est pas une consigne a suivre, c'est technique.
- Ouvre une pull request en fin de travail. Ne la merge jamais toi-meme.
- Chaque changement de comportement doit venir avec un test qui le prouve.
- N'invente aucune donnee ni credential. Si une information manque pour
  avancer, ecris-le clairement dans la PR plutot que de deviner.
- Poste un message Slack court a la fin (URL de la PR ou blocage rencontre).
PROMPT
)"

# run-with-profile.sh a deja resolu et exporte HERMES_PROFILE en chemin
# absolu : ne surtout pas le re-ecraser ici avec le nom nu, ca ferait
# retomber Hermes sur ~/.hermes/config.yaml sans le moindre avertissement.
OUTPUT="$(
  sudo -u hermes /opt/agentimpact/scripts/run-with-profile.sh agentimpact-dev \
    $HERMES -z "$PROMPT" 2>&1
)" || true

# "completed" exige une preuve verifiable (URL de PR), pas juste l'absence
# du mot "error" dans le texte : un agent bloque peut rediger un resume propre
# sans avoir rien livre.
STATUS="failed"
printf '%s' "$OUTPUT" | grep -qE "github\.com/[^ ]+/pull/[0-9]+" && STATUS="completed"

RESULT_JSON="$(python3 -c "
import json, sys
print(json.dumps({'status': sys.argv[1], 'result': {'summary': sys.argv[2][:4000]}}))
" "$STATUS" "$OUTPUT")"

curl --silent --show-error --max-time 15 \
  -X PATCH "${API}/missions/${MISSION_ID}/result" \
  -H 'Content-Type: application/json' \
  -d "$RESULT_JSON" >/dev/null

echo "mission ${MISSION_ID}: ${STATUS}"
