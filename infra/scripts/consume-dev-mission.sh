#!/usr/bin/env bash
# Consomme UNE mission in_progress ciblant dev-senior et la fait executer par
# Hermes (profil agentimpact-dev), dans son terminal Docker sandboxe.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK=/tmp/agentimpact-dev-mission.lock
HERMES="/usr/local/lib/hermes-agent/venv/bin/python -m hermes_cli.main"

exec 9>"$LOCK"
flock -n 9 || { echo "deja en cours, skip"; exit 0; }

mission="$(
  "${SCRIPT_DIR}/cp-api.sh" hermes GET "/missions?target_agent=dev-senior&status=in_progress&limit=1"
)"

MISSION_ID="$(printf '%s' "$mission" | python3 -c "
import sys, json
items = [m for m in json.load(sys.stdin).get('items', []) if m.get('orchestration_version', 1) == 1]
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
- Travaille sur une branche dediee, jamais sur main.
- Ouvre une pull request en fin de travail. Ne la merge jamais toi-meme.
- Chaque changement de comportement doit venir avec un test qui le prouve.
- N'invente aucune donnee ni credential.
PROMPT
)"

OUTPUT="$(
  sudo -u hermes /opt/agentimpact/scripts/run-with-profile.sh agentimpact-dev \
    $HERMES -z "$PROMPT" 2>&1
)" || true

STATUS="failed"
printf '%s' "$OUTPUT" | grep -qE "github\.com/[^ ]+/pull/[0-9]+" && STATUS="completed"

RESULT_JSON="$(python3 -c "
import json, sys
print(json.dumps({'status': sys.argv[1], 'result': {'summary': sys.argv[2][:4000]}}))
" "$STATUS" "$OUTPUT")"

RESULT_FILE="$(mktemp)"
trap 'rm -f "$RESULT_FILE"' EXIT
printf '%s' "$RESULT_JSON" >"$RESULT_FILE"

"${SCRIPT_DIR}/cp-api.sh" hermes PATCH "/missions/${MISSION_ID}/result" "$RESULT_FILE" >/dev/null

echo "mission ${MISSION_ID}: ${STATUS}"
