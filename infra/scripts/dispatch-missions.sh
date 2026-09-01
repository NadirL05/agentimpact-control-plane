#!/usr/bin/env bash
# Poll les missions pending dont l'action liee vient d'etre approuvee, et les
# dispatche. Tourne en cron toutes les 2 minutes (voir crontab).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pending="$(
  "${SCRIPT_DIR}/cp-api.sh" hermes GET "/missions?status=pending&limit=50"
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
    CP_API_STATUS=1 "${SCRIPT_DIR}/cp-api.sh" hermes POST "/missions/${mission_id}/dispatch"
  )"
  status="$(printf '%s' "$response" | tail -n1)"
  body="$(printf '%s' "$response" | sed '$d')"
  echo "mission ${mission_id}: HTTP ${status} ${body}"
done
