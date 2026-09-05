#!/usr/bin/env bash
# Private disposable PostgreSQL cluster; no production socket, TCP or credentials.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pg_bin="${V2_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
[[ -x "$pg_bin/initdb" && -x "$pg_bin/pg_ctl" ]] || { echo 'PostgreSQL 16 test binaries required'; exit 1; }
test_dir="$(mktemp -d /tmp/v2-a-pg-XXXXXXXX)"
chmod 700 "$test_dir"
mkdir "$test_dir/socket"
cleanup() {
  "$pg_bin/pg_ctl" -D "$test_dir/data" -m immediate stop > /dev/null 2>&1 || true
  rm -rf -- "$test_dir"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$test_dir/data" --auth=trust --username=v2_test > "$test_dir/init.log"
"$pg_bin/pg_ctl" -D "$test_dir/data" -l "$test_dir/server.log" -o "-h '' -k $test_dir/socket -p 55437" -w start > /dev/null
cd "$repo_dir/src"
V2_TEST_PG_SOCKET="$test_dir/socket" node node_modules/vitest/vitest.mjs run core/missions-v2/concurrency.test.ts core/missions-v2/execution-concurrency.test.ts
