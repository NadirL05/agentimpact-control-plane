#!/usr/bin/env bash
# Poll les missions pending dont l'action liee vient d'etre approuvee, et les
# dispatche. Tourne en cron toutes les 2 minutes (voir crontab).
#
# Ne declenche jamais un agent directement : POST /:id/dispatch revalide
# cote API (canDispatch) que l'action est bien approuvee avant de faire quoi
# que ce soit. Ce script est un simple minuteur, pas une autorite.

set -euo pipefail

API="${AGENTIMPACT_API_BASE:-http://localhost:3000}"

pending="$(
  curl --silent --show-error --max-time 15 "${API}/missions?status=pending&limit=50"
)"

echo "$pending" | python3 -c "
import json, sys
data = json.load(sys.stdin)
approved = [m for m in data.get('items', []) if m.get('action_status') == 'approved']
for m in approved:
    print(m['id'])
" | while read -r mission_id; do
  [ -z "$mission_id" ] && continue
  response="$(
    curl --silent --show-error --max-time 15 -w '\n%{http_code}' \
      -X POST "${API}/missions/${mission_id}/dispatch"
  )"
  status="$(printf '%s' "$response" | tail -n1)"
  body="$(printf '%s' "$response" | sed '$d')"
  echo "mission ${mission_id}: HTTP ${status} ${body}"
done
