#!/usr/bin/env bash
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
"$repo/infra/deploy/preflight.sh"
sha="$(git -C "$repo" rev-parse HEAD)"
release="${1:-}"
deploy_action_id="${2:-}"
deploy_payload_hash="${3:-}"
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] || { echo 'usage: deploy.sh RELEASE ACTION_ID PAYLOAD_HASH' >&2; exit 64; }
[[ "$deploy_action_id" =~ ^[0-9a-f-]{36}$ ]] || { echo 'deploy: invalid action id' >&2; exit 64; }
[[ "$deploy_payload_hash" =~ ^[0-9a-f]{64}$ ]] || { echo 'deploy: invalid payload hash' >&2; exit 64; }
test "${release##*-}" = "${sha:0:12}" || { echo 'deploy: release/source mismatch' >&2; exit 2; }
previous_current="$(sudo readlink -f /opt/agentimpact/current)"
rollback_release="$(basename "$previous_current")"
[[ "$rollback_release" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ ]] || { echo 'deploy: invalid rollback release' >&2; exit 2; }
origin_url="$(git -C "$repo" remote get-url origin)"
case "$origin_url" in
  https://github.com/*) deploy_repository="${origin_url#https://github.com/}" ;;
  git@github.com:*) deploy_repository="${origin_url#git@github.com:}" ;;
  *) echo 'deploy: canonical GitHub origin required' >&2; exit 2 ;;
esac
deploy_repository="${deploy_repository%.git}"
[[ "$deploy_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'deploy: invalid repository identity' >&2; exit 2; }
release_dir="/opt/agentimpact/releases/$release"
backup_dir="/var/backups/agentimpact/releases/$release"
test ! -e "$release_dir" || { echo "deploy: release already exists: $release" >&2; exit 2; }
test ! -e "$backup_dir" || { echo "deploy: backup already exists: $release" >&2; exit 2; }
mutated=0
rollback_on_error() {
  local status=$?
  trap - ERR
  if [ "$mutated" -eq 1 ]; then
    sudo "$release_dir/infra/deploy/rollback.sh" "$release" || true
    sudo docker exec -i agentimpact-db psql -v ON_ERROR_STOP=1 -U agentimpact_app -d agentimpact \
      -v action_id="$deploy_action_id" <<'SQL' >/dev/null || true
UPDATE agent_actions SET status='failed',executed_at=clock_timestamp(),error_message='deploy_failed_rolled_back'
 WHERE id=:'action_id'::uuid AND status='executing';
INSERT INTO agent_audit_events(action_id,event_type,actor,details)
 SELECT id,'failed','agentimpact-deployer','{"error":"deploy_failed_rolled_back"}'::jsonb
 FROM agent_actions WHERE id=:'action_id'::uuid AND status='failed';
SQL
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
sudo cp -a /opt/agentimpact/.env "$backup_dir/runtime.env"
if [ -f /etc/agentimpact/tokens/operator.env ]; then
  sudo cp -a /etc/agentimpact/tokens/operator.env "$backup_dir/operator.env"
else
  sudo install -m 0600 /dev/null "$backup_dir/operator.env.absent"
fi
if [ -f /etc/agentimpact/tokens/planner.env ]; then
  sudo cp -a /etc/agentimpact/tokens/planner.env "$backup_dir/planner.env"
else
  sudo install -m 0600 /dev/null "$backup_dir/planner.env.absent"
fi
sudo cp -a /opt/agentimpact/superset-rpc/bridge.py "$backup_dir/superset-rpc-bridge.py"
if [ -e /opt/agentimpact/scripts/infra-v2-health.sh ]; then
  sudo cp -a /opt/agentimpact/scripts/infra-v2-health.sh "$backup_dir/infra-v2-health.sh"
fi
sudo cp -a /opt/agentimpact/scripts/gateway-inbox-consumer.py "$backup_dir/gateway-inbox-consumer.py"
sudo readlink -f /opt/agentimpact/current \
  | sudo tee "$backup_dir/previous-current-target" >/dev/null || true
if [ -L /opt/agentimpact/app/src ]; then
  sudo readlink -f /opt/agentimpact/app/src \
    | sudo tee "$backup_dir/previous-app-src-target" >/dev/null
else
  sudo install -m 0600 /dev/null "$backup_dir/previous-app-src-was-directory"
fi
sudo tar --exclude=.git --exclude=node_modules --exclude=dist -C /opt/agentimpact/app \
  -czf "$backup_dir/deployed-source.tar.gz" src
sudo tar -C /etc/systemd/system -czf "$backup_dir/systemd-units.tar.gz" \
  agentimpact-superset-rpc.service agentimpact-superset-rpc.socket \
  agentimpact-superset-private.service agentimpact-superset-private.socket \
  agentimpact-gateway-inbox-hermes.service
if [ -f /etc/apparmor.d/agentimpact-codex ]; then
  sudo cp -a /etc/apparmor.d/agentimpact-codex "$backup_dir/apparmor-agentimpact-codex"
else
  sudo install -m 0600 /dev/null "$backup_dir/apparmor-agentimpact-codex.absent"
fi
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

# Consume one exact, unexpired production approval before the first live
# mutation. The deployment action is bound to this source, release, rollback,
# and an already executed Publisher action for the same immutable commit.
claimed="$(sudo docker exec -i agentimpact-db psql -At -v ON_ERROR_STOP=1 -U agentimpact_app -d agentimpact \
  -v action_id="$deploy_action_id" -v payload_hash="$deploy_payload_hash" \
  -v release_id="$release" -v source_commit="$sha" -v rollback_release_id="$rollback_release" \
  -v repository="$deploy_repository" <<'SQL'
WITH eligible AS (
  SELECT a.id,a.payload_hash
    FROM agent_actions a
   WHERE a.id=:'action_id'::uuid
     AND a.profile='agentimpact-deployer' AND a.intent='deploy_release'
     AND a.status='approved' AND a.payload_hash=:'payload_hash'
     AND a.approval_expires_at>clock_timestamp()
     AND a.payload->>'release_id'=:'release_id'
     AND a.payload->>'source_commit'=:'source_commit'
     AND a.payload->>'target'='production'
     AND a.payload->>'rollback_release_id'=:'rollback_release_id'
     AND a.payload->>'repository'=:'repository'
     AND a.payload->>'base_branch' IN ('main','master')
     AND EXISTS (SELECT 1 FROM agent_approvals p WHERE p.action_id=a.id
       AND p.payload_hash=a.payload_hash AND p.decision='approved'
       AND p.expires_at>clock_timestamp())
     AND EXISTS (SELECT 1 FROM agent_actions published
       WHERE published.id::text=a.payload->>'publisher_action_id'
         AND published.profile='agentimpact-publisher'
         AND published.intent='publisher_publish' AND published.status='executed'
         AND published.payload->>'head_sha'=:'source_commit'
         AND published.payload->>'repository'=:'repository'
         AND published.payload->>'base_branch'=a.payload->>'base_branch'
         AND jsonb_typeof(published.payload->'pull_request_number')='number')
   FOR UPDATE
), consumed AS (
  UPDATE agent_actions a SET status='executing'
    FROM eligible e WHERE a.id=e.id AND a.status='approved'
  RETURNING a.id,a.payload_hash
), audited AS (
  INSERT INTO agent_audit_events(action_id,event_type,actor,details)
  SELECT id,'executing','agentimpact-deployer',jsonb_build_object('payload_hash',payload_hash,'release_id',:'release_id')
    FROM consumed RETURNING action_id
)
SELECT count(*) FROM audited;
SQL
)"
test "$claimed" = 1 || { echo 'deploy: exact approval, Publisher evidence, or expiry check failed' >&2; exit 77; }

# Additive, idempotent migration required by the durable OpenJarvis replay
# boundary. Older releases ignore the table/columns, so application rollback
# remains safe and the database dump is retained for explicit data recovery.
mutated=1
sudo docker exec -i agentimpact-db psql -v ON_ERROR_STOP=1 -U agentimpact_app -d agentimpact \
  < "$release_dir/src/migrations/016_openjarvis_operator_security.sql" >/dev/null
sudo install -m 0600 /dev/null "$backup_dir/MIGRATION_016_APPLIED"
sudo docker exec -i agentimpact-db psql -v ON_ERROR_STOP=1 -U agentimpact_app -d agentimpact \
  < "$release_dir/src/migrations/017_v2_inbox_lifecycle.sql" >/dev/null
sudo install -m 0600 /dev/null "$backup_dir/MIGRATION_017_APPLIED"

# Dedicated revocable OpenJarvis identity. Generate once; it is intentionally
# distinct from Hermes/admin/bridge and never printed or passed in argv.
if [ ! -f /etc/agentimpact/tokens/operator.env ]; then
  operator_token_file="$(mktemp)"
  chmod 0600 "$operator_token_file"
  openssl rand -hex 32 | sed 's/^/CTL_OPERATOR_TOKEN=/' >"$operator_token_file"
  sudo install -m 0600 -o root -g root "$operator_token_file" /etc/agentimpact/tokens/operator.env
  rm -f "$operator_token_file"
fi
if [ ! -f /etc/agentimpact/tokens/planner.env ]; then
  planner_token_file="$(mktemp)"
  chmod 0600 "$planner_token_file"
  openssl rand -hex 32 | sed 's/^/CTL_PLANNER_TOKEN=/' >"$planner_token_file"
  sudo install -m 0600 -o root -g root "$planner_token_file" /etc/agentimpact/tokens/planner.env
  rm -f "$planner_token_file"
fi

operator_bind_ip="$(ip -4 -o addr show dev wg0 | awk '{split($4,a,"/");print a[1];exit}')"
[[ "$operator_bind_ip" =~ ^10[.] ]] || { echo 'deploy: private WireGuard IPv4 required' >&2; exit 2; }
if sudo grep -q '^AGENTIMPACT_OPERATOR_BIND_IP=' /opt/agentimpact/.env; then
  sudo sed -i "s/^AGENTIMPACT_OPERATOR_BIND_IP=.*/AGENTIMPACT_OPERATOR_BIND_IP=$operator_bind_ip/" /opt/agentimpact/.env
else
  printf 'AGENTIMPACT_OPERATOR_BIND_IP=%s\n' "$operator_bind_ip" | sudo tee -a /opt/agentimpact/.env >/dev/null
fi
sudo chmod 0600 /opt/agentimpact/.env

sudo docker build --label "org.agentimpact.source=$sha" --label "org.agentimpact.release=$release" \
  -t "agentimpact-control-plane:$release" "$release_dir/src"
sudo docker tag "agentimpact-control-plane:$release" agentimpact-control-plane:production

sudo install -m 0644 "$release_dir/infra/compose.yml" /opt/agentimpact/compose.yml
sudo install -m 0644 "$release_dir/infra/superset-rpc/bridge.py" /opt/agentimpact/superset-rpc/bridge.py
sudo install -m 0755 "$release_dir/infra/scripts/gateway-inbox-consumer.py" /opt/agentimpact/scripts/gateway-inbox-consumer.py
for unit in agentimpact-superset-rpc.service agentimpact-superset-rpc.socket \
  agentimpact-superset-private.service agentimpact-superset-private.socket \
  agentimpact-gateway-inbox-hermes.service; do
  sudo install -m 0644 "$release_dir/infra/systemd/$unit" "/etc/systemd/system/$unit"
done
sudo install -m 0644 "$release_dir/infra/apparmor/agentimpact-codex" /etc/apparmor.d/agentimpact-codex
sudo apparmor_parser -r /etc/apparmor.d/agentimpact-codex
sudo systemctl daemon-reload
sudo ln -sfn "$release_dir" /opt/agentimpact/current
if [ ! -L /opt/agentimpact/app/src ]; then
  sudo mv /opt/agentimpact/app/src "/opt/agentimpact/app/src.legacy-$release"
fi
sudo ln -sfn "$release_dir/src" /opt/agentimpact/app/src

sudo systemctl restart agentimpact-superset-private.service agentimpact-superset-rpc.service
sudo docker compose -f /opt/agentimpact/compose.yml up -d --no-build --wait api db
sudo systemctl restart agentimpact-gateway-inbox-hermes.service
sudo install -m 0755 "$release_dir/infra/deploy/health.sh" /opt/agentimpact/scripts/infra-v2-health.sh

sudo /opt/agentimpact/scripts/infra-v2-health.sh
sudo sh -c "cd '$backup_dir' && sha256sum -c SHA256SUMS >/dev/null"
sudo install -m 0600 /dev/null "$backup_dir/DEPLOYED"
sudo docker exec -i agentimpact-db psql -v ON_ERROR_STOP=1 -U agentimpact_app -d agentimpact \
  -v action_id="$deploy_action_id" -v release_id="$release" <<'SQL' >/dev/null
UPDATE agent_actions SET status='executed',executed_at=clock_timestamp(),error_message=NULL,
       execution_claimed_at=coalesce(execution_claimed_at,clock_timestamp()),execution_claimed_by='agentimpact-deployer'
 WHERE id=:'action_id'::uuid AND status='executing';
INSERT INTO agent_audit_events(action_id,event_type,actor,details)
 SELECT id,'executed','agentimpact-deployer',jsonb_build_object('release_id',:'release_id')
 FROM agent_actions WHERE id=:'action_id'::uuid AND status='executed';
SQL
trap - ERR
printf 'RELEASE=%s\nBACKUP=%s\nDEPLOYMENT=PASS\n' "$release" "$backup_dir"
