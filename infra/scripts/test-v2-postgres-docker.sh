#!/usr/bin/env bash
# Native PostgreSQL 16 concurrency and complete migration-chain validation in
# a disposable, Unix-socket-only container. No production database is used.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_dir="$(mktemp -d /tmp/v2-a-pg-XXXXXXXX)"
container="agentimpact-v2-pg-test-$(basename "$test_dir" | tr '[:upper:]' '[:lower:]')"
mkdir "$test_dir/socket"
chmod 0755 "$test_dir"
chmod 0777 "$test_dir/socket"

cleanup() {
  sudo -n docker rm -f "$container" >/dev/null 2>&1 || true
  sudo -n find "$test_dir" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

sudo -n docker run -d --name "$container" \
  -e POSTGRES_USER=v2_test -e POSTGRES_HOST_AUTH_METHOD=trust -e PGPORT=55437 \
  -v "$test_dir/socket:/var/run/postgresql" \
  postgres:16-alpine \
  -c listen_addresses= -c unix_socket_permissions=0777 -c port=55437 >/dev/null

for _ in $(seq 1 60); do
  if sudo -n docker exec "$container" pg_isready -p 55437 -U v2_test -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! sudo -n docker exec "$container" pg_isready -p 55437 -U v2_test -d postgres >/dev/null; then
  sudo -n docker logs --tail 80 "$container" >&2 || true
  exit 1
fi

sudo -n docker exec "$container" createdb -p 55437 -U v2_test migration_chain
sudo -n docker exec "$container" psql -p 55437 -v ON_ERROR_STOP=1 -U v2_test -d migration_chain \
  -c 'CREATE ROLE agentimpact_codex_control NOLOGIN' >/dev/null
cat "$repo_dir/src/core/missions-v2/testing/schema.sql" \
  | sudo -n docker exec -i "$container" psql -p 55437 -v ON_ERROR_STOP=1 -U v2_test -d migration_chain >/dev/null
for migration in "$repo_dir"/src/migrations/[0-9][0-9][0-9]_*.sql; do
  cat "$migration" \
    | sudo -n docker exec -i "$container" psql -p 55437 -v ON_ERROR_STOP=1 -U v2_test -d migration_chain >/dev/null
done
sudo -n docker exec "$container" dropdb -p 55437 -U v2_test migration_chain
sudo -n docker exec "$container" psql -p 55437 -v ON_ERROR_STOP=1 -U v2_test -d postgres \
  -c 'DROP ROLE agentimpact_approval_validator; DROP ROLE agentimpact_codex_control' >/dev/null

sudo -n docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e V2_TEST_PG_SOCKET="$test_dir/socket" \
  -v "$repo_dir:$repo_dir" -v "$test_dir:$test_dir" \
  -w "$repo_dir/src" node:22-bookworm \
  node node_modules/vitest/vitest.mjs run \
    core/missions-v2/concurrency.test.ts \
    core/missions-v2/execution-concurrency.test.ts \
    core/missions-v2/predeploy-hardening.test.ts

echo 'POSTGRES_CONCURRENCY_TESTS=PASS'
echo 'MIGRATION_CHAIN_001_015=PASS'
