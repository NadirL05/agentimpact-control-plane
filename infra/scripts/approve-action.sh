#!/usr/bin/env bash
# Enregistre une decision humaine sur une action agent, via le control plane.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat >&2 <<'USAGE'
Usage:
  approve-action.sh <action_id> approve|reject <approbateur> [raison]
  approve-action.sh --pending
USAGE
  exit 64
}

[ $# -ge 1 ] || usage

if [ "$1" = '--pending' ]; then
  "${SCRIPT_DIR}/cp-api.sh" hermes GET '/api/approvals/pending'
  echo
  exit 0
fi

[ $# -ge 3 ] || usage

ACTION_ID="$1"
VERB="$2"
APPROVER="$3"
REASON="${4:-}"

case "$VERB" in
  approve) DECISION=approved ;;
  reject) DECISION=rejected ;;
  *) usage ;;
esac

if ! [[ "$ACTION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo '{"error":"invalid_action_uuid"}' >&2
  exit 65
fi

PAYLOAD_HASH="$(
  "${SCRIPT_DIR}/cp-api.sh" hermes GET '/api/approvals/pending' |
    python3 -c "
import json, sys
action_id = sys.argv[1]
data = json.load(sys.stdin)
for item in data.get('items', []):
    if item['id'] == action_id:
        print(item['payload_hash'])
        break
" "$ACTION_ID"
)"

if [ -z "$PAYLOAD_HASH" ]; then
  echo '{"error":"action_not_pending"}' >&2
  exit 66
fi

body="$(
  python3 -c "
import json, sys
action_id, decision, approver, payload_hash, reason = sys.argv[1:6]
payload = {
    'action_id': action_id,
    'decision': decision,
    'approver': approver,
    'payload_hash': payload_hash,
}
if reason:
    payload['reason'] = reason
print(json.dumps(payload))
" "$ACTION_ID" "$DECISION" "$APPROVER" "$PAYLOAD_HASH" "$REASON"
)"

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
printf '%s' "$body" >"$BODY_FILE"

response="$(
  CP_API_STATUS=1 "${SCRIPT_DIR}/cp-api.sh" hermes POST '/api/approvals' "$BODY_FILE"
)"

printf '%s\n' "$(printf '%s' "$response" | sed '$d')"
status="$(printf '%s' "$response" | tail -n1)"
[ "${status:0:1}" = '2' ] || exit 1
