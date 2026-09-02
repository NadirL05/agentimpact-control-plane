#!/usr/bin/env bash
# Déploie l'intégration MCP Brevo pour le profil Hermes agentimpact-growth.
# Usage : sudo infra/scripts/deploy-brevo-mcp-growth.sh
#
# Ne lit ni n'affiche jamais le contenu des secrets.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GROWTH_SRC="${REPO_ROOT}/infra/hermes-profiles/agentimpact-growth"
CHIEF_SOUL_SRC="${REPO_ROOT}/infra/hermes-profiles/agentimpact-chief-of-staff/SOUL.md"
HERMES_GROWTH_HOME="/home/hermes/.hermes/profiles/agentimpact-growth"
HERMES_CHIEF_HOME="/home/hermes/.hermes/profiles/agentimpact-chief-of-staff"
SECRET_FILE="/etc/agentimpact/hermes-growth.env"
SYSTEMD_DROPIN="/etc/systemd/system/hermes-gateway-growth.service.d/10-brevo-env.conf"
TS="$(date +%Y%m%d%H%M%S)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Exécuter en root (sudo)." >&2
  exit 1
fi

if [ ! -f "${GROWTH_SRC}/config.yaml" ]; then
  echo "Config source introuvable: ${GROWTH_SRC}/config.yaml" >&2
  exit 1
fi

python3 -c "import yaml; yaml.safe_load(open('${GROWTH_SRC}/config.yaml'))"

mkdir -p /etc/agentimpact
mkdir -p "$(dirname "$SYSTEMD_DROPIN")"
mkdir -p "$HERMES_GROWTH_HOME"
mkdir -p "$HERMES_CHIEF_HOME"

if [ ! -f "$SECRET_FILE" ]; then
  install -m 600 -o hermes -g hermes \
    "${REPO_ROOT}/infra/templates/hermes-growth.env.example" \
    "$SECRET_FILE"
  echo "Créé ${SECRET_FILE} (placeholder — remplacer la valeur manuellement)."
else
  stat -c 'Secret existant: %a %U:%G %n' "$SECRET_FILE"
fi

if grep -q '^BREVO_MCP_TOKEN=À_REMPLACER_MANUELLEMENT$' "$SECRET_FILE" 2>/dev/null; then
  echo "ATTENTION: BREVO_MCP_TOKEN encore sur placeholder — MCP Brevo restera inactif."
  PLACEHOLDER=1
else
  PLACEHOLDER=0
fi

for dest in "$HERMES_GROWTH_HOME/config.yaml" "$HERMES_GROWTH_HOME/SOUL.md"; do
  base="$(basename "$dest")"
  if [ -f "$dest" ]; then
    cp -a "$dest" "${dest}.bak-${TS}"
  fi
  install -m 640 -o hermes -g hermes "${GROWTH_SRC}/${base}" "$dest"
done

if [ -f "$CHIEF_SOUL_SRC" ]; then
  if [ -f "${HERMES_CHIEF_HOME}/SOUL.md" ]; then
    cp -a "${HERMES_CHIEF_HOME}/SOUL.md" "${HERMES_CHIEF_HOME}/SOUL.md.bak-${TS}"
  fi
  install -m 640 -o hermes -g hermes "$CHIEF_SOUL_SRC" "${HERMES_CHIEF_HOME}/SOUL.md"
fi

install -m 644 "${REPO_ROOT}/infra/systemd/hermes-gateway-growth-brevo.env.conf" "$SYSTEMD_DROPIN"

systemctl daemon-reload

if [ "$PLACEHOLDER" -eq 0 ]; then
  systemctl restart hermes-gateway-growth.service
  echo "Redémarré hermes-gateway-growth.service"
else
  echo "Pas de redémarrage — token placeholder. Après mise à jour du secret :"
  echo "  sudo systemctl restart hermes-gateway-growth.service"
fi

echo "Déploiement terminé."
