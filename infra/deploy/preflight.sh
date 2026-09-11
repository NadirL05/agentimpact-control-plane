#!/usr/bin/env bash
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
test "$(git -C "$repo" rev-parse --is-inside-work-tree)" = true
test -z "$(git -C "$repo" status --porcelain)" || { echo 'preflight: working tree must be clean' >&2; exit 2; }
test -f "$repo/src/api/server.ts"
test -f "$repo/src/core/missions-v2/jarvis/agent-start.ts"
test -f "$repo/src/core/missions-v2/jarvis/agent-quota.ts"
test -f "$repo/src/core/missions-v2/superset/backend.ts"
test -f "$repo/src/core/missions-v2/superset/rpc-client.ts"
test -f "$repo/infra/superset-rpc/bridge.py"
test -f "$repo/infra/compose.yml"
test -x /usr/bin/bwrap || { echo 'preflight: bubblewrap package required for Codex sandbox' >&2; exit 2; }
sudo -n apparmor_parser -p "$repo/infra/apparmor/agentimpact-codex" >/dev/null

sudo -n docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$repo:$repo" -w "$repo/src" node:22-bookworm sh -eu -c \
  'npm ci >/dev/null; npm run build; npm run lint; npm test; npm audit'

python3 -m py_compile "$repo/infra/superset-rpc/bridge.py"
while IFS= read -r test_file; do
  python3 "$test_file" -q
done < <(find "$repo/infra" -type f -name 'test_*.py' -not -path '*/test-fixtures/*' | sort)
"$repo/infra/scripts/test-v2-postgres-docker.sh"
sudo -n docker compose -f "$repo/infra/compose.yml" --env-file "$repo/infra/test-fixtures/compose.config.env.example" config --quiet
sudo -n docker build --label "org.agentimpact.source=$(git -C "$repo" rev-parse HEAD)" \
  -t "agentimpact-control-plane:preflight-$(git -C "$repo" rev-parse --short=12 HEAD)" "$repo/src"
echo 'PRE_BUILD_GUARDS=PASS'
