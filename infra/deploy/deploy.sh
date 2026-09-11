#!/usr/bin/env bash
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
"$repo/infra/deploy/preflight.sh"
sha="$(git -C "$repo" rev-parse HEAD)"
release="$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}"
release_dir="/opt/agentimpact/releases/$release"
backup_dir="/var/backups/agentimpact/releases/$release"
mutated=0
rollback_on_error() {
  local status=$?
  trap - ERR
  if [ "$mutated" -eq 1 ]; then
    sudo "$release_dir/infra/deploy/rollback.sh" "$release" || true
  fi
  exit "$status"
}
trap rollback_on_error ERR

sudo install -d -m 0750 -o root -g root "$release_dir" "$backup_dir"
git -C "$repo" archive --format=tar HEAD | sudo tar -xf - -C "$release_dir"
sudo chown -R root:root "$release_dir"
sudo chmod -R go-w "$release_dir"

# Complete rollback snapshot before any live mutation.
sudo cp -a /opt/agentimpact/compose.yml "$backup_dir/compose.yml"
sudo cp -a /opt/agentimpact/superset-rpc/bridge.py "$backup_dir/superset-rpc-bridge.py"
if [ -e /opt/agentimpact/scripts/infra-v2-health.sh ]; then
  sudo cp -a /opt/agentimpact/scripts/infra-v2-health.sh "$backup_dir/infra-v2-health.sh"
fi
sudo readlink -f /opt/agentimpact/current \
  | sudo tee "$backup_dir/previous-current-target" >/dev/null || true
sudo tar --exclude=.git --exclude=node_modules --exclude=dist -C /opt/agentimpact/app \
  -czf "$backup_dir/deployed-source.tar.gz" src
sudo tar -C /etc/systemd/system -czf "$backup_dir/systemd-units.tar.gz" \
  agentimpact-superset-rpc.service agentimpact-superset-rpc.socket \
  agentimpact-superset-private.service agentimpact-superset-private.socket
sudo docker inspect agentimpact-api --format '{{.Image}}' \
  >"/tmp/agentimpact-previous-image-$release"
sudo install -m 0600 "/tmp/agentimpact-previous-image-$release" "$backup_dir/previous-image-id"
rm -f "/tmp/agentimpact-previous-image-$release"
sudo docker exec agentimpact-db pg_dump -U agentimpact_app -d agentimpact -Fc \
  | sudo tee "$backup_dir/agentimpact.pgdump" >/dev/null
sudo cat "$backup_dir/agentimpact.pgdump" \
  | sudo docker exec -i agentimpact-db pg_restore --list >/dev/null
sudo sh -c "cd '$backup_dir' && find . -maxdepth 1 -type f ! -name SHA256SUMS -print0 \
  | sort -z | xargs -0 sha256sum > SHA256SUMS"
sudo find "$backup_dir" -maxdepth 1 -type f -exec chmod 0600 {} +
sudo install -m 0600 /dev/null "$backup_dir/BACKUP_COMPLETE"

sudo docker build --label "org.agentimpact.source=$sha" --label "org.agentimpact.release=$release" \
  -t "agentimpact-control-plane:$release" "$release_dir/src"
mutated=1
sudo docker tag "agentimpact-control-plane:$release" agentimpact-control-plane:production

sudo install -m 0644 "$release_dir/infra/compose.yml" /opt/agentimpact/compose.yml
sudo install -m 0644 "$release_dir/infra/superset-rpc/bridge.py" /opt/agentimpact/superset-rpc/bridge.py
for unit in agentimpact-superset-rpc.service agentimpact-superset-rpc.socket \
  agentimpact-superset-private.service agentimpact-superset-private.socket; do
  sudo install -m 0644 "$release_dir/infra/systemd/$unit" "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo ln -sfn "$release_dir" /opt/agentimpact/current
if [ ! -L /opt/agentimpact/app/src ]; then
  sudo mv /opt/agentimpact/app/src "/opt/agentimpact/app/src.legacy-$release"
fi
sudo ln -sfn "$release_dir/src" /opt/agentimpact/app/src

sudo systemctl restart agentimpact-superset-private.service agentimpact-superset-rpc.service
sudo docker compose -f /opt/agentimpact/compose.yml up -d --no-build --wait api db
sudo install -m 0755 "$release_dir/infra/deploy/health.sh" /opt/agentimpact/scripts/infra-v2-health.sh

sudo /opt/agentimpact/scripts/infra-v2-health.sh
sudo sh -c "cd '$backup_dir' && sha256sum -c SHA256SUMS >/dev/null"
sudo install -m 0600 /dev/null "$backup_dir/DEPLOYED"
trap - ERR
printf 'RELEASE=%s\nBACKUP=%s\nDEPLOYMENT=PASS\n' "$release" "$backup_dir"
