#!/usr/bin/env bash
# Genere Nadir/État-Infra.md a partir de l'etat reel (API + OpenRouter),
# jamais d'un LLM : ce fichier est un miroir de donnees, pas une redaction.
# Tourne en cron (toutes les 2h) — voir infra/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT="/root/obsidian-vault/Nadir"
OUT="${VAULT}/État-Infra.md"
NOW_UTC="$(date -u +"%Y-%m-%d %H:%M UTC")"

AUTOPILOT="$("${SCRIPT_DIR}/cp-api.sh" hermes GET "/api/clients/autopilot")"
METRICS="$("${SCRIPT_DIR}/cp-api.sh" hermes GET "/api/clients/metrics?days=1")"

OPENROUTER_KEY="$(grep OPENROUTER_API_KEY /home/hermes/.hermes/.env | cut -d= -f2)"
CREDITS="$(curl --silent --show-error --max-time 10 -H "Authorization: Bearer ${OPENROUTER_KEY}" "https://openrouter.ai/api/v1/credits")"

python3 - "$NOW_UTC" "$AUTOPILOT" "$METRICS" "$CREDITS" "$OUT" <<'PYEOF'
import json, sys

now_utc, autopilot_raw, metrics_raw, credits_raw, out_path = sys.argv[1:6]

autopilot = json.loads(autopilot_raw)
metrics = json.loads(metrics_raw).get("metrics", {})
credits = json.loads(credits_raw).get("data", {})

remaining = credits.get("total_credits", 0) - credits.get("total_usage", 0)

lines = [
    "# État infra AgentImpact",
    "",
    f"> Généré automatiquement le {now_utc} — ne pas éditer à la main,",
    "> ce fichier est écrasé au prochain cron (toutes les 2h). Pour du",
    "> contexte durable, voir [[Projets/AgentImpact/Infra-Hermes]].",
    "",
    "## Budget OpenRouter",
    "",
    f"- Crédits restants : **{remaining:.2f}$** sur {credits.get('total_credits', '?')}$",
    "",
    "## Autopilote (growth → dev-senior)",
    "",
]

for item in autopilot.get("items", []):
    cb = item.get("circuit_breaker", {})
    state = "🔴 OUVERT (bloqué)" if cb.get("open") else "🟢 fermé (actif)"
    lines += [
        f"- **{item['name']}** : {state}",
        f"  - Échecs 24h : {cb.get('failures_24h', 0)}/{cb.get('max_failures_24h', '?')}",
        f"  - Refus 24h : {cb.get('rejections_24h', 0)}/{cb.get('max_rejections_24h', '?')}",
        f"  - Auto-approuvées aujourd'hui : {item.get('auto_approved_today', 0)}",
    ]

lines += ["", "## Volumes (dernières 24h)", ""]

actions = metrics.get("actions", {})
if actions:
    lines.append(
        f"- Actions : {actions.get('proposees', 0)} proposées, "
        f"{actions.get('approuvees', 0)} approuvées, "
        f"{actions.get('executees', 0)} exécutées, "
        f"{actions.get('echouees', 0)} échouées"
    )
else:
    lines.append("- Aucune donnée (fenêtre vide)")

with open(out_path, "w") as f:
    f.write("\n".join(lines) + "\n")
PYEOF

echo "Nadir/État-Infra.md régénéré : ${NOW_UTC}"
