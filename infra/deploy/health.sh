#!/usr/bin/env bash
set -euo pipefail

root=/opt/agentimpact/current
fail=0
check() { if "$@" >/dev/null 2>&1; then printf 'PASS %s\n' "$*"; else printf 'FAIL %s\n' "$*"; fail=$((fail + 1)); fi; }
equal() { local expected="$1" actual="$2" label="$3"; if [ "$actual" = "$expected" ]; then echo "PASS $label"; else echo "FAIL $label expected=$expected actual=$actual"; fail=$((fail + 1)); fi; }

equal healthy "$(docker inspect -f '{{.State.Health.Status}}' agentimpact-api 2>/dev/null || true)" 'agentimpact-api healthy'
equal healthy "$(docker inspect -f '{{.State.Health.Status}}' agentimpact-db 2>/dev/null || true)" 'agentimpact-db healthy'
for unit in agentimpact-ctl-bridge.service agentimpact-gateway-inbox-ana.service \
  agentimpact-gateway-inbox-hermes.service agentimpact-slack-router.service \
  agentimpact-superset-host.service agentimpact-superset-rpc.service \
  agentimpact-superset-private.service hermes-dashboard.service \
  hermes-gateway.service hermes-gateway-growth.service \
  hermes-gateway-memoire.service; do
  check systemctl is-active --quiet "$unit"
done

check "$root/infra/scripts/cp-api.sh" bridge GET /health
operator="$(AGENTIMPACT_OPERATOR_API_URL=http://127.0.0.1:3000 \
  AGENTIMPACT_OPERATOR_TOKEN_FILE=/etc/agentimpact/tokens/operator.env \
  python3 - "$root/integrations/openjarvis/agentimpact_mcp.py" <<'PY'
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('agentimpact_mcp',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(json.dumps(module.call_agentimpact('agentimpact.health',{})))
PY
)"
if printf '%s' "$operator" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["data"]["control_plane"]=="ok"' 2>/dev/null; then
  echo 'PASS OpenJarvis signed operator API'
else
  echo 'FAIL OpenJarvis signed operator API'; fail=$((fail + 1))
fi
if [ "$(CP_API_STATUS=1 "$root/infra/scripts/cp-api.sh" operator GET /missions | tail -n 1)" = 403 ]; then
  echo 'PASS operator scope isolation'
else
  echo 'FAIL operator scope isolation'; fail=$((fail + 1))
fi
check python3 -m py_compile /opt/agentimpact/superset-rpc/bridge.py
check docker exec agentimpact-api test -r /secrets/google_token.json

body="$(mktemp)"
trap 'unlink "$body"' EXIT
python3 - "$body" <<'PY'
import json,sys,uuid
with open(sys.argv[1], 'w', encoding='utf-8') as f:
    json.dump({'request_id':str(uuid.uuid4()),'organization_id':'org-agentimpact','message':'status'},f)
PY
jarvis="$($root/infra/scripts/cp-api.sh hermes POST /api/v2/jarvis/actions "$body" 2>/dev/null || true)"
if printf '%s' "$jarvis" | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d["results"][0]; h=r["data"]["health"]; assert r["ok"] and (h.get("ok") or h.get("running"))' 2>/dev/null; then
  echo 'PASS Jarvis typed status'
else
  echo 'FAIL Jarvis typed status'; fail=$((fail + 1))
fi

api_user="$(docker inspect -f '{{.Config.User}}' agentimpact-api)"
equal node "$api_user" 'API unprivileged user'
mounts="$(docker inspect -f '{{range .Mounts}}{{println .Source " -> " .Destination}}{{end}}' agentimpact-api)"
case "$mounts" in *docker.sock*|*executor.sock*|*credstore*) echo 'FAIL forbidden API mount'; fail=$((fail + 1));; *) echo 'PASS API mount boundary';; esac
operator_bind_ip="$(ip -4 -o addr show dev wg0 2>/dev/null | awk '{split($4,a,"/");print a[1];exit}')"
case "$(ss -lntH 'sport = :3443' 2>/dev/null)" in
  *"$operator_bind_ip:3443"*) [[ "$operator_bind_ip" =~ ^10[.] ]] && echo 'PASS operator WireGuard listener' || { echo 'FAIL operator WireGuard listener'; fail=$((fail + 1)); };;
  *) echo 'FAIL operator WireGuard listener'; fail=$((fail + 1));;
esac

printf 'HEALTH_FAILURES=%d\n' "$fail"
test "$fail" -eq 0
