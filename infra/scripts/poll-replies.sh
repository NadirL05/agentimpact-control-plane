#!/usr/bin/env bash
# Poll Gmail pour les reponses recentes et les fait classer par l API.
#
# La classification (regex, deterministe) vit cote API : ce script ne fait
# que transporter les messages, il ne decide rien.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# newer_than:15m couvre large par rapport a l intervalle du cron (5 min) :
# une reponse jamais manquee vaut mieux qu un appel Gmail de moins.
#
# category:primary est deliberement ajoute (2026-08-15) : sans lui, chaque
# notif Pinterest/Facebook/Instagram/etc atterrissant en boite de reception
# etait classee (regex, pas cher en soi) PUIS postee sur #tous-agentimpact,
# ou deux bots avec free_response_channels sur ce canal (main + growth)
# declenchent un tour LLM complet a chaque message pour juger s ils doivent
# repondre. Le cout reel n est pas la classification, c est le bruit qui
# fait tourner ces bots pour rien. category:primary exclut Social/Promotions
# /Updates/Forums a la source, avant meme le premier appel API.
QUERY="in:inbox category:primary newer_than:15m"
ENCODED_QUERY="$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$QUERY")"

messages="$(
  "${SCRIPT_DIR}/cp-api.sh" hermes GET "/api/gmail/replies?q=${ENCODED_QUERY}"
)"

echo "$messages" | python3 -c "
import json, re, sys

data = json.load(sys.stdin)
for m in data.get('items', []):
    email_match = re.search(r'[\w.+-]+@[\w-]+\.[\w.-]+', m.get('from', ''))
    if not email_match:
        continue
    print(json.dumps({
        'gmail_message_id': m['id'],
        'from_address': email_match.group(0),
        'subject': m.get('subject', ''),
        'body': (m.get('bodyText') or m.get('snippet') or '')[:8000],
    }))
" | while read -r payload; do
  [ -z "$payload" ] && continue
  body_file=$(mktemp)
  printf '%s' "$payload" >"$body_file"
  "${SCRIPT_DIR}/cp-api.sh" hermes POST "/api/outreach/conversations/inbound" "$body_file" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('deduplicated'):
    pass
else:
    print('conversation classee:', d.get('classification'))
"
  rm -f "$body_file"
done
