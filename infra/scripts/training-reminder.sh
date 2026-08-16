#!/usr/bin/env bash
# Rappel sport quotidien (lun/mar/jeu/ven 7h UTC) — remigre depuis
# l'orchestrateur legacy. Poste direct sur #tous-agentimpact.
set -euo pipefail

DAY="$(date -u +%u)"  # 1=lundi ... 7=dimanche
declare -A LABELS=( [1]="Upper A" [2]="Lower A" [4]="Upper B" [5]="Lower B" )
LABEL="${LABELS[$DAY]:-}"
[ -z "$LABEL" ] && exit 0

TOKEN="$(grep SLACK_BOT_TOKEN /opt/agentimpact/.env | cut -d= -f2)"
CHANNEL="$(grep SLACK_HOME_CHANNEL /opt/agentimpact/.env | cut -d= -f2)"

curl --silent --show-error --max-time 15 -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d "$(python3 -c "
import json
print(json.dumps({
    'channel': '${CHANNEL}',
    'text': '💪 Séance du jour : *${LABEL}* — log ici : https://api.agentimpact.fr/training',
}))
")" > /dev/null
