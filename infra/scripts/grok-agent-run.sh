#!/usr/bin/env bash
# Wrapper d'exécution Cursor Agent pour le routeur Slack.
# - Lit le prompt depuis un fichier éphémère (0600), le supprime avant exec.
# - CURSOR_API_KEY injectée par le parent via l'environnement (LoadCredential systemd).
# - Le prompt transite en argument positionnel `[prompt...]` (documenté par `agent --help`).
#   Limitation : visible brièvement dans /proc/<pid>/cmdline jusqu'à fin du processus.
set -euo pipefail

PROMPT_FILE="${1:?prompt file required}"
AGENT_BIN="${GROK_AGENT_BIN:-/var/lib/cursor-grok-worker/.local/bin/agent}"
MODEL="${GROK_AGENT_MODEL:-cursor-grok-4.6-medium}"
WORKSPACE="${GROK_AGENT_WORKSPACE:-/opt/agentimpact/grokbot/workspace}"

if [[ ! -r "$PROMPT_FILE" ]]; then
  echo "grok-agent-run: prompt file unreadable" >&2
  exit 2
fi

PROMPT="$(cat "$PROMPT_FILE")"
rm -f "$PROMPT_FILE"

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "grok-agent-run: CURSOR_API_KEY unset" >&2
  exit 2
fi

exec timeout "${GROK_AGENT_TIMEOUT_SEC:-300}" \
  "$AGENT_BIN" \
  -p \
  --output-format json \
  --model "$MODEL" \
  --mode ask \
  --single-turn \
  --trust \
  --workspace "$WORKSPACE" \
  "$PROMPT"
