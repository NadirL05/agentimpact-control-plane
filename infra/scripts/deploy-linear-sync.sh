#!/usr/bin/env bash
# Install the reviewed Linear mission mirror on the AgentImpact VPS.
# Run from a root terminal. Restarts only the Linear sync service.
set -Eeuo pipefail
umask 077

if [[ $(id -u) -ne 0 ]]; then
  echo 'Ouvrir un terminal root (ou utiliser sudo) avant de lancer ce script.' >&2
  exit 1
fi

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
revision=$(git -c safe.directory="$repo_root" -C "$repo_root" rev-parse HEAD)
build_dir="/var/tmp/agentimpact-linear-sync-${revision:0:12}"
app=/opt/agentimpact/app
credential=/etc/agentimpact/credentials/linear-api-key
compose=(docker compose --env-file /opt/agentimpact/.env -f /opt/agentimpact/compose.yml)

for path in \
  /opt/agentimpact/compose.yml /opt/agentimpact/.env \
  "$app/package.json" "$app/src/tsconfig.json" \
  /etc/agentimpact/slack-router.env \
  /etc/agentimpact/credentials/slack-router-bot-token \
  /etc/agentimpact/credentials/slack-router-db-password; do
  if [[ ! -f "$path" ]]; then
    echo "Prérequis absent : $path" >&2
    exit 1
  fi
done
if [[ ! -d "$app/node_modules/pg" ]]; then
  echo 'Dépendance runtime pg absente sous /opt/agentimpact/app/node_modules.' >&2
  exit 1
fi
if [[ -L "$credential" || ( -e "$credential" && ! -f "$credential" ) ]]; then
  echo 'Fichier de clé Linear non régulier : arrêt.' >&2
  exit 1
fi

if [[ ! -s "$credential" ]]; then
  if [[ ! -t 0 ]]; then
    echo 'Un terminal interactif est nécessaire pour saisir la clé Linear.' >&2
    exit 1
  fi
  read -r -s -p 'Colle la clé API Linear (saisie masquée) : ' linear_api_key
  printf '\n'
  if [[ -z "$linear_api_key" ]]; then
    echo 'Clé vide : arrêt.' >&2
    exit 1
  fi
  install -d -o root -g root -m 0700 /etc/agentimpact/credentials
  printf '%s' "$linear_api_key" > "$credential"
  unset linear_api_key
fi
chown root:root "$credential"
chmod 0600 "$credential"

echo "Construction du commit ${revision:0:12} dans $build_dir"
install -d -o hermes -g hermes -m 0755 "$build_dir"
git -c safe.directory="$repo_root" -C "$repo_root" archive "$revision" | tar -x -C "$build_dir"
chown -R hermes:hermes "$build_dir"
runuser -u hermes -- bash -c 'cd "$1/src" && npm ci --ignore-scripts && npm run build' _ "$build_dir"

for name in core linear-client store sync daemon; do
  test -f "$build_dir/src/dist/linear-sync/$name.js"
done
test -f "$build_dir/src/dist/core/read-secret-env.js"

install -d -o root -g root -m 0700 /var/backups/agentimpact
backup="/var/backups/agentimpact/pre-linear-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump"
echo "Sauvegarde PostgreSQL : $backup"
"${compose[@]}" exec -T db pg_dump -U agentimpact_app -d agentimpact -Fc > "$backup"
test -s "$backup"
"${compose[@]}" exec -T db pg_restore -l < "$backup" > /dev/null

# Keep the host source tree able to rebuild the service in a later release.
install -d -o hermes -g hermes -m 0755 "$app/src/linear-sync"
rsync -a --chown=hermes:hermes "$build_dir/src/linear-sync/" "$app/src/linear-sync/"
install -o hermes -g hermes -m 0644 \
  "$build_dir/src/migrations/010_linear_mission_sync.sql" \
  "$app/src/migrations/010_linear_mission_sync.sql"

if ! grep -Fq 'linear-sync/**/*.ts' "$app/src/tsconfig.json"; then
  cp -p "$app/src/tsconfig.json" "/var/backups/agentimpact/tsconfig-pre-linear-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
  python3 - "$app/src/tsconfig.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
config = json.loads(path.read_text())
includes = config.setdefault('include', [])
if 'linear-sync/**/*.ts' not in includes:
    includes.append('linear-sync/**/*.ts')
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
PY
fi

install -d -o hermes -g hermes -m 0755 "$app/dist/linear-sync"
for name in core linear-client store sync daemon; do
  install -o hermes -g hermes -m 0644 \
    "$build_dir/src/dist/linear-sync/$name.js" "$app/dist/linear-sync/$name.js"
done
if [[ ! -f "$app/dist/core/read-secret-env.js" ]]; then
  install -d -o hermes -g hermes -m 0755 "$app/dist/core"
  install -o hermes -g hermes -m 0644 \
    "$build_dir/src/dist/core/read-secret-env.js" "$app/dist/core/read-secret-env.js"
fi

"${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U agentimpact_app -d agentimpact \
  < "$build_dir/src/migrations/010_linear_mission_sync.sql"

install -o root -g root -m 0640 \
  "$build_dir/infra/templates/linear-sync.env.example" /etc/agentimpact/linear-sync.env
install -o root -g root -m 0644 \
  "$build_dir/infra/systemd/agentimpact-linear-sync.service" \
  /etc/systemd/system/agentimpact-linear-sync.service
systemd-analyze verify /etc/systemd/system/agentimpact-linear-sync.service
systemctl daemon-reload
systemctl enable agentimpact-linear-sync.service
systemctl restart agentimpact-linear-sync.service
systemctl is-active --quiet agentimpact-linear-sync.service

# A fixed INPUT_ERROR should be retried immediately instead of waiting for backoff.
"${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U agentimpact_app -d agentimpact \
  -c "UPDATE linear_mission_links SET retry_after=now(),updated_at=now() WHERE error_code='graphql_INPUT_ERROR' AND retry_after>now();"

echo 'Service Linear actif. Vérifier ensuite les tickets et le lien dans un fil Slack.'
echo "Sauvegarde conservée : $backup"
