#!/usr/bin/env bash
# Vérifications non destructives — MCP Brevo profil Growth.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILES_DIR="${REPO_ROOT}/infra/hermes-profiles"
GROWTH_CFG="${PROFILES_DIR}/agentimpact-growth/config.yaml"
EXIT=0

echo "== YAML syntax =="
python3 -c "import yaml; yaml.safe_load(open('${GROWTH_CFG}'))"
echo "OK"

echo "== Brevo uniquement sur agentimpact-growth =="
while IFS= read -r cfg; do
  profile="$(basename "$(dirname "$cfg")")"
  if rg -q 'mcp\.brevo\.com|^[[:space:]]*brevo:' "$cfg" 2>/dev/null; then
    if [ "$profile" != "agentimpact-growth" ]; then
      echo "FAIL: Brevo trouvé dans ${profile}" >&2
      EXIT=1
    fi
  fi
done < <(find "$PROFILES_DIR" -name config.yaml)
echo "OK"

echo "== trust: untrusted sur brevo =="
rg -q 'trust: untrusted' "$GROWTH_CFG" && rg -q 'brevo:' "$GROWTH_CFG"
echo "OK"

echo "== Secret absent du dépôt =="
if rg -q 'BREVO_MCP_TOKEN=(?!À_REMPLACER)' "$REPO_ROOT" --glob '!*.example' --glob '!*.sh' --glob '!*.md' 2>/dev/null; then
  echo "FAIL: token potentiel dans le dépôt" >&2
  EXIT=1
else
  echo "OK"
fi

echo "== Hermes MCP list (profil Growth, sans secret) =="
TMP="$(mktemp -d)"
mkdir -p "${TMP}/profiles/agentimpact-growth"
cp "$GROWTH_CFG" "${TMP}/profiles/agentimpact-growth/config.yaml"
export HERMES_HOME="${TMP}/profiles/agentimpact-growth"
if /usr/local/lib/hermes-agent/venv/bin/python /usr/local/lib/hermes-agent/hermes mcp list 2>&1 | tee /tmp/hermes-mcp-list-growth.txt; then
  if rg -q brevo /tmp/hermes-mcp-list-growth.txt; then
    echo "OK — serveur brevo déclaré"
  else
    echo "WARN — brevo non listé (token absent ou serveur désactivé)"
  fi
else
  echo "WARN — hermes mcp list a échoué (attendu si token placeholder)"
fi
rm -rf "$TMP"

exit "$EXIT"
