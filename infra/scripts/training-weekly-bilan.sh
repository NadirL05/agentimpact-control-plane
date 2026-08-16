#!/usr/bin/env bash
# Bilan hebdo sport (vendredi 17h UTC) — remigre depuis l'orchestrateur legacy.
set -euo pipefail

API="${AGENTIMPACT_API_BASE:-http://localhost:3000}"
TOKEN="$(grep SLACK_BOT_TOKEN /opt/agentimpact/.env | cut -d= -f2)"
CHANNEL="$(grep SLACK_HOME_CHANNEL /opt/agentimpact/.env | cut -d= -f2)"

TEXT="$(
  curl --silent --show-error --max-time 15 "${API}/api/training/week" | python3 -c "
import json, sys
data = json.load(sys.stdin)
items = data.get('items', [])
if not items:
    print('📊 Bilan sport de la semaine : aucune séance loggée. Log ici : https://api.agentimpact.fr/training')
    sys.exit(0)

labels = {'upper_a': 'Upper A', 'lower_a': 'Lower A', 'upper_b': 'Upper B', 'lower_b': 'Lower B'}
lines = [f'📊 Bilan sport de la semaine — {len(items)} séance(s) :']
for it in items:
    date = it['session_date'][:10]
    label = labels.get(it['day_type'], it['day_type'])
    n = len(it.get('exercises') or [])
    lines.append(f'• {date} — {label} ({n} exercices)')
print(chr(10).join(lines))
"
)"

python3 -c "
import json, sys
print(json.dumps({'channel': sys.argv[1], 'text': sys.argv[2]}))
" "${CHANNEL}" "${TEXT}" | curl --silent --show-error --max-time 15 -X POST "https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d @- > /dev/null
