#!/usr/bin/env bash
set -euo pipefail

release="${1:-}"
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] || { echo 'usage: rollback.sh RELEASE' >&2; exit 64; }
backup="/var/backups/agentimpact/releases/$release"
test -f "$backup/BACKUP_COMPLETE"
test -f "$backup/compose.yml"
test -f "$backup/superset-rpc-bridge.py"
test -f "$backup/gateway-inbox-consumer.py"
test -f "$backup/SHA256SUMS"
(cd "$backup" && sudo sha256sum -c SHA256SUMS >/dev/null)
sudo cat "$backup/agentimpact.pgdump" \
  | sudo docker exec -i agentimpact-db pg_restore --list >/dev/null

current_image="$(sudo docker image inspect agentimpact-control-plane:production --format '{{.Id}}')"
sudo docker tag "$current_image" "agentimpact-control-plane:pre-rollback-$release"
previous_image="$(sudo cat "$backup/previous-image-id")"
test -n "$previous_image"
sudo docker image inspect "$previous_image" >/dev/null

sudo install -m 0644 "$backup/compose.yml" /opt/agentimpact/compose.yml
sudo install -m 0600 "$backup/runtime.env" /opt/agentimpact/.env
if [ -f "$backup/operator.env" ]; then
  sudo install -m 0600 -o root -g root "$backup/operator.env" /etc/agentimpact/tokens/operator.env
elif [ -f "$backup/operator.env.absent" ] && [ -f /etc/agentimpact/tokens/operator.env ]; then
  sudo unlink /etc/agentimpact/tokens/operator.env
fi
if [ -f "$backup/planner.env" ]; then
  sudo install -m 0600 -o root -g root "$backup/planner.env" /etc/agentimpact/tokens/planner.env
elif [ -f "$backup/planner.env.absent" ] && [ -f /etc/agentimpact/tokens/planner.env ]; then
  sudo unlink /etc/agentimpact/tokens/planner.env
fi
sudo install -m 0644 "$backup/superset-rpc-bridge.py" /opt/agentimpact/superset-rpc/bridge.py
sudo tar -xzf "$backup/systemd-units.tar.gz" -C /etc/systemd/system
sudo systemctl daemon-reload
if [ -f "$backup/apparmor-agentimpact-codex" ]; then
  sudo install -m 0644 "$backup/apparmor-agentimpact-codex" /etc/apparmor.d/agentimpact-codex
  sudo apparmor_parser -r /etc/apparmor.d/agentimpact-codex
elif [ -f "$backup/apparmor-agentimpact-codex.absent" ]; then
  sudo apparmor_parser -R /etc/apparmor.d/agentimpact-codex 2>/dev/null || true
  if [ -e /etc/apparmor.d/agentimpact-codex ]; then sudo unlink /etc/apparmor.d/agentimpact-codex; fi
fi
if [ -f "$backup/infra-v2-health.sh" ]; then
  sudo install -m 0755 "$backup/infra-v2-health.sh" /opt/agentimpact/scripts/infra-v2-health.sh
fi
sudo install -m 0755 "$backup/gateway-inbox-consumer.py" /opt/agentimpact/scripts/gateway-inbox-consumer.py
sudo docker tag "$previous_image" agentimpact-control-plane:production
if [ -f "$backup/previous-app-src-target" ]; then
  previous_app_src="$(sudo cat "$backup/previous-app-src-target")"
  case "$previous_app_src" in
    /opt/agentimpact/releases/*/src) ;;
    *) echo 'rollback: unsafe previous app/src target' >&2; exit 2 ;;
  esac
  test -d "$previous_app_src"
  sudo ln -sfn "$previous_app_src" /opt/agentimpact/app/src
elif [ -L /opt/agentimpact/app/src ] && [ -d "/opt/agentimpact/app/src.legacy-$release" ]; then
  sudo unlink /opt/agentimpact/app/src
  sudo mv "/opt/agentimpact/app/src.legacy-$release" /opt/agentimpact/app/src
fi
previous_current="$(sudo cat "$backup/previous-current-target")"
if [ -n "$previous_current" ] && [ -d "$previous_current" ]; then
  sudo ln -sfn "$previous_current" /opt/agentimpact/current
else
  if [ -L /opt/agentimpact/current ]; then sudo unlink /opt/agentimpact/current; fi
fi
sudo systemctl restart agentimpact-superset-private.service agentimpact-superset-rpc.service
sudo docker compose -f /opt/agentimpact/compose.yml up -d --no-build --wait api db
sudo systemctl restart agentimpact-gateway-inbox-hermes.service
echo 'ROLLBACK=PASS'
