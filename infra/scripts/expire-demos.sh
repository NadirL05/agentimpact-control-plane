#!/usr/bin/env bash
# Supprime les demos expires, sauf si une reponse du lead a ete loggee
# (table conversations) depuis la creation du demo — un lead qui repond
# n'est jamais coupe silencieusement.

set -euo pipefail

A="${AGENTIMPACT_API_BASE:-http://localhost:3000}"
DEMOS_ROOT=/opt/agentimpact/demos

curl --silent --show-error --max-time 15 "${A}/api/demos" | python3 -c "
import json, sys
data = json.load(sys.stdin)
now_expired = []
for item in data.get('items', []):
    if item['status'] == 'live':
        print(item['slug'])
" | while read -r slug; do
  [ -z "$slug" ] && continue

  # Deleguer la decision (expire / a une reponse / prolonger) a l API,
  # qui seule connait le lien demo <-> lead <-> conversations.
  curl --silent --show-error --max-time 15 -X POST "${A}/api/demos/${slug}/check-expiry" \
    -H 'Content-Type: application/json' | python3 -c "
import json, sys
d = json.load(sys.stdin)
action = d.get('action')
if action == 'deleted':
    print('DELETE ${slug}')
elif action == 'kept_response_received':
    print('KEEP ${slug} (reponse recue)')
"
done | while read -r verdict slug _; do
  if [ "$verdict" = "DELETE" ]; then
    rm -rf "${DEMOS_ROOT:?}/${slug:?}"
    echo "supprime: ${slug}"
  fi
done
